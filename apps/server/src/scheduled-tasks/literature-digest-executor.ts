// LiteratureDigestExecutor (docs §9.1–§9.11): the only allowed scheduled
// literature chain — fresh sensitive-term detection → durable approval
// coverage + scope-hash pin → single-use LiteratureService token → search →
// Node-side stable sort/dedup/delta → PiJsonRunner summarization of given
// records only → source-index validation → immutable report/sources/run
// output → Execution.finish + provenance. Deps are minimal structural
// interfaces so this module never imports HTTP routes or provider internals.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { detectSensitiveTerms } from "../security/sensitive-terms.js";
import type { ExecutionRepository } from "../runtime/executions/execution-repository.js";
import { approvalCoversCategories, computeApprovalScopeHash } from "./approval.js";
import { buildLiteratureDigestPrompt } from "./literature-digest-prompt.js";
import { ensureAttemptOutputDir, isSafeRelativeOutputPath, resolveInside, writeImmutableFile } from "./immutable-output.js";
import type { PiJsonRunner } from "./pi-json-runner.js";
import type { ExecutorContext, ExecutorResult, ScheduledTaskExecutor } from "./executor.js";
import type { ScheduledTaskSnapshot } from "./types.js";

// --- minimal structural dep types (mirror literature/types.ts without importing it) ---

let cachedAppVersion: string | null | undefined;
/** Application version for run.json provenance (§9.10); null when unreadable. */
function appVersion(): string | null {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedAppVersion = String((require("../../package.json") as { version?: string }).version ?? null);
  } catch {
    cachedAppVersion = null;
  }
  return cachedAppVersion;
}

export interface DigestProviderRecord {
  id: string;
  provider: string;
  title: string;
  url: string;
  doi?: string;
  abstract?: string;
  extra?: Record<string, unknown>;
}

export interface DigestProviderResult {
  provider: string;
  records: DigestProviderRecord[];
  responseHash: string;
}

export interface DigestProviderFailure {
  provider: string;
  error: string;
}

export type DigestSearchOutcome =
  | { blocked: true; categories: readonly string[]; terms?: readonly string[] }
  | { blocked: false; results: DigestProviderResult[]; failures: readonly DigestProviderFailure[] };

export interface LiteratureDigestExecutorDeps {
  /** Shared control-plane gateway (docs §9.2); approve() mints a single-use short-lived token. */
  literature: {
    approve(query: string, categories: readonly string[]): Promise<{ approvedToken: string }>;
    search(query: string, options?: { providers?: readonly string[]; approvedToken?: string }): Promise<DigestSearchOutcome>;
  };
  pi: PiJsonRunner;
  executions?: Pick<ExecutionRepository, "start" | "finish">;
  provenance?: { record(cwd: string, entry: Record<string, unknown>): Promise<unknown> };
  now?: () => number;
  /** Previous successful Attempt's stable keys (docs §9.8). Null/throwing ⇒ baseline_unavailable. Production wiring lands in Phase 6. */
  loadPreviousStableKeys?: () => Promise<string[] | null>;
}

/** Classified executor failure; `retryable` feeds the dispatcher backoff decision (docs §9.6). */
class ClassifiedError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message: string) {
    super(message);
    this.name = "ClassifiedDigestError";
  }
}

interface SelectedRecord {
  source_index: number;
  stable_key: string;
  isNew: boolean;
  record: DigestProviderRecord;
  responseHash: string;
}

interface WrittenFile {
  path: string;
  sha256: string;
}

export class LiteratureDigestExecutor implements ScheduledTaskExecutor {
  readonly kind = "literature_digest" as const;

  constructor(private readonly deps: LiteratureDigestExecutorDeps) {}

  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    const nowMs = (): number => this.deps.now?.() ?? ctx.now();
    const startedAtMs = nowMs();
    const snapshot = ctx.run.snapshot;
    const config = snapshot.executor.config;
    const attemptDirRelative = [snapshot.output.relative_root, snapshot.task_id, ctx.run.business_date, ctx.run.run_id, ctx.attempt.attempt_id].join("/");
    const scopeHash = computeApprovalScopeHash(snapshot.executor, snapshot.output.relative_root);
    const providerFailures: Array<{ provider: string; error: string }> = [];
    const writtenFiles: WrittenFile[] = [];

