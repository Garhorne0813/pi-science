import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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

export interface DigestSource { title: string; url: string; provider: string; id?: string; authors?: string[]; year?: number; venue?: string; doi?: string }
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
    // Baseline for the incremental comparison: the newest previous manifest.
    // The file this run is about to write is excluded by name (daily
    // semantics: a same-day earlier run is not the baseline). Read before
    // prompting so the agent knows what changed since the last run.
    const previous = await readLatestPreviousManifest(outputDirectory, `${dateStamp(this.now())}.manifest.json`, runId);
    const previousSources = previous?.sources ?? [];

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
      let response = await promptAndWait(digestPrompt(query, providers, instructions, buildPreviousRunNote(previous)));
      let digest = parseDigestResponse(response);
      if (!digest) {
        await ctx.log(`[scheduled-task ${runId}] response was not strict JSON; asking the agent to repair it`);
        response = await promptAndWait("Your previous response did not return valid JSON. Return ONLY valid JSON — no markdown code fences, no explanation — with exactly this shape: {\"markdown\": \"...\", \"sources\": [{\"title\": \"...\", \"url\": \"...\", \"provider\": \"...\", \"id\": \"...\", \"authors\": [\"...\"], \"year\": 2024, \"venue\": \"...\", \"doi\": \"...\"}]}. The fields after provider are optional; keep the metadata from the search results when available.");
        digest = parseDigestResponse(response);
      }
      if (!digest) throw new Error("scheduled task agent returned invalid JSON after one repair attempt");
      await ctx.log(`[scheduled-task ${runId}] ${buildDeltaNote(previousSources, digest.sources, previous === null)}`);
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
 *  fabricate identifiers, must carry the gateway records' metadata
 *  (id/authors/year/venue/doi) back into the digest, and must answer in
 *  strict JSON only. The optional deltaNote describes the previous run
 *  (baseline on the first run) so the report can mark this run's new
 *  sources. */
export function digestPrompt(query: string, providers: string[], instructions?: string, deltaNote?: string): string {
  const port = process.env.PI_SCIENCE_PORT || String(GATEWAY_DEFAULT_PORT);
  const providerLine = providers.length ? `\n- 只用这些来源库（providers）：${providers.join(", ")}。` : "";
  const instructionLine = instructions ? `\n- 额外要求：${instructions}` : "";
  const deltaSection = deltaNote
    ? `\n# 上次运行对比
${deltaNote}
- 在「检索说明」中填写本次新增篇数；对本次新增文献，在「来源清单」对应行末尾加（本次新增）标记。`
    : "";
  return `你是一个定时文献综述 agent。请为查询「${query}」生成一篇中文文献综述日报。

# 检索要求
1. 优先使用 literature-review 技能。首选路径：调用本机控制平面文献网关 POST http://127.0.0.1:${port}/api/literature/search，请求体 {"query": "<检索词>", "providers": ["pubmed", "arxiv", ...]}。网关返回 {"blocked": false, "results": [...]}；若返回 {"blocked": true, "categories": [...]}（敏感查询被拦截），不要绕行，直接说明被拦截。网关不可达时，按技能说明的零配置 fallback 用 curl 直连 Crossref（api.crossref.org）、arXiv（export.arxiv.org）、PubMed（eutils.ncbi.nlm.nih.gov）公开 API。${providerLine}
2. 严格只使用本次检索真实返回的记录：绝不编造 DOI、PMID、arXiv id、标题、链接、作者或期刊名。每一条来源都必须能在检索结果中找到。
3. 完整保留网关返回的每条 record 元数据：id（PMID/arXiv id/DOI/accession）、authors、year、venue（期刊/库名）、doi。网关 record 字段名即 id/title/authors/year/venue/doi/url/provider，直接照搬。fallback 直连时从响应中提取可得字段：arXiv Atom 的 <name>（作者）与 <published>（年份）、Crossref 的 author/issued/container-title、PubMed esummary 的 authors/pubdate/source/articleids。字段缺失用 — 表示，不编造。
4. 报告正文（执行摘要 + 分主题综述 + 关键文献评估）约 600-1200 字（中文）；检索说明与来源清单不计入字数。${instructionLine}
${deltaSection}
# 报告模板（严格按此结构输出 Markdown；YYYY-MM-DD 用今天的日期）
# <主题> 文献综述日报（YYYY-MM-DD）
## 检索说明
| 项 | 值 |
|---|---|
| 检索词 | ... |
| 数据源 | PubMed / arXiv / Crossref ... |
| 检索时间 | ... |
| 命中 | N 条 |
| 去重后 | N 条 |
| 本次新增 | N 篇 |
## 执行摘要
3-5 句话概括最重要的发现：谁、发现了什么、有何意义。
## 分主题综述
### <主题一>
正文 2-4 句，指出关键研究及其方法/结论，用引用编号 [1][2] 标注（编号对应「来源清单」）。
### <主题二>
正文 2-4 句。
（归纳 2-4 个主题小节，按文献实际内容归纳，不编造主题）
## 关键文献评估
| 编号 | 文献 | 类型（RCT/队列/综述/预印本等，信息可得时） | 证据要点 | 局限 |
|---|---|---|---|---|
## 来源清单
[n] 作者1, 作者2, et al. 标题. 期刊/库, 年份. DOI: xxx / PMID: xxx. 链接
（按编号排列；字段缺失用 —）
## 局限与说明
（检索窗口、语言、覆盖范围、无法访问全文等）

# 学术语言规范
- 区分「研究发现」与「作者观点/作者提出」。
- 不夸大结论：不说「证明」，说「提示/表明」。
- 信息可得时给出研究类型（RCT/队列/综述/预印本）与样本特征。
- 避免空洞套话和营销化措辞。

# 输出
只返回严格 JSON（不要用 markdown 代码块包裹，不要任何额外文字或解释）：
{"markdown": "...", "sources": [{"title": "...", "url": "...", "provider": "...", "id": "...", "authors": ["..."], "year": 2024, "venue": "...", "doi": "..."}]}
provider 取值：pubmed / arxiv / crossref / genbank / pubchem / uniprot。`;
}

