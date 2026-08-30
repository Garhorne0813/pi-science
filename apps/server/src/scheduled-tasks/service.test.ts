// Service tests for Phase 4 (docs §14.2 rows: policy limits, approval gate,
// manual run 202 semantics, retry state machine, feature flag). Fake clock via
// injected now(); deterministic rng for backoff jitter; no real sleeps.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduledTaskRepository, type SetTaskStatusAction } from "../storage/sqlite/repositories/scheduled-task-repository.js";
import { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore, SqliteStateStore } from "../storage/sqlite/state-store.js";
import { ensureProject } from "../project/project-registry.js";
import { buildSnapshot, ScheduledTaskService, stableStringify } from "./service.js";

const NOW = 1_800_000_000_000;
const WORKSPACE = "/tmp/pi-science-stask-service-workspace";

const SCHEDULE = { type: "interval", every_seconds: 3600, anchor_at: "2026-01-01T00:00:00Z", timezone: "UTC" };
const RETRY = { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 };
const BUDGET = { max_wall_time_seconds: 900 };

function executor(query = "single-cell RNA sequencing quality control") {
  return { kind: "literature_digest" as const, config: { query, providers: ["pubmed" as const], max_results: 30, language: "zh-CN" as const } };
}

const stores: SqliteStateStore[] = [];
const directories: string[] = [];
const previousFlag = process.env.PI_SCIENCE_SCHEDULED_TASKS;

// Flag defaults to off (docs §15.5 grey-release); every positive-path test opts in.
beforeEach(() => {
  process.env.PI_SCIENCE_SCHEDULED_TASKS = "1";
});