    // Execution evidence opens before ANY egress; idempotent per docs §9.11.
    await this.startExecution(ctx);

    try {
      if (ctx.signal.aborted) throw new ClassifiedError("ABORTED", false, "execution aborted before completion");

      // (a) fresh detection + durable approval coverage + scope hash pin (docs §9.3–§9.4).
      // Both gates fire BEFORE any network call: nothing leaves the machine on mismatch.
      const detection = detectSensitiveTerms(config.query);
      if (detection.matched && !approvalCoversCategories(snapshot.approval.categories, detection.categories)) {
        throw new ClassifiedError("APPROVAL_SCOPE_INVALID", false, `fresh sensitive-term detection found categories not covered by the task approval: ${detection.categories.join(",")}`);
      }
      if (snapshot.approval.scope_hash !== scopeHash) {
        throw new ClassifiedError("APPROVAL_SCOPE_INVALID", false, "approval scope hash does not match the claim-time snapshot");
      }
      if (!isSafeRelativeOutputPath(attemptDirRelative)) {
        throw new ClassifiedError("OUTPUT_ROOT_FORBIDDEN", false, `output root is not allowed: ${snapshot.output.relative_root}`);
      }

      const attemptDir = await ensureAttemptOutputDir(resolveInside(resolve(ctx.cwd), attemptDirRelative));

      // (b) egress only through the shared gateway, with a single-use approval token.
      let approvedToken: string | undefined;
      if (detection.matched) approvedToken = (await this.deps.literature.approve(config.query, detection.categories)).approvedToken;
      const outcome = await this.deps.literature.search(config.query, { providers: config.providers, approvedToken });
      if (ctx.signal.aborted) throw new ClassifiedError("ABORTED", false, "execution aborted during retrieval");

      // (c) outcome classification: blocked / total provider failure / partial failure / valid emptiness.
      if (outcome.blocked) throw new ClassifiedError("APPROVAL_REQUIRED", false, `literature gateway blocked the query (${outcome.categories.join(",")}) despite the task approval`);
      providerFailures.push(...outcome.failures.map((failure) => ({ provider: failure.provider, error: failure.error })));
      const selected = selectRecords(outcome.results, config.max_results);
      if (providerFailures.length > 0 && selected.length === 0) {
        throw new ClassifiedError("PROVIDER_UNAVAILABLE", true, `all requested providers failed: ${providerFailures.map((failure) => `${failure.provider}(${failure.error})`).join("; ")}`);
      }

      // (e) deterministic delta against the previous successful Attempt (docs §9.8).
      const previousKeys = await this.loadBaseline();
      applyDelta(selected, previousKeys);

      // sources.json publishes right after retrieval so evidence survives a Pi failure (docs §9.10).
      const sourcesContent = renderSourcesJson({ snapshot, run: ctx.run, attempt: ctx.attempt, config, selected, providerFailures, generatedAt: new Date(startedAtMs).toISOString(), baselineKeys: previousKeys });
      await this.publish(ctx, attemptDirRelative, attemptDir, "sources.json", sourcesContent, writtenFiles);
      if (ctx.signal.aborted) throw new ClassifiedError("ABORTED", false, "execution aborted before summarization");

      // (f) Pi summarizes exactly these records; runner owns parse repair, executor owns index validation.
      const prompt = buildLiteratureDigestPrompt({
        query: config.query,
        instructions: config.instructions,
        language: config.language,
        records: selected.map((entry) => ({
          source_index: entry.source_index,
          title: entry.record.title,
          doi: entry.record.doi,
          url: entry.record.url,
          provider: entry.record.provider,
          abstract: extractAbstract(entry.record),
        })),
        newRecordIndices: selected.filter((entry) => entry.isNew).map((entry) => entry.source_index),
      });
      const budgetRemainingMs = Math.max(1_000, snapshot.budget.max_wall_time_seconds * 1000 - (nowMs() - startedAtMs));
      const piResult = await this.deps.pi.run(ctx.cwd, { managerKey: ctx.attempt.attempt_id, systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt, timeoutMs: budgetRemainingMs, signal: ctx.signal });
      const digest = validateDigest(piResult.parsed, selected.length);
      const usage = { model_tokens: Math.round(piResult.usage.model_tokens), cost_usd: piResult.usage.cost_usd };

      // (g) render and publish the remaining immutable artifacts.
      const reportContent = renderReport({ name: snapshot.name, businessDate: ctx.run.business_date, language: config.language, digest, selected, providerFailures, baselineUnavailable: previousKeys === null });
      await this.publish(ctx, attemptDirRelative, attemptDir, "report.md", reportContent, writtenFiles);

      const newCount = selected.filter((entry) => entry.isNew).length;
      const runManifest = renderRunJson(ctx, scopeHash, providerFailures, usage, {
        source_count: selected.length,
        new_count: newCount,
        theme_count: digest.themes.length,
        important_count: digest.important_records.length,
      }, { started_at: new Date(startedAtMs).toISOString(), ended_at: new Date(nowMs()).toISOString() }, Object.fromEntries(writtenFiles.map((file) => [basenameOf(file.path), file.sha256])), appVersion());
      await this.publish(ctx, attemptDirRelative, attemptDir, "run.json", runManifest, writtenFiles);

      // (h) terminal execution evidence.
      await this.finishExecution(ctx, "succeeded", writtenFiles, usage, { source_count: selected.length, new_count: newCount, provider_failure_count: providerFailures.length }, null, nowMs());

      // (i)
      return { status: "succeeded", outputPaths: writtenFiles.map((file) => resolve(ctx.cwd, file.path)), usage };
    } catch (error) {
      return await this.fail(ctx, error instanceof Error ? error : new Error(String(error)), { attemptDirRelative, scopeHash, providerFailures, writtenFiles, startedAtMs, nowMs });
    }
  }

  // --- helpers -----------------------------------------------------------------

  private async startExecution(ctx: ExecutorContext): Promise<void> {
    const snapshot = ctx.run.snapshot;
    await this.deps.executions?.start(ctx.cwd, {
      execution_id: ctx.attempt.execution_id,
      kind: "scheduled_task",
      surface: "pi",
      producer: "scheduled-task-service",
      correlation: {
        scheduled_task_id: snapshot.task_id,
        scheduled_task_run_id: ctx.run.run_id,
        scheduled_task_attempt_id: ctx.attempt.attempt_id,
        run_id: ctx.run.run_id,
      },
      request: {
        executor_kind: snapshot.executor.kind,
        scheduled_for: ctx.run.scheduled_for,
        business_date: ctx.run.business_date,
        task_revision: snapshot.revision,
        snapshot_sha256: ctx.run.snapshot_sha256,
      },
    }).catch((error) => ctx.log(`execution start failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async finishExecution(
    ctx: ExecutorContext,
    status: "succeeded" | "failed" | "cancelled",
    files: readonly WrittenFile[],
    usage: { model_tokens: number; cost_usd: number },
    resultCounts: { source_count: number; new_count: number; provider_failure_count: number },
    errorCode: string | null,
    endedAtMs: number,
  ): Promise<void> {
    await this.deps.executions?.finish(ctx.cwd, ctx.attempt.execution_id, {
      status,
      producer: "scheduled-task-service",
      ended_at: new Date(endedAtMs).toISOString(),
      result: { ...resultCounts, error_code: errorCode },
      files: { written: files.map((file) => ({ path: file.path, sha256: file.sha256, detection: "explicit" })) },
      usage: { model_tokens: usage.model_tokens, cost_usd: usage.cost_usd },
    }).catch((error) => ctx.log(`execution finish failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async recordProvenance(ctx: ExecutorContext, relativePath: string, sha: string, bytes: number): Promise<void> {
    await this.deps.provenance?.record(ctx.cwd, {
      kind: "scheduled_task_output",
      execution_id: ctx.attempt.execution_id,
      scheduled_task_id: ctx.run.snapshot.task_id,
      run_id: ctx.run.run_id,
      attempt_id: ctx.attempt.attempt_id,
      path: relativePath,
      sha256: sha,
      bytes,
    }).catch(() => undefined);
  }

  /** Publish one immutable artifact under the attempt directory and book its evidence. */
  private async publish(ctx: ExecutorContext, attemptDirRelative: string, attemptDir: string, name: string, content: string, writtenFiles: WrittenFile[]): Promise<void> {
    await writeImmutableFile(attemptDir, name, content);
    const sha = sha256(content);
    await this.recordProvenance(ctx, `${attemptDirRelative}/${name}`, sha, Buffer.byteLength(content, "utf8"));
    writtenFiles.push({ path: `${attemptDirRelative}/${name}`, sha256: sha });
  }

  private async loadBaseline(): Promise<string[] | null> {
    if (!this.deps.loadPreviousStableKeys) return null;
    try {
      const loaded = await this.deps.loadPreviousStableKeys();
      return Array.isArray(loaded) ? [...new Set(loaded)] : null;
    } catch {
      // Unreadable or tampered baseline ⇒ baseline_unavailable; every record counts as new (docs §9.8).
      return null;
    }
  }

  /** Failure path: best-effort immutable run.json (every terminal Attempt keeps at least that,
   * docs §9.10), execution finish with mapped status, then the classified ExecutorResult. */
  private async fail(
    ctx: ExecutorContext,
    error: Error,
    info: {
      attemptDirRelative: string;
      scopeHash: string;
      providerFailures: Array<{ provider: string; error: string }>;
      writtenFiles: WrittenFile[];
      startedAtMs: number;
      nowMs: () => number;
    },
  ): Promise<ExecutorResult> {
    const aborted = ctx.signal.aborted || error.name === "AbortError";
    const classified = error instanceof ClassifiedError ? error : new ClassifiedError("EXECUTOR_ERROR", false, error.message);
    const code = aborted && !(error instanceof ClassifiedError) ? "ABORTED" : classified.code;
    const retryable = !aborted && classified.retryable;

    const files: WrittenFile[] = [...info.writtenFiles];
    try {
      const manifest = renderRunJson(ctx, info.scopeHash, info.providerFailures, { model_tokens: 0, cost_usd: 0 }, { source_count: 0, new_count: 0, theme_count: 0, important_count: 0 }, { started_at: new Date(info.startedAtMs).toISOString(), ended_at: new Date(info.nowMs()).toISOString() }, Object.fromEntries(files.map((file) => [basenameOf(file.path), file.sha256])), appVersion(), { code, message: classified.message });
      const sha256Of = sha256(manifest);
      await writeImmutableFile(resolveInside(resolve(ctx.cwd), info.attemptDirRelative), "run.json", manifest);
      await this.recordProvenance(ctx, `${info.attemptDirRelative}/run.json`, sha256Of, Buffer.byteLength(manifest, "utf8"));
      files.push({ path: `${info.attemptDirRelative}/run.json`, sha256: sha256Of });
    } catch (manifestError) {
      ctx.log(`terminal run.json write failed: ${manifestError instanceof Error ? manifestError.message : String(manifestError)}`);
    }
    await this.finishExecution(ctx, aborted ? "cancelled" : "failed", files, { model_tokens: 0, cost_usd: 0 }, { source_count: 0, new_count: 0, provider_failure_count: info.providerFailures.length }, code, info.nowMs());

    return {
      status: "failed",
      retryable,
      errorCode: code,
      errorMessage: classified.message,
      outputPaths: files.map((file) => resolve(ctx.cwd, file.path)),
      usage: { model_tokens: 0, cost_usd: 0 },
    };
  }
}

// --- pure helpers ---------------------------------------------------------------

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1]!;
}