export function parseDigestResponse(value: string): DigestResult | null {
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
    const digestSource: DigestSource = { title: source.title, url: source.url, provider: source.provider };
    if (typeof source.id === "string" && source.id) digestSource.id = source.id;
    if (typeof source.doi === "string" && source.doi) digestSource.doi = source.doi;
    if (typeof source.venue === "string" && source.venue) digestSource.venue = source.venue;
    if (typeof source.year === "number" && Number.isFinite(source.year)) digestSource.year = source.year;
    if (Array.isArray(source.authors)) {
      const authors = source.authors.filter((author): author is string => typeof author === "string" && author.length > 0);
      if (authors.length > 0) digestSource.authors = authors;
    }
    sources.push(digestSource);
  }
  return { markdown: record.markdown, sources };
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

export interface PreviousRunManifest { executedAt: string; sources: DigestSource[] }

/** Reads the newest previous run manifest from the output directory. The
 *  manifest this run is about to write is excluded by name (daily semantics:
 *  a same-day earlier run is not the baseline), and anything carrying this
 *  run's id is ignored defensively. Unreadable or malformed files are
 *  skipped. */
export async function readLatestPreviousManifest(outputDirectory: string, currentManifestName: string, runId: string): Promise<PreviousRunManifest | null> {
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch(() => [] as Dirent[]);
  let latest: PreviousRunManifest | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".manifest.json") || entry.name === currentManifestName) continue;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(join(outputDirectory, entry.name), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (manifest.run_id === runId || typeof manifest.executed_at !== "string" || !Array.isArray(manifest.sources)) continue;
    const sources = (manifest.sources as unknown[]).filter(isUsableSource) as DigestSource[];
    if (latest === null || manifest.executed_at > latest.executedAt) latest = { executedAt: manifest.executed_at, sources };
  }
  return latest;
}

function isUsableSource(value: unknown): value is DigestSource {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (typeof record.title === "string" && record.title.length > 0) || (typeof record.url === "string" && record.url.length > 0);
}

/** Stable comparison key for a source across runs: DOI when present, else
 *  the provider id, else the url (doi/id lowercased; urls kept verbatim). */
function sourceStableKey(source: DigestSource): string {
  return source.doi?.toLowerCase() || source.id?.toLowerCase() || source.url;
}

/** Sources in currentSources whose stable key did not appear in
 *  previousSources. Used for the incremental comparison between runs. */
export function computeNewSources(previousSources: DigestSource[], currentSources: DigestSource[]): DigestSource[] {
  const seen = new Set(previousSources.map(sourceStableKey));
  return currentSources.filter((source) => !seen.has(sourceStableKey(source)));
}

/** Human delta note for the run log: baseline message on the first run,
 *  otherwise the count plus up to five titles of the new sources. */
export function buildDeltaNote(previousSources: DigestSource[], currentSources: DigestSource[], isFirstRun: boolean): string {
  if (isFirstRun) return `本次为首次运行，建立基线，全部 ${currentSources.length} 篇视为新增`;
  const newSources = computeNewSources(previousSources, currentSources);
  if (newSources.length === 0) return "与上次运行相比无新增文献";
  const titles = newSources.slice(0, 5).map((source) => source.title).join("、");
  return `新增 ${newSources.length} 篇：${titles}${newSources.length > 5 ? " 等" : ""}`;
}

/** Comparison note embedded in the prompt: describes the previous run's
 *  baseline so the agent can identify and mark this run's new sources. */
function buildPreviousRunNote(previous: PreviousRunManifest | null): string {
  if (previous === null) return "本次为首次运行，建立基线：本次检索到的文献全部视为新增";
  const titles = previous.sources.slice(0, 5).map((source) => source.title).join("、");
  return `上次运行（${previous.executedAt.slice(0, 10)}）共收录 ${previous.sources.length} 篇：${titles}${previous.sources.length > 5 ? " 等" : ""}`;
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