afterEach(async () => {
  if (previousFlag === undefined) delete process.env.PI_SCIENCE_SCHEDULED_TASKS;
  else process.env.PI_SCIENCE_SCHEDULED_TASKS = previousFlag;
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function memStore(): Promise<InMemorySqliteStateStore> {
  const value = new InMemorySqliteStateStore();
  stores.push(value);
  await value.start();
  return value;
}

interface Harness {
  store: InMemorySqliteStateStore;
  repository: ScheduledTaskRepository;
  workspaces: WorkspaceRepository;
  service: ScheduledTaskService;
  nowMs: number;
  setNow(ms: number): void;
  rngValues: number[];
}

async function harness(options: { config?: Partial<Parameters<typeof makeService>[1]>; workspace?: boolean } = {}): Promise<Harness> {
  const store = await memStore();
  await store.run(
    "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES ('project_service', 'service', 1, ?, ?, ?)",
    [NOW, NOW, NOW],
  );
  let workspaces: WorkspaceRepository | undefined;
  if (options.workspace !== false) {
    workspaces = new WorkspaceRepository(store);
    // Registered workspace row without touching the filesystem.
    await workspaces.remember({ project_id: "project_service", name: "service", canonical_path: WORKSPACE, preserve_path: true, touch: false });
  }
  return makeHarnessParts(store, workspaces);
}

function makeHarnessParts(store: InMemorySqliteStateStore, workspaces?: WorkspaceRepository, serviceOptions?: Parameters<typeof makeService>[1]): Harness {
  let nowMs = NOW;
  const rngValues: number[] = [];
  const repository = new ScheduledTaskRepository(store);
  const service = makeService(repository, serviceOptions, () => nowMs, () => rngValues.shift() ?? 0.5, workspaces);
  return {
    store,
    repository,
    workspaces: workspaces ?? new WorkspaceRepository(store),
    service,
    get nowMs() { return nowMs; },
    setNow(ms: number) { nowMs = ms; },
    rngValues,
  };
}

type ServiceConfigArg = Partial<{ max_active_tasks_per_workspace: number; min_frequency_ms: number }>;

function makeService(
  repository: ScheduledTaskRepository,
  config: ServiceConfigArg | undefined,
  now?: () => number,
  rng?: () => number,
  workspaces?: WorkspaceRepository,
): ScheduledTaskService {
  return new ScheduledTaskService({
    repository,
    ...(workspaces ? { workspaces } : {}),
    now,
    rng,
    ...(config ? { config } : {}),
  });
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: "Daily digest",
    schedule: SCHEDULE,
    executor: executor(),
    output: { relative_root: "outputs/digest" },
    retry: RETRY,
    budget: BUDGET,
    ...overrides,
  };
}

describe("scheduled task service — create validation", () => {
  it("creates a task bound to a registered workspace with an armed next_run_at", async () => {
    const h = await harness();
    const result = await h.service.createTask(WORKSPACE, createRequest());
    if (!result.ok) { const { writeFileSync } = await import("node:fs"); writeFileSync("/tmp/dbg-out2.json", JSON.stringify(result.error, null, 2)); }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project_id).toBe("project_service");
    expect(result.value.lifecycle_status).toBe("active");
    expect(result.value.approval.status).toBe("none");
    expect(Date.parse(result.value.next_run_at!)).toBeGreaterThan(NOW);
  });

  it("falls back to ensureProject(cwd) when no WorkspaceRepository is injected", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-stask-svc-ws-"));
    directories.push(root);
    const store = await memStore();
    const parts = makeHarnessParts(store, undefined);
    // The manifest exists on disk; its project row must be present for the FK.
    const manifest = await ensureProject(root);
    await store.run(
      "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, ?, ?, ?)",
      [manifest.id, manifest.name, NOW, NOW, NOW],
    );
    const result = await parts.service.createTask(root, createRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project_id).toBe(manifest.id);
  });

  it("enforces the per-workspace active task limit (docs §15.5)", async () => {
    const h = await harness();
    // Same registry so the fallback-free path owns the FK'd project row.
    const limited = new ScheduledTaskService({
      repository: h.repository,
      workspaces: h.workspaces,
      now: () => h.nowMs,
      config: { max_active_tasks_per_workspace: 2 },
    });
    expect((await limited.createTask(WORKSPACE, createRequest({ name: "one" }))).ok).toBe(true);
    expect((await limited.createTask(WORKSPACE, createRequest({ name: "two" }))).ok).toBe(true);
    const third = await limited.createTask(WORKSPACE, createRequest({ name: "three" }));
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.code).toBe("SCHEDULED_TASK_POLICY_VIOLATION");
    expect(third.error.http_status).toBe(422);
  });

  it("rejects cron expressions firing more often than every 5 minutes", async () => {
    const h = await harness();
    const result = await h.service.createTask(WORKSPACE, createRequest({ schedule: { type: "cron", expression: "*/1 * * * *", timezone: "UTC" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SCHEDULED_TASK_POLICY_VIOLATION");
    expect(result.error.http_status).toBe(422);
    // A 5-minute-spaced cron passes the same gate.
    const okResult = await h.service.createTask(WORKSPACE, createRequest({ name: "five", schedule: { type: "cron", expression: "*/5 * * * *", timezone: "UTC" } }));
    expect(okResult.ok).toBe(true);
  });

  it("rejects output roots that escape the workspace or touch reserved metadata", async () => {
    const h = await harness();
    for (const relativeRoot of ["/etc/pki", "C:\\temp", "\\\\server\\share", "../escape", "a/../b", ".pi-science/steal", "outputs/.PI-Science"]) {
      const result = await h.service.createTask(WORKSPACE, createRequest({ output: { relative_root: relativeRoot } }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("OUTPUT_ROOT_FORBIDDEN");
    }
    const nested = await h.service.createTask(WORKSPACE, createRequest({ output: { relative_root: "reports/literature/daily" } }));
    expect(nested.ok).toBe(true);
  });

  it("gates sensitive queries behind approval='pending' and keeps next_run_at NULL", async () => {
    const h = await harness();
    const sensitive = await h.service.createTask(WORKSPACE, createRequest({ executor: executor("patient MRN 88-12-31 cohort GATTACAGATTACA") }));
    expect(sensitive.ok).toBe(true);
    if (!sensitive.ok) return;
    expect(sensitive.value.approval.status).toBe("pending");
    expect(sensitive.value.approval.categories.length).toBeGreaterThan(0);
    expect(sensitive.value.next_run_at).toBeNull();

    const plain = await h.service.createTask(WORKSPACE, createRequest({ name: "plain" }));
    expect(plain.ok && plain.value.approval.status === "none" && plain.value.next_run_at !== null).toBe(true);
  });
});

describe("scheduled task service — lifecycle pass-through", () => {
  it("pauses, resumes and deletes through CAS with typed errors on conflict", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest());
    if (!created.ok) throw new Error("create failed");
    const taskId = created.value.task_id;

    const paused = await act(h.service.setTaskStatus(taskId, WORKSPACE, 1, "pause"));
    expect(paused.lifecycle_status).toBe("paused");
    expect(paused.next_run_at).toBeNull();

    const stalePause = await h.service.setTaskStatus(taskId, WORKSPACE, 1, "pause");
    expect(stalePause.ok).toBe(false);
    if (!stalePause.ok) expect(stalePause.error.code).toBe("SCHEDULED_TASK_REVISION_CONFLICT");

    const resumed = await act(h.service.setTaskStatus(taskId, WORKSPACE, 2, "resume"));
    expect(resumed.lifecycle_status).toBe("active");

    const deleted = await act(h.service.setTaskStatus(taskId, WORKSPACE, 3, "delete"));
    expect(deleted.deleted_at).not.toBeNull();
    const gone = await h.service.getTask(taskId, WORKSPACE);
    expect(gone.ok && gone.value === null).toBe(true);
  });

  it("resets approval to none after a scope-changing PATCH (docs §5.11)", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest({ executor: executor("GATTACAGATTACA cohort") }));
    if (!created.ok) throw new Error("create failed");
    const taskId = created.value.task_id;
    const approved = await h.repository.approveTask(taskId, created.value.revision, created.value.approval.scope_hash, ["dna-sequence"], [], NOW + 10);
    expect(approved.approval.status).toBe("approved");

    // Approve never bumps the definition revision (docs §5.11), so PATCH CASes on 1.
    const patched = await act(h.service.patchTask(taskId, WORKSPACE, 1, { executor: executor("different GATTACAGATTACA query") }));
    expect(patched.approval.status).toBe("none");
    expect(patched.revision).toBe(2);

    // Name-only PATCH leaves approval untouched.
    const renamed = await act(h.service.patchTask(taskId, WORKSPACE, 2, { name: "renamed" }));
    expect(renamed.approval.status).toBe("none");
    expect(renamed.revision).toBe(3);
  });

  it("returns 404 for tasks outside the requesting workspace (docs §12.8)", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest());
    if (!created.ok) throw new Error("create failed");
    const cross = await h.service.getTask(created.value.task_id, "/tmp/pi-science-other-workspace");
    expect(cross.ok && cross.value === null).toBe(true);
    const patchCross = await h.service.patchTask(created.value.task_id, "/tmp/pi-science-other-workspace", 1, { name: "x" });
    expect(patchCross.ok).toBe(false);
    if (!patchCross.ok) expect(patchCross.error.code).toBe("SCHEDULED_TASK_NOT_FOUND");
  });
});