/** Stable key: normalized DOI, else provider:id, else canonical URL (docs §9.7 step 2). */
export function stableRecordKey(record: Pick<DigestProviderRecord, "doi" | "id" | "provider" | "url">): string {
  const doi = record.doi?.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
  if (doi) return `doi:${doi}`;
  if (record.id.trim()) return `${record.provider}:${record.id.trim()}`;
  return canonicalUrl(record.url);
}

function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    const params = [...parsed.searchParams.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    parsed.search = "";
    for (const [key, value] of params) parsed.searchParams.append(key, value);
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/** Flatten across providers → stable sort by key → deterministic dedup → truncate to max_results → index 1..N (docs §9.7 steps 1–6). */
export function selectRecords(results: readonly DigestProviderResult[], maxResults: number): SelectedRecord[] {
  const keyed = results.flatMap((result) => result.records.map((record) => ({ record, responseHash: result.responseHash })))
    .map((entry, index) => ({ key: stableRecordKey(entry.record), index, ...entry }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.index - right.index));
  const seen = new Set<string>();
  const selected: SelectedRecord[] = [];
  for (const entry of keyed) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (selected.length >= maxResults) break;
    selected.push({ source_index: selected.length + 1, stable_key: entry.key, isNew: true, record: entry.record, responseHash: entry.responseHash });
  }
  return selected;
}

