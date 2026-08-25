// LiteratureDigestExecutor tests (docs §14.2 Literature/Delta/Output/Security
// rows): fake gateway + fake Pi runner, tempdir workspaces, no real network,
// no real sleeps. Every safety gate gets a negative assertion.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecutorContext, ExecutorResult } from "./executor.js";
import type { PiJsonRunner, PiJsonRunResult } from "./pi-json-runner.js";
import { LiteratureDigestExecutor, type DigestSearchOutcome } from "./literature-digest-executor.js";
import type { ExecutionRepository } from "../runtime/executions/execution-repository.js";
import type { ScheduledTaskRun, ScheduledTaskRunAttempt } from "./types.js";

const NOW = 1_800_000_000_000;
const WORKSPACE = "/tmp/pi-science-digest-executor-workspace";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-science-digest-ws-"));
  directories.push(dir);
  return dir;
}

function makeCtx(overrides: {
  cwd?: string;
  query?: string;
  providers?: string[];
  approvalCategories?: string[];
  scopeHashOverride?: string;
  outputRoot?: string;
  maxResults?: number;
  aborted?: boolean;
} = {}): { ctx: ExecutorContext; snapshotHash: string } {
  const query = overrides.query ?? "single-cell RNA sequencing quality control";
  const providers = overrides.providers ?? ["pubmed", "arxiv"];
  const outputRoot = overrides.outputRoot ?? "reports/literature";
  // Scope hash must equal computeApprovalScopeHash over the same payload; the
  // executor recomputes it, so the fixture just mirrors the canonical order.
  const canonical = JSON.stringify({
    executor_kind: "literature_digest",
    query,
    providers: [...new Set(providers)].sort(),
    instructions: "",
    max_results: overrides.maxResults ?? 30,
    language: "zh-CN",
    output_relative_root: outputRoot,
  });
  const scopeHash = createHash("sha256").update(canonical).digest("hex");
  const snapshot = {
    schema_version: 1 as const,
    task_id: "stask_digest1",
    project_id: "project_x",
    workspace_path_at_claim: WORKSPACE,
    revision: 3,
    name: "Daily digest",
    schedule: { type: "cron" as const, expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    executor: { kind: "literature_digest" as const, config: { query, providers: providers as never, instructions: "", max_results: overrides.maxResults ?? 30, language: "zh-CN" as const } },
    output: { relative_root: outputRoot },
    approval: { status: "approved" as const, scope_hash: overrides.scopeHashOverride ?? scopeHash, approved_revision: 3, categories: overrides.approvalCategories ?? [] },
    retry: { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 },
    budget: { max_wall_time_seconds: 900 },
    misfire_policy: "coalesce_latest" as const,
    concurrency_policy: "forbid" as const,
    claimed_at: new Date(NOW).toISOString(),
  };
  const run = {
    run_id: "run_r1",
    task_id: snapshot.task_id,
    task_revision: snapshot.revision,
    trigger_source: "automatic",
    scheduled_for: new Date(NOW).toISOString(),
    business_date: "2027-01-15",
    occurrence_key: `${snapshot.task_id}:${NOW}`,
    status: "running",
    snapshot,
    snapshot_sha256: "sha_snapshot",
    latest_attempt_id: "satt_a1",
    attempt_count: 1,
    output_paths: [],
    error_code: null,
    error_message: null,
    created_at: new Date(NOW).toISOString(),
    started_at: new Date(NOW).toISOString(),
    ended_at: null,
  } as unknown as ScheduledTaskRun;
  const attempt = {
    attempt_id: "satt_a1",
    run_id: "run_r1",
    attempt_no: 1,
    status: "running",
    available_at: NOW,
    execution_id: "exec_test1234",
    owner_instance_id: "inst",
    owner_token: "tok",
    owner_generation: 1,
    heartbeat_at: null,
    lease_expires_at: null,
    cancel_requested_at: null,
    recovery_of_attempt_id: null,
    output_paths: [],
    usage: {},
    error_code: null,
    error_message: null,
    started_at: new Date(NOW).toISOString(),
    ended_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
  } as unknown as ScheduledTaskRunAttempt;
  const controller = new AbortController();
  if (overrides.aborted) controller.abort();
  const ctx = {
    task: { task_id: snapshot.task_id, name: snapshot.name } as never,
    run,
    attempt,
    workspacePath: WORKSPACE,
    cwd: overrides.cwd ?? WORKSPACE,
    signal: controller.signal,
    now: () => NOW,
    log: () => undefined,
  };
  return { ctx: ctx as unknown as ExecutorContext, snapshotHash: scopeHash };
}

interface FakeLiteratureCalls { approve: Array<[string, readonly string[]]>; search: Array<[string, { providers?: readonly string[]; approvedToken?: string }]> }

function fakeLiterature(outcome: DigestSearchOutcome): { deps: LiteratureDepsFixture["literature"]; calls: FakeLiteratureCalls } {
  const calls: FakeLiteratureCalls = { approve: [], search: [] };
  return {
    calls,
    deps: {
      approve: async (query, categories) => {
        calls.approve.push([query, categories]);
        return { approvedToken: "tok_123" };
      },
      search: async (query, options) => {
        calls.search.push([query, options ?? {}]);
        return outcome;
      },
    },
  };
}

type LiteratureDepsFixture = ConstructorParameters<typeof LiteratureDigestExecutor>[0];

function record(id: string, provider: string, doi?: string) {
  return { id, provider, title: `Title ${id}`, url: `https://example.org/${provider}/${id}`, doi, abstract: `Abstract of ${id}` };
}

function digestPayload(maxIndex: number) {
  return {
    executive_summary: "总结",
    themes: [{ title: "主题A", summary: "要点", source_indices: [Math.min(1, maxIndex)] }],
    important_records: [Math.min(1, maxIndex)],
    limitations: "局限",
  };
}

function fakePi(payload: unknown | ((callCount: number) => unknown), usage = { model_tokens: 42, cost_usd: 0.25 }): { pi: PiJsonRunner; calls: number } {
  let callCount = 0;
  const runner = {
    run: async (): Promise<PiJsonRunResult> => {
      callCount += 1;
      const value = typeof payload === "function" ? (payload as (n: number) => unknown)(callCount) : payload;
      return { text: JSON.stringify(value), parsed: value, usage };
    },
  };
  return { pi: runner as unknown as PiJsonRunner, calls: callCount };
}

describe("LiteratureDigestExecutor", () => {
  it("runs the full chain and writes immutable report/sources/run.json under the attempt directory", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: false, results: [
      { provider: "pubmed", records: [record("10.1111/a", "pubmed", "10.1111/a"), record("p2", "pubmed")], responseHash: "hash_pubmed" },
      { provider: "arxiv", records: [record("a1", "arxiv")], responseHash: "hash_arxiv" },
    ], failures: [] });
    const { pi } = fakePi(digestPayload(3));
    const executions: { starts: Array<unknown[]>; finishes: Array<unknown[]> } = { starts: [], finishes: [] };
    const provenanceRecords: Array<Record<string, unknown>> = [];
    const executor = new LiteratureDigestExecutor({
      literature: lit.deps,
      pi,
      executions: {
        start: (async (...args: unknown[]) => { executions.starts.push(args); return {} as never; }) as unknown as Pick<ExecutionRepository, "start">["start"],
        finish: (async (...args: unknown[]) => { executions.finishes.push(args); return {} as never; }) as unknown as Pick<ExecutionRepository, "finish">["finish"],
      },
      provenance: { record: async (dir, entry) => { provenanceRecords.push({ dir, entry }); }, } ,
    });
    const { ctx } = makeCtx({ cwd });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("succeeded");
    expect(result.outputPaths).toHaveLength(3);
    const base = join(cwd, "reports/literature/stask_digest1/2027-01-15/run_r1/satt_a1");
    const report = await readFile(join(base, "report.md"), "utf8");
    expect(report).toContain("Daily digest");
    const sources = JSON.parse(await readFile(join(base, "sources.json"), "utf8"));
    expect(sources.records).toHaveLength(3);
    expect(sources.records[0].source_index).toBe(1);
    expect(sources.provider_failures).toEqual([]);
    const manifest = JSON.parse(await readFile(join(base, "run.json"), "utf8"));
    expect(manifest.attempt_id).toBe("satt_a1");
    expect(manifest.execution_id).toBe("exec_test1234");
    expect(Object.keys(manifest.outputs).sort()).toEqual(["report.md", "sources.json"]);
    // One Execution per Attempt with full correlation (docs §9.11).
    expect(executions.starts).toHaveLength(1);
    expect(executions.finishes).toHaveLength(1);
    const startInput = executions.starts[0]![1] as Record<string, unknown>;
    expect(startInput.kind).toBe("scheduled_task");
    expect((startInput.correlation as Record<string, unknown>).scheduled_task_attempt_id).toBe("satt_a1");
    // Provenance recorded per written file with execution correlation.
    expect(provenanceRecords.length).toBeGreaterThanOrEqual(3);
    expect(provenanceRecords.every((row) => row.entry && typeof row.entry === "object")).toBe(true);
  });

  it("fails APPROVAL_SCOPE_INVALID before any egress when fresh detection is not covered", async () => {
    const cwd = await tempWorkspace();
    // 16 nt DNA run ⇒ dna-sequence category; snapshot approval covers nothing.
    const lit = fakeLiterature({ blocked: false, results: [], failures: [] });
    const { pi } = fakePi(digestPayload(0));
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd, query: "ACGTACGTACGTACGT expression atlas" });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(result.errorCode).toBe("APPROVAL_SCOPE_INVALID");
    expect(lit.calls.approve).toHaveLength(0);
    expect(lit.calls.search).toHaveLength(0);
  });

  it("fails APPROVAL_SCOPE_INVALID without egress on a scope-hash mismatch", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: false, results: [], failures: [] });
    const { pi } = fakePi(digestPayload(0));
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd, scopeHashOverride: "stale_hash" });
    const result = await executor.execute(ctx);

    expect(result.errorCode).toBe("APPROVAL_SCOPE_INVALID");
    expect(lit.calls.search).toHaveLength(0);
  });

  it("maps a blocked gateway outcome to non-retryable APPROVAL_REQUIRED", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: true, categories: ["dna-sequence"], terms: ["ACGT"] });
    const { pi } = fakePi(digestPayload(0));
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd, query: "ACGTACGTACGTACGT expression atlas", approvalCategories: ["dna-sequence"] });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(result.errorCode).toBe("APPROVAL_REQUIRED");
  });

  it("classifies total provider failure as retryable PROVIDER_UNAVAILABLE", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: false, results: [], failures: [{ provider: "pubmed", error: "503" }, { provider: "arxiv", error: "ECONNRESET" }] });
    const { pi } = fakePi(digestPayload(0));
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd });
    const result = await executor.execute(ctx);

    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("keeps partial provider failure successful and records provider_failures in evidence", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: false, results: [{ provider: "pubmed", records: [record("p1", "pubmed")], responseHash: "h" }], failures: [{ provider: "arxiv", error: "timeout" }] });
    const { pi } = fakePi(digestPayload(1));
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("succeeded");
    const sources = JSON.parse(await readFile(join(cwd, "reports/literature/stask_digest1/2027-01-15/run_r1/satt_a1/sources.json"), "utf8"));
    expect(sources.provider_failures).toEqual([{ provider: "arxiv", error: "timeout" }]);
    expect(sources.records).toHaveLength(1);
  });

  it("treats zero records with zero failures as a valid empty result", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: false, results: [], failures: [] });
    const { pi } = fakePi({ executive_summary: "empty", themes: [], important_records: [], limitations: "none" });
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("succeeded");
    const sources = JSON.parse(await readFile(join(cwd, "reports/literature/stask_digest1/2027-01-15/run_r1/satt_a1/sources.json"), "utf8"));
    expect(sources.records).toHaveLength(0);
  });

  it("rejects digests that reference non-existent source indices without writing report.md", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: false, results: [{ provider: "pubmed", records: [record("p1", "pubmed")], responseHash: "h" }], failures: [] });
    const { pi } = fakePi({ executive_summary: "x", themes: [{ title: "t", summary: "s", source_indices: [7] }], important_records: [], limitations: "l" });
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("INVALID_SOURCE_INDEX");
    // sources.json already published (evidence survives a Pi failure, docs §9.10).
    const base = join(cwd, "reports/literature/stask_digest1/2027-01-15/run_r1/satt_a1");
    await expect(stat(join(base, "sources.json"))).resolves.toBeTruthy();
    await expect(stat(join(base, "report.md"))).rejects.toThrow();
  });

  it("marks only unseen stable keys as new; an unavailable baseline marks everything new", async () => {
    const cwd = await tempWorkspace();
    const lit = fakeLiterature({ blocked: false, results: [{ provider: "pubmed", records: [record("10.1111/a", "pubmed", "10.1111/a"), record("p2", "pubmed")], responseHash: "h" }], failures: [] });
    const { pi } = fakePi(digestPayload(2));
    let baselines = 0;
    const executor = new LiteratureDigestExecutor({
      literature: lit.deps,
      pi,
      loadPreviousStableKeys: async () => {
        baselines += 1;
        return baselines === 1 ? ["doi:10.1111/a"] : null;
      },
    });

    const first = await executor.execute(makeCtx({ cwd }).ctx);
    expect(first.status).toBe("succeeded");
    const sources1 = JSON.parse(await readFile(join(cwd, "reports/literature/stask_digest1/2027-01-15/run_r1/satt_a1/sources.json"), "utf8"));
    expect(sources1.records.map((row: { new: boolean }) => row.new)).toEqual([false, true]);

    // Second workspace run: loader now returns null ⇒ baseline_unavailable ⇒ all new.
    const secondDir = await tempWorkspace();
    const second = await executor.execute(makeCtx({ cwd: secondDir }).ctx);
    expect(second.status).toBe("succeeded");
    const sources2 = JSON.parse(await readFile(join(secondDir, "reports/literature/stask_digest1/2027-01-15/run_r1/satt_a1/sources.json"), "utf8"));
    expect(sources2.baseline.status).toBe("baseline_unavailable");
    expect(sources2.records.every((row: { new: boolean }) => row.new)).toBe(true);
  });

  it("never overwrites an existing attempt file (immutable output, docs §9.10)", async () => {
    const cwd = await tempWorkspace();
    const existing = join(cwd, "reports/literature/stask_digest1/2027-01-15/run_r1/satt_a1/sources.json");
    await mkdir(dirname(existing), { recursive: true });
    await writeFile(existing, "tampered", "utf8");
    const lit = fakeLiterature({ blocked: false, results: [{ provider: "pubmed", records: [record("p1", "pubmed")], responseHash: "h" }], failures: [] });
    const { pi } = fakePi(digestPayload(1));
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ cwd });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("failed");
    expect(await readFile(existing, "utf8")).toBe("tampered");
  });

  it("aborts before egress when the signal is already fired", async () => {
    const lit = fakeLiterature({ blocked: false, results: [], failures: [] });
    const { pi } = fakePi(digestPayload(0));
    const executor = new LiteratureDigestExecutor({ literature: lit.deps, pi });
    const { ctx } = makeCtx({ aborted: true });
    const result = await executor.execute(ctx);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(lit.calls.search).toHaveLength(0);
  });
});