describe("scheduled task service — runNow 202 semantics", () => {
  it("creates a durable manual run without waiting for execution", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest());
    if (!created.ok) throw new Error("create failed");
    const result = await h.service.runNow(created.value.task_id, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("created");
    expect(result.value.run.trigger_source).toBe("manual");
    expect(result.value.run.status).toBe("pending");
    expect(result.value.run.latest_attempt_id).not.toBeNull();
    // Manual runs never move automatic next_run_at.
    expect(Date.parse((await h.repository.getTask(created.value.task_id))!.next_run_at!)).toBe(Date.parse(created.value.next_run_at!));
  });

  it("records a terminal skipped Run when another run is still active", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest());
    if (!created.ok) throw new Error("create failed");
    expect((await h.service.runNow(created.value.task_id, WORKSPACE)).ok).toBe(true);
    const second = await h.service.runNow(created.value.task_id, WORKSPACE);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.status).toBe("skipped");
    expect(second.value.run.status).toBe("skipped");
    expect(second.value.run.error_code).toBe("OVERLAP_FORBIDDEN");
  });

  it("refuses manual runs while approval is pending (409 APPROVAL_REQUIRED)", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest({ executor: executor("GATTACAGATTACA") }));
    if (!created.ok) throw new Error("create failed");
    const result = await h.service.runNow(created.value.task_id, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SCHEDULED_TASK_APPROVAL_REQUIRED");
    expect(result.error.http_status).toBe(409);
  });
});

