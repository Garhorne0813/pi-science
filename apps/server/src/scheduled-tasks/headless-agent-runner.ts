import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ScheduledTask } from "@pi-science/contracts";
import { metadataRoot, writeJsonAtomic } from "../storage/persistence.js";
import { PiManager, piManager } from "../runtime/pi/pi-manager.js";
import type { PiEvent, PiProcessOptions, PiResult } from "../runtime/pi/pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../runtime/pi/pi-runtime-launch.js";
import type { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { resolveWorkspaceFile } from "../security/workspace-security.js";
import type { ScheduledTaskExecutor } from "./executors.js";

/** Structural surface of a Pi process the runner drives. PiProcess itself has
 *  private members and a private constructor, so tests stub this narrow
 *  contract instead of the concrete class. */
export interface HeadlessAgentProcess {
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  sendCommand(type: string, params?: Record<string, unknown>): Promise<PiResult>;
}

export interface HeadlessAgentManager {
  start(key: string, options: PiProcessOptions): Promise<HeadlessAgentProcess>;
  stop(key: string): Promise<void>;
}

export interface DigestSource { title: string; url: string; provider: string }
export interface DigestResult { markdown: string; sources: DigestSource[] }

const PROMPT_TIMEOUT_MS = 10 * 60_000;
const GATEWAY_DEFAULT_PORT = 8787;
const MAX_RESPONSE_BYTES = 2_000_000;

interface HeadlessAgentExecutorOptions {
  environments: Pick<WorkspaceEnvironmentService, "environment">;
  manager?: HeadlessAgentManager;
  now?: () => Date;
}

/** Runs a scheduled literature_digest task as a headless Pi agent: prompt the
 *  agent to search (literature gateway first, direct provider APIs as the
 *  skill's fallback), collect the strict-JSON digest, and write the report
 *  plus manifest from the control plane. The agent never writes the
 *  workspace; it only returns data. */
export class HeadlessAgentExecutor implements ScheduledTaskExecutor {
  private readonly manager: HeadlessAgentManager;
  private readonly now: () => Date;

  constructor(private readonly options: HeadlessAgentExecutorOptions) {
    this.manager = options.manager ?? piManager;
    this.now = options.now ?? (() => new Date());
  }

  async run(task: ScheduledTask, runId: string, ctx: { cwd: string; log: (line: string) => Promise<void> }): Promise<{ output_paths: string[]; usage: { model_tokens: number; cost_usd: number } }> {
    if (task.executor.kind !== "headless_agent") throw new Error(`unsupported executor kind for scheduled task ${task.task_id}: ${task.executor.kind}`);
    const { query, providers, instructions } = parseConfig(task);
    // Canonical root: resolveWorkspaceFile returns realpath'd paths, so the
    // workspace-relative output list must be computed against the same root
    // (a symlinked prefix such as /var -> /private/var would otherwise leak
    // absolute paths into the run record).
    const cwd = await realpath(resolve(ctx.cwd));
    // Session dir lives under workspace metadata; creating it also ensures the
    // .pi-science marker validateWorkspaceCwd relies on.
    const sessionDir = join(metadataRoot(cwd), "scheduled-task-sessions", runId);
    await mkdir(sessionDir, { recursive: true });
    // Fail fast on an escaping output path before any agent tokens are spent.
    const outputDirectory = await resolveWorkspaceFile(cwd, task.output.relative_path);
    await mkdir(outputDirectory, { recursive: true });

    await ctx.log(`[scheduled-task ${runId}] query: ${query}${providers.length ? ` providers: ${providers.join(",")}` : ""}`);
    const options = buildPiProcessOptions(cwd, loadDefaultPiConfig(), undefined, await this.options.environments.environment(cwd));
    if (!options) throw new Error("Pi CLI is not configured");
    const sessionArg = options.args.indexOf("--session-dir");
    if (sessionArg >= 0) options.args[sessionArg + 1] = sessionDir;
    if (options.web) options.web.runtime.sessionDir = sessionDir;
    options.requestTimeoutMs = 30_000;

    const managerKey = `scheduled-task:${runId}`;
    await ctx.log(`[scheduled-task ${runId}] starting headless agent`);
    const process = await this.manager.start(managerKey, options);
    const usage = { model_tokens: 0, cost_usd: 0 };
    let text = "";
    let settle: (() => void) | null = null;
    let rejectCycle: ((error: Error) => void) | null = null;
    process.on("event", (event: PiEvent) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
        const type = String(update?.type ?? "");
        if (["text_delta", "text"].includes(type)) {
          text += String(update?.delta ?? update?.text ?? update?.content ?? "");
          if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) rejectCycle?.(new Error("scheduled task agent response exceeds 2 MB"));
        }
      }
      if (event.type === "message_end") {
        const message = event.message as Record<string, unknown> | undefined;
        const item = message?.usage as Record<string, unknown> | undefined;
        // Accumulated on the run itself so a failure still reports what it spent.
        usage.model_tokens += Number(item?.input ?? 0) + Number(item?.output ?? 0);
        usage.cost_usd += Number((item?.cost as Record<string, unknown> | undefined)?.total ?? 0);
      }
      if (event.type === "agent_settled") settle?.();
    });
    process.once("exit", () => rejectCycle?.(new Error("scheduled task agent exited before completing")));

    const promptAndWait = async (message: string): Promise<string> => {
      text = "";
      const completed = new Promise<void>((resolvePrompt, rejectPrompt) => {
        const timeout = setTimeout(() => rejectPrompt(new Error("scheduled task agent timed out")), PROMPT_TIMEOUT_MS);
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          settle = null;
          rejectCycle = null;
          error ? rejectPrompt(error) : resolvePrompt();
        };
        settle = () => finish();
        rejectCycle = (error) => finish(error);
      });
      const acknowledged = await process.sendCommand("prompt", { message });
      if (!acknowledged.success) {
        rejectCycle?.(new Error(String(acknowledged.error ?? "scheduled task agent rejected prompt")));
      }
      await completed;
      return text;
    };

    try {
      const state = await process.sendCommand("get_state");
      if (!state.success) throw new Error(String(state.error ?? "unable to initialize scheduled task agent"));
      await ctx.log(`[scheduled-task ${runId}] agent ready; submitting prompt`);
      let response = await promptAndWait(digestPrompt(query, providers, instructions));
      let digest = parseDigestResponse(response);
      if (!digest) {
        await ctx.log(`[scheduled-task ${runId}] response was not strict JSON; asking the agent to repair it`);
        response = await promptAndWait("Your previous response did not return valid JSON. Return ONLY valid JSON — no markdown code fences, no explanation — with exactly this shape: {\"markdown\": \"...\", \"sources\": [{\"title\": \"...\", \"url\": \"...\", \"provider\": \"...\"}]}.");
        digest = parseDigestResponse(response);
      }
      if (!digest) throw new Error("scheduled task agent returned invalid JSON after one repair attempt");
      await ctx.log(`[scheduled-task ${runId}] agent returned ${digest.sources.length} sources; writing outputs`);
      const outputPaths = await this.writeOutputs(task, runId, query, providers, digest, outputDirectory, cwd, ctx);
      return { output_paths: outputPaths, usage };
    } finally {
      process.removeAllListeners("event");
      process.removeAllListeners("exit");
      await this.manager.stop(managerKey).catch(() => undefined);
    }
  }

  /** Writes the markdown report and the sources manifest from the control
   *  plane (the agent only returns data). Daily semantics: the run overwrites
   *  the day's file unless the existing file was modified outside the task
   *  (content hash differs from the last manifest), in which case a
   *  timestamped copy is written instead. */
  private async writeOutputs(
    task: ScheduledTask,
    runId: string,
    query: string,
    providers: string[],
    digest: DigestResult,
    outputDirectory: string,
    cwd: string,
    ctx: { log: (line: string) => Promise<void> },
  ): Promise<string[]> {
    const executedAt = this.now();
    const stamp = dateStamp(executedAt);
    const dailyName = `${stamp}.md`;
    const manifestName = `${stamp}.manifest.json`;
    const dailyPath = join(outputDirectory, dailyName);
    const manifestPath = join(outputDirectory, manifestName);

    let reportName = dailyName;
    const existing = await readFile(dailyPath, "utf8").catch(() => null);
    if (existing !== null) {
      const recordedHash = await readManifestHash(manifestPath, dailyName);
      const currentHash = sha256Hex(existing);
      if (recordedHash !== currentHash) {
        reportName = `${stamp}-${timeStamp(executedAt)}.md`;
        await ctx.log(`[scheduled-task ${runId}] conflict: ${dailyName} was modified outside this task; writing ${reportName} instead`);
      }
    }

    const reportPath = join(outputDirectory, reportName);
    const content = `${digest.markdown.trim()}\n`;
    await writeFile(reportPath, content, "utf8");
    const manifest = {
      task_id: task.task_id,
      run_id: runId,
      query,
      providers,
      executed_at: executedAt.toISOString(),
      sources: digest.sources,
      dedup_keys: [...new Set(digest.sources.map((source) => source.url.toLowerCase()))],
      output_files: [{ path: reportName, sha256: sha256Hex(content) }],
    };
    await writeJsonAtomic(manifestPath, manifest);
    await ctx.log(`[scheduled-task ${runId}] wrote ${reportName} and ${manifestName} (${digest.sources.length} sources)`);
    return [relative(cwd, reportPath), relative(cwd, manifestPath)];
  }
}