function applyDelta(selected: SelectedRecord[], previousKeys: string[] | null): void {
  if (!previousKeys) return; // absent baseline ⇒ every record stays new.
  const baseline = new Set(previousKeys);
  for (const entry of selected) entry.isNew = !baseline.has(entry.stable_key);
}

function extractAbstract(record: DigestProviderRecord): string | undefined {
  if (typeof record.abstract === "string" && record.abstract.trim()) return record.abstract;
  const extra = record.extra?.abstract;
  return typeof extra === "string" && extra.trim() ? extra : undefined;
}

/** Strict digest schema + source-index existence check (docs §9.7, §14.2 Literature rows). */
export function validateDigest(parsed: unknown, maxIndex: number): { executive_summary: string; themes: Array<{ title: string; summary: string; source_indices: number[] }>; important_records: number[]; limitations: string } {
  if (typeof parsed !== "object" || parsed === null) throw new ClassifiedError("PI_RESPONSE_INVALID", false, "Pi returned a non-object digest payload");
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.executive_summary !== "string" || typeof candidate.limitations !== "string" || !Array.isArray(candidate.themes) || !Array.isArray(candidate.important_records)) {
    throw new ClassifiedError("PI_RESPONSE_INVALID", false, "digest payload misses required fields (executive_summary/themes/important_records/limitations)");
  }
  const themes = candidate.themes.map((theme) => {
    const entry = theme as Record<string, unknown>;
    if (typeof entry.title !== "string" || typeof entry.summary !== "string" || !Array.isArray(entry.source_indices)) {
      throw new ClassifiedError("PI_RESPONSE_INVALID", false, "a theme misses title/summary/source_indices");
    }
    return { title: entry.title, summary: entry.summary, source_indices: entry.source_indices.map(Number) };
  });
  const important = candidate.important_records.map(Number);
  const referenced = [...themes.flatMap((theme) => theme.source_indices), ...important];
  const invalid = [...new Set(referenced.filter((index) => !Number.isInteger(index) || index < 1 || index > maxIndex))];
  if (invalid.length > 0) throw new ClassifiedError("INVALID_SOURCE_INDEX", false, `digest references non-existent source indices: ${invalid.join(",")}`);
  return { executive_summary: candidate.executive_summary, themes, important_records: important, limitations: candidate.limitations };
}