describe("scheduled task service — retryRun state machine", () => {
  interface FailedRunFixture {
    taskId: string;
    runId: string;
    latestAttemptId: string;
  }

  /** Drives a manual run to a terminal `failed` attempt through the repository
   * lease primitives so the retry path sees realistic fencing state. */
  async function failedRun(h: Harness, overrides: { retry?: typeof RETRY; finish?: boolean } = {}): Promise<FailedRunFixture> {
    const created = await h.service.createTask(WORKSPACE, createRequest({ retry: overrides.retry ?? RETRY }));
    if (!created.ok) throw new Error("create failed");
    const manual = await h.repository.createManualRun(created.value.task_id, h.nowMs);
    if (manual.status !== "created" || !manual.attempt) throw new Error("manual run not created");
    if (overrides.finish === false) return { taskId: created.value.task_id, runId: manual.run.run_id, latestAttemptId: manual.attempt.attempt_id };
    const lease = await h.repository.claimAttempt(manual.attempt.attempt_id, "owner_test", h.nowMs, 30_000);
    if (!lease) throw new Error("claim failed");
    const written = await h.repository.finishAttempt(lease.attempt_id, lease.owner_token, lease.owner_generation, {
      status: "failed",
      retryable: true,
      error_code: "PROVIDER_500",
      error_message: "provider exploded",
    }, h.nowMs);
    if (!written) throw new Error("finish failed");
    return { taskId: created.value.task_id, runId: manual.run.run_id, latestAttemptId: manual.attempt.attempt_id };
  }

  it("inserts a fresh pending attempt with deterministic jittered backoff", async () => {
    const h = await harness();
    h.rngValues.push(0.25); // jitter = 0.9 + 0.25*0.2 = 0.95
    const fixture = await failedRun(h);
    const before = h.nowMs;
    const result = await h.service.retryRun(fixture.taskId, fixture.runId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempt_no).toBe(2);
    expect(result.value.status).toBe("pending");
    // 30s initial backoff × 0.95 jitter = 28_500ms.
    expect(Date.parse(result.value.available_at)).toBe(before + 28_500);
    expect(result.value.execution_id).toMatch(/^exec_/);
    const run = await h.repository.getRun(fixture.runId);
    expect(run?.status).toBe("pending");
    expect(run?.attempt_count).toBe(2);
  });

  it("honors backoff bounds at both jitter extremes", async () => {
    for (const [rngValue, expected] of [[0, 27_000], [1, 33_000]] as const) {
      const h = await harness();
      h.rngValues.push(rngValue);
      const fixture = await failedRun(h);
      const before = h.nowMs;
      const result = await h.service.retryRun(fixture.taskId, fixture.runId, WORKSPACE);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(Date.parse(result.value.available_at)).toBe(before + expected);
    }
  });

  it("refuses non-terminal runs and exhausted attempts with RUN_RETRY_NOT_ALLOWED", async () => {
    const h = await harness();
    const running = await failedRun(h, { finish: false });
    const leased = await h.repository.claimAttempt(running.latestAttemptId, "owner_running", h.nowMs, 30_000);
    expect(leased).not.toBeNull();
    const runningRetry = await h.service.retryRun(running.taskId, running.runId, WORKSPACE);
    expect(runningRetry.ok).toBe(false);
    if (!runningRetry.ok) {
      expect(runningRetry.error.code).toBe("RUN_RETRY_NOT_ALLOWED");
      expect(runningRetry.error.http_status).toBe(409);
    }

    const exhausted = await failedRun(h, { retry: { ...RETRY, max_attempts: 1 } });
    const exhaustedRetry = await h.service.retryRun(exhausted.taskId, exhausted.runId, WORKSPACE);
    expect(exhaustedRetry.ok).toBe(false);
    if (!exhaustedRetry.ok) expect(exhaustedRetry.error.code).toBe("RUN_RETRY_NOT_ALLOWED");

    const succeeded = await failedRun(h);
    const lease = await h.repository.getAttempt(succeeded.latestAttemptId);
    expect(lease?.status).toBe("failed");
    const missing = await h.service.retryRun(succeeded.taskId, "srun_does_not_exist", WORKSPACE);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("SCHEDULED_TASK_RUN_NOT_FOUND");
  });
});