function parseConfig(task: ScheduledTask): { query: string; providers: string[]; instructions?: string } {
  const config = task.executor.config as Record<string, unknown>;
  const query = typeof config.query === "string" ? config.query.trim() : "";
  if (!query) throw new Error(`scheduled task ${task.task_id} requires a non-empty executor.config.query`);
  const providers = Array.isArray(config.providers) ? config.providers.map(String).filter(Boolean) : [];
  const instructions = typeof config.instructions === "string" && config.instructions.trim() ? config.instructions.trim() : undefined;
  return { query, providers, instructions };
}

/** Literature-digest agent prompt. The agent must prefer the control-plane
 *  literature gateway (which adds caching, rate limiting, egress audit and
 *  the sensitive-term gate) and fall back to the skill's direct Crossref /
 *  arXiv / PubMed calls only when the gateway is unreachable; it must never
 *  fabricate identifiers and must answer in strict JSON only. */
function digestPrompt(query: string, providers: string[], instructions?: string): string {
  const port = process.env.PI_SCIENCE_PORT || String(GATEWAY_DEFAULT_PORT);
  const providerLine = providers.length ? `\n- 只用这些来源库（providers）：${providers.join(", ")}。` : "";
  const instructionLine = instructions ? `\n- 额外要求：${instructions}` : "";
  return `你是一个定时文献综述 agent。请为查询「${query}」生成一篇中文文献综述日报。

检索要求：
1. 优先使用 literature-review 技能。首选路径：调用本机控制平面文献网关 POST http://127.0.0.1:${port}/api/literature/search，请求体 {"query": "<检索词>", "providers": ["pubmed", "arxiv", ...]}。网关返回 {"blocked": false, "results": [...]}；若返回 {"blocked": true, "categories": [...]}（敏感查询被拦截），不要绕行，直接说明被拦截。网关不可达时，按技能说明的零配置 fallback 用 curl 直连 Crossref（api.crossref.org）、arXiv（export.arxiv.org）、PubMed（eutils.ncbi.nlm.nih.gov）公开 API。${providerLine}
2. 严格只使用本次检索真实返回的记录：绝不编造 DOI、PMID、arXiv id、标题、链接或作者。每一条来源都必须能在检索结果中找到。
3. 输出 300–600 字（中文）的 Markdown 综述；末尾附「来源」清单，每篇一行：标题、链接、来源库。${instructionLine}
4. 只返回严格 JSON（不要用 markdown 代码块包裹，不要任何额外文字或解释）：
{"markdown": "...", "sources": [{"title": "...", "url": "...", "provider": "..."}]}
provider 取值：pubmed / arxiv / crossref / genbank / pubchem / uniprot。`;
}

function parseDigestResponse(value: string): DigestResult | null {
  const trimmed = stripCodeFence(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.markdown !== "string" || !record.markdown.trim()) return null;
  if (!Array.isArray(record.sources)) return null;
  const sources: DigestSource[] = [];
  for (const item of record.sources) {
    if (typeof item !== "object" || item === null) return null;
    const source = item as Record<string, unknown>;
    if (typeof source.title !== "string" || typeof source.url !== "string" || typeof source.provider !== "string") return null;
    sources.push({ title: source.title, url: source.url, provider: source.provider });
  }
  return { markdown: record.markdown, sources };
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

async function readManifestHash(manifestPath: string, reportName: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { output_files?: unknown };
    if (!Array.isArray(manifest.output_files)) return null;
    for (const entry of manifest.output_files) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item.path === reportName && typeof item.sha256 === "string") return item.sha256;
    }
    return null;
  } catch { return null; }
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timeStamp(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