// --- renderers -------------------------------------------------------------------

const LABELS = {
  "zh-CN": { titleSeparator: " · ", summary: "## 执行摘要", themes: "## 主题", important: "## 重要文献", limitations: "## 局限性", sources: "## 来源列表", newMarker: "（新）", noRecords: "本次检索没有返回记录。", baselineNote: "> 增量基线不可用：全部记录按新增处理。", sourceLabel: "来源", linkLabel: "链接" },
  en: { titleSeparator: " — ", summary: "## Executive summary", themes: "## Themes", important: "## Important records", limitations: "## Limitations", sources: "## Sources", newMarker: " (new)", noRecords: "The search returned no records.", baselineNote: "> Delta baseline unavailable: all records are treated as new.", sourceLabel: "Source", linkLabel: "Link" },
} as const;

function mdCell(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\|/g, "\\|").trim();
}

function renderReport(input: {
  name: string;
  businessDate: string;
  language: "zh-CN" | "en";
  digest: ReturnType<typeof validateDigest>;
  selected: SelectedRecord[];
  providerFailures: ReadonlyArray<{ provider: string; error: string }>;
  baselineUnavailable: boolean;
}): string {
  const labels = LABELS[input.language];
  const lines: string[] = [`# ${mdCell(input.name)}${labels.titleSeparator}${input.businessDate}`, ""];
  if (input.selected.length === 0) lines.push(labels.noRecords, "");
  lines.push(labels.summary, "", input.digest.executive_summary.trim() || "-", "");
  if (input.baselineUnavailable) lines.push(labels.baselineNote, "");
  if (input.digest.themes.length > 0) {
    lines.push(labels.themes, "");
    for (const theme of input.digest.themes) {
      lines.push(`### ${mdCell(theme.title)}`, "", theme.summary.trim() || "-", "");
      lines.push(`${labels.sourceLabel}: ${theme.source_indices.map((index) => `[${index}]`).join(" ")}`, "");
    }
  }
  if (input.digest.important_records.length > 0) {
    const byIndex = new Map(input.selected.map((entry) => [entry.source_index, entry]));
    lines.push(labels.important, "", `| # | ${labels.sourceLabel} | ${labels.linkLabel} |`, "| --- | --- | --- |");
    for (const index of input.digest.important_records) {
      const entry = byIndex.get(index);
      if (!entry) continue;
      const link = entry.record.doi ? `https://doi.org/${entry.record.doi}` : entry.record.url;
      lines.push(`| ${index} | ${mdCell(entry.record.title)} | ${link} |`);
    }
    lines.push("");
  }
  lines.push(labels.limitations, "", input.digest.limitations.trim() || "-", "");
  if (input.providerFailures.length > 0) lines.push(`> provider_failures: ${input.providerFailures.map((failure) => `${failure.provider} (${failure.error})`).join("; ")}`, "");
  lines.push(labels.sources, "");
  for (const entry of input.selected) {
    const identifiers = [entry.record.doi ? `DOI: ${entry.record.doi}` : null, `URL: ${entry.record.url}`, `provider: ${entry.record.provider}`].filter(Boolean).join(" · ");
    lines.push(`- [${entry.source_index}] ${mdCell(entry.record.title)}${entry.isNew ? labels.newMarker : ""} — ${identifiers}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderSourcesJson(input: {
  snapshot: ScheduledTaskSnapshot;
  run: ExecutorContext["run"];
  attempt: ExecutorContext["attempt"];
  config: ScheduledTaskSnapshot["executor"]["config"];
  selected: SelectedRecord[];
  providerFailures: ReadonlyArray<{ provider: string; error: string }>;
  generatedAt: string;
  baselineKeys: string[] | null;
}): string {
  const body = {
    schema_version: 1,
    task_id: input.snapshot.task_id,
    run_id: input.run.run_id,
    attempt_id: input.attempt.attempt_id,
    business_date: input.run.business_date,
    generated_at: input.generatedAt,
    query: input.config.query,
    requested_providers: [...new Set(input.config.providers)].sort(),
    baseline: { status: input.baselineKeys ? "ok" : "baseline_unavailable", previous_key_count: input.baselineKeys?.length ?? null },
    provider_failures: input.providerFailures,
    response_hashes: [...new Set(input.selected.map((entry) => entry.responseHash))].sort(),
    records: input.selected.map((entry) => ({
      source_index: entry.source_index,
      stable_key: entry.stable_key,
      new: entry.isNew,
      id: entry.record.id,
      provider: entry.record.provider,
      title: entry.record.title,
      url: entry.record.url,
      doi: entry.record.doi ?? null,
      response_hash: entry.responseHash,
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** run.json manifest (docs §9.10 field list); `error` only on terminal failures. */
function renderRunJson(
  ctx: ExecutorContext,
  scopeHash: string,
  providerFailures: ReadonlyArray<{ provider: string; error: string }>,
  usage: { model_tokens: number; cost_usd: number },
  counts: { source_count: number; new_count: number; theme_count: number; important_count: number },
  timings: { started_at: string; ended_at: string },
  outputs: Record<string, string>,
  appVersion: string | null,
  error?: { code: string; message: string },
): string {
  const snapshot = ctx.run.snapshot;
  const schedule = snapshot.schedule;
  const timezone = "timezone" in schedule ? schedule.timezone : "UTC";
  const body: Record<string, unknown> = {
    schema_version: 1,
    task_id: snapshot.task_id,
    run_id: ctx.run.run_id,
    attempt_id: ctx.attempt.attempt_id,
    execution_id: ctx.attempt.execution_id,
    task_revision: snapshot.revision,
    snapshot_sha256: ctx.run.snapshot_sha256,
    scheduled_for: ctx.run.scheduled_for,
    business_date: ctx.run.business_date,
    timezone,
    approval_scope_hash: scopeHash,
    provider_failures: providerFailures,
    counts,
    usage,
    timings,
    outputs,
    ...(appVersion ? { app_version: appVersion } : {}),
    ...(error ? { error_code: error.code, error_message: error.message } : {}),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