describe("scheduled task service — cancel and diagnostics", () => {
  it("cancels a pending attempt outright and reports the terminal run", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest());
    if (!created.ok) throw new Error("create failed");
    const manual = await h.repository.createManualRun(created.value.task_id, h.nowMs);
    if (manual.status !== "created") throw new Error("expected created");
    const result = await h.service.cancelRun(manual.run.run_id, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("cancelled");
    expect(result.value.run.status).toBe("cancelled");
  });

  it("aggregates diagnostics with neutral defaults and injected runtime values", async () => {
    const store = await memStore();
    await store.run(
      "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES ('project_service', 'service', 1, ?, ?, ?)",
      [NOW, NOW, NOW],
    );
    process.env.PI_SCIENCE_SCHEDULED_TASKS = "1";
    const service = new ScheduledTaskService({
      repository: new ScheduledTaskRepository(store),
      now: () => NOW,
      runtimeDiagnostics: () => ({
        status: "running",
        last_tick_at: new Date(NOW - 1000).toISOString(),
        next_deadline_at: new Date(NOW + 60_000).toISOString(),
        pending_attempts: 1,
        active_attempts: 2,
        expired_leases: 0,
        dispatcher_active: 2,
        dispatcher_limit: 2,
        last_error: null,
      }),
    });
    const diagnostics = await service.diagnostics();
    expect(diagnostics.feature_enabled).toBe(true);
    expect(diagnostics.pending_attempts).toBe(1);
    expect(diagnostics.dispatcher_limit).toBe(2);

    process.env.PI_SCIENCE_SCHEDULED_TASKS = "0";
    const disabled = await service.diagnostics();
    expect(disabled.feature_enabled).toBe(false);
    expect(disabled.status).toBe("disabled");
  });
});

describe("scheduled task service — snapshot canonicalization", () => {
  it("produces identical sha256 regardless of key insertion order", async () => {
    const h = await harness();
    const created = await h.service.createTask(WORKSPACE, createRequest());
    if (!created.ok) throw new Error("create failed");
    const first = buildSnapshot(created.value, NOW);
    // Deterministic for identical input.
    expect(buildSnapshot(created.value, NOW).sha256).toBe(first.sha256);
    // Rebuild the same snapshot object with reversed key order to prove
    // sorted-key stability of the canonical form.
    const parsed = JSON.parse(first.json) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    expect(stableStringify(reversed)).toBe(first.json);
    // Pending approval collapses to none inside snapshots (docs §7.5).
    const pendingTask = await h.service.createTask(WORKSPACE, createRequest({ name: "pending", executor: executor("GATTACAGATTACA") }));
    if (!pendingTask.ok) throw new Error("create failed");
    const pendingSnapshot = buildSnapshot(pendingTask.value, NOW);
    expect(pendingSnapshot.snapshot.approval.status).toBe("none");
  });
});

describe("scheduled task service — feature flag (docs §15.5)", () => {
  it("returns SCHEDULED_TASKS_DISABLED (503) from every method when the flag is off", async () => {
    process.env.PI_SCIENCE_SCHEDULED_TASKS = "0";
    const h = await harness();
    type FlagOutcome = { ok: false; error: { code: string; http_status: number } } | { ok: true; value: unknown };
    const actions: Array<[string, FlagOutcome]> = [];
    const create = await h.service.createTask(WORKSPACE, createRequest());
    actions.push(["create", create]);
    const list = await h.service.listTasks(WORKSPACE);
    actions.push(["list", list]);
    const runNow = await h.service.runNow("task_x", WORKSPACE);
    actions.push(["runNow", runNow]);
    const retry = await h.service.retryRun("task_x", "run_x", WORKSPACE);
    actions.push(["retry", retry]);
    const cancel = await h.service.cancelRun("run_x", WORKSPACE);
    actions.push(["cancel", cancel]);
    const pause = await h.service.setTaskStatus("task_x", WORKSPACE, 1, "pause" satisfies SetTaskStatusAction);
    actions.push(["pause", pause]);
    const approve = await h.service.approveTask("task_x", WORKSPACE, 1, "hash", []);
    actions.push(["approve", approve]);
    for (const [name, outcome] of actions) {
      expect(outcome.ok, `${name} should be refused`).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code, name).toBe("SCHEDULED_TASKS_DISABLED");
        expect(outcome.error.http_status, name).toBe(503);
      }
    }
  });
});

/** Unwraps a successful outcome or throws with the failure code in the message. */
function act<T>(outcome: Promise<{ ok: true; value: T } | { ok: false; error: { code: string } }> | { ok: true; value: T } | { ok: false; error: { code: string } }): Promise<T> {
  return Promise.resolve(outcome).then((resolved) => {
    if (!resolved.ok) throw new Error(`expected success, got ${resolved.error.code}`);
    return resolved.value;
  }) as Promise<T>;
}
