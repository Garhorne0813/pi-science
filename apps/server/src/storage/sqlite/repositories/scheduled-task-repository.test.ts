// Repository tests for the scheduled-tasks schema (docs §14.2 Repository /
// Snapshot / Migration rows). Concurrency cases use two real SqliteStateStore
// workers pointed at the same on-disk database; everything else runs against
// the in-memory worker store.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScheduledTaskSnapshot } from "../../../scheduled-tasks/types.js";
import { businessDateFor } from "../../../scheduled-tasks/schedule.js";
import { ScheduledTaskRepository, type ClaimOccurrenceInput, type ClaimOccurrenceResult } from "./scheduled-task-repository.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import { loadMigrations } from "../migrations.js";
import { InMemorySqliteStateStore, SqliteStateStore } from "../state-store.js";

const NOW = 1_800_000_000_000;
const STEP_MS = 3_600_000;

const SCHEDULE = { type: "interval", every_seconds: 3600, anchor_at: "2026-01-01T00:00:00Z", timezone: "UTC" };
const RETRY = { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 };
const BUDGET = { max_wall_time_seconds: 900 };
const EXECUTOR = { kind: "literature_digest" as const, config: { query: "CRISPR review", providers: ["pubmed" as const], max_results: 30, language: "zh-CN" as const } };

const stores: SqliteStateStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function memStore(): Promise<InMemorySqliteStateStore> {
  const value = new InMemorySqliteStateStore();
  stores.push(value);
  await value.start();
  return value;
}

/** Two independent workers sharing one on-disk database (docs §14.2 dual-worker rows). */
async function sharedFileStores(): Promise<[SqliteStateStore, SqliteStateStore]> {
  const root = await mkdtemp(join(tmpdir(), "pi-science-stask-concurrency-"));
  directories.push(root);
  const first = new SqliteStateStore({ path: join(root, "state.sqlite") });
  const second = new SqliteStateStore({ path: join(root, "state.sqlite") });
  stores.push(first, second);
  await first.start();
  await second.start();
  return [first, second];
}

async function seedProject(store: SqliteStateStore): Promise<string> {
  await store.run(
    "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, ?, ?, ?)",
    ["project_stask", "stask", NOW, NOW, NOW],
  );
  return "project_stask";
}

function taskInput(overrides: Partial<Parameters<ScheduledTaskRepository["insertTask"]>[0]> = {}): Parameters<ScheduledTaskRepository["insertTask"]>[0] {
  return {
    project_id: "project_stask",
    workspace_path: "/tmp/pi-science-stask-workspace",
    name: "Weekly digest",
    schedule: SCHEDULE,
    executor: EXECUTOR,
    output: { relative_root: "outputs/digest" },
    retry: RETRY,
    budget: BUDGET,
    now: NOW,
    ...overrides,
  };
}

async function seededTask(repo: ScheduledTaskRepository, overrides: Partial<Parameters<ScheduledTaskRepository["insertTask"]>[0]> = {}) {
  const projectCreated = overrides.project_id !== undefined ? Promise.resolve() : seedProject((repo as unknown as { store: SqliteStateStore }).store);
  await projectCreated;
  return repo.insertTask(taskInput(overrides));
}

function snapshotFor(task: Awaited<ReturnType<ScheduledTaskRepository["getTask"]>> & {}, scheduledForMs: number): { json: string; sha256: string } {
  const snapshot: ScheduledTaskSnapshot = {
    schema_version: 1,
    task_id: task.task_id,
    project_id: task.project_id,
    workspace_path_at_claim: task.workspace_path,
    revision: task.revision,
    name: task.name,
    display: task.display,
    origin: task.origin,
    delivery_policy: task.delivery_policy,
    schedule: task.schedule,
    executor: task.executor,
    output: task.output,
    approval: {
      status: task.approval.status === "approved" ? "approved" : "none",
      scope_hash: task.approval.scope_hash,
      approved_revision: task.approval.approved_revision,
      categories: task.approval.categories,
    },
    retry: task.retry,
    budget: task.budget,
    misfire_policy: task.misfire_policy,
    concurrency_policy: task.concurrency_policy,
    claimed_at: new Date(scheduledForMs).toISOString(),
  };
  return { json: JSON.stringify(snapshot), sha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}

function claimInput(task: NonNullable<Awaited<ReturnType<ScheduledTaskRepository["getTask"]>>>, options: {
  scheduledFor?: number;
  nextRunAt?: number | null;
  occurrenceKey?: string;
  runId?: string;
  attemptId?: string;
  executionId?: string;
  completesOnce?: boolean;
  now?: number;
} = {}): ClaimOccurrenceInput {
  const scheduledFor = options.scheduledFor ?? Date.parse(task.next_run_at!);
  const snapshot = snapshotFor(task, scheduledFor);
  return {
    task_id: task.task_id,
    expected_revision: task.revision,
    expected_next_run_at: Date.parse(task.next_run_at!),
    run_id: options.runId ?? `srun_${Math.random().toString(16).slice(2, 10)}`,
    attempt_id: options.attemptId ?? `satt_${Math.random().toString(16).slice(2, 10)}`,
    execution_id: options.executionId ?? `sexec_${Math.random().toString(16).slice(2, 10)}`,
    occurrence_key: options.occurrenceKey ?? `${task.task_id}:${scheduledFor}`,
    scheduled_for: scheduledFor,
    business_date: businessDateFor(scheduledFor, "UTC"),
    trigger_source: "automatic",
    next_run_at: options.nextRunAt === undefined ? scheduledFor + STEP_MS : options.nextRunAt,
    completes_once: options.completesOnce ?? false,
    snapshot_json: snapshot.json,
    snapshot_sha256: snapshot.sha256,
    context_json: "{}",
    // docs §8.2 claims fire only when the occurrence is due (next_run_at <= now).
    now: options.now ?? scheduledFor,
  };
}

async function count(store: SqliteStateStore, sql: string, params: string[] = []): Promise<number> {
  return Number((await store.get<{ count: number }>(sql, params))?.count ?? 0);
}

describe("scheduled tasks migration 0002", () => {
  it("creates the three tables with indexes and enforces CHECK/FK constraints", async () => {
    const state = await memStore();
    expect((await loadMigrations()).at(-1)?.name).toBe("0003_scheduled_tasks_product_layer.sql");
    const indexRows = await state.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'scheduled_task%' ORDER BY name",
    );
    expect(indexRows.map((row) => row.name)).toEqual([
      "scheduled_task_attempts_active_run_idx",
      "scheduled_task_attempts_lease_idx",
      "scheduled_task_attempts_outbox_idx",
      "scheduled_task_attempts_run_history_idx",
      "scheduled_task_runs_active_task_idx",
      "scheduled_task_runs_status_idx",
      "scheduled_task_runs_task_history_idx",
      "scheduled_tasks_due_idx",
      "scheduled_tasks_project_idx",
      "scheduled_tasks_workspace_idx",
    ]);
    await expect(state.run(
      "INSERT INTO scheduled_tasks (task_id, project_id, workspace_path, name, lifecycle_status, schedule_json, executor_kind, config_json, output_json, approval_scope_hash, retry_json, budget_json, created_at, updated_at) VALUES ('t', 'project_stask', '/w', 'n', 'archived', '{}', 'literature_digest', '{}', '{}', 'h', '{}', '{}', 1, 1)",
    )).rejects.toThrow();
    const repo = new ScheduledTaskRepository(state);
    const task = await seededTask(repo);
    // A terminal Run must not hold the active slot (materialized active-run CHECK).
    await expect(state.run(
      "INSERT INTO scheduled_task_runs (run_id, task_id, task_revision, trigger_source, scheduled_for, business_date, occurrence_key, status, active_slot, snapshot_json, snapshot_sha256, created_at, updated_at) VALUES ('r1', ?, 1, 'automatic', 1, '2027-01-15', 'k1', 'succeeded', 1, '{}', 'sha', 1, 1)",
      [task.task_id],
    )).rejects.toThrow();
    await expect(repo.insertTask(taskInput({ project_id: "project_missing", now: NOW + 1 }))).rejects.toThrow();
  });
});

describe("scheduled task repository", () => {
  it("inserts a task with revision 1, normalized schedule, scope hash, and armed next_run_at", async () => {
    const repo = new ScheduledTaskRepository(await memStore());
    const task = await seededTask(repo);
    expect(task.revision).toBe(1);
    expect(task.lifecycle_status).toBe("active");
    expect(task.schema_version).toBe(1);
    expect(task.schedule).toEqual(SCHEDULE);
    expect(task.approval.status).toBe("none");
    expect(task.approval.scope_hash).toHaveLength(64);
    expect(Date.parse(task.next_run_at!)).toBeGreaterThan(NOW);
    expect(Date.parse(task.created_at)).toBe(NOW);
    expect(await repo.countActiveTasksByWorkspace("/tmp/pi-science-stask-workspace")).toBe(1);
  });

  it("claims one occurrence atomically across two real workers and is idempotent per occurrence key", async () => {
    const [storeA, storeB] = await sharedFileStores();
    await seedProject(storeA);
    const repoA = new ScheduledTaskRepository(storeA);
    const repoB = new ScheduledTaskRepository(storeB);
    const task = await repoA.insertTask(taskInput());
    const expectedNextMs = Date.parse(task.next_run_at!);

    const outcomes = await Promise.all([
      repoA.claimOccurrence(claimInput(task, { runId: "srun_worker_a", attemptId: "satt_worker_a", executionId: "sexec_worker_a" })),
      repoB.claimOccurrence(claimInput(task, { runId: "srun_worker_b", attemptId: "satt_worker_b", executionId: "sexec_worker_b" })),
    ]);
    const claimed = outcomes.filter((outcome): outcome is Extract<ClaimOccurrenceResult, { status: "claimed" }> => outcome.status === "claimed");
    expect(claimed).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.status === "conflict")).toBe(true);

    expect(await count(storeA, "SELECT COUNT(*) AS count FROM scheduled_task_runs")).toBe(1);
    expect(await count(storeA, "SELECT COUNT(*) AS count FROM scheduled_task_run_attempts")).toBe(1);

    // The task advanced exactly once: to the caller-provided next occurrence, without a revision bump.
    const advanced = await repoA.getTask(task.task_id);
    expect(Date.parse(advanced!.next_run_at!)).toBe(expectedNextMs + STEP_MS);
    expect(advanced!.revision).toBe(1);
    expect(Date.parse(advanced!.last_scheduled_at!)).toBe(expectedNextMs);
    expect(advanced!.last_run_id).toMatch(/^srun_/);

    // Duplicate occurrence key never creates a second Run.
    const replay = await repoB.claimOccurrence(claimInput(advanced!, { occurrenceKey: `${task.task_id}:${expectedNextMs}`, runId: "srun_replay", attemptId: "satt_replay", executionId: "sexec_replay" }));
    expect(replay.status).toBe("already_claimed");
    expect(await count(storeA, "SELECT COUNT(*) AS count FROM scheduled_task_runs")).toBe(1);
    expect(await count(storeA, "SELECT COUNT(*) AS count FROM scheduled_task_run_attempts")).toBe(1);
  });

  it("rolls the whole claim back when the second stage fails, leaving run absent and next untouched", async () => {
    const repo = new ScheduledTaskRepository(await memStore());
    const donor = await seededTask(repo);
    const victim = await repo.insertTask(taskInput({ now: NOW + 5, name: "Victim" }));
    const donorClaim = await repo.claimOccurrence(claimInput(donor, { runId: "srun_donor", attemptId: "satt_shared", executionId: "sexec_donor" }));
    expect(donorClaim.status).toBe("claimed");

    const victimNextBefore = victim.next_run_at;
    // Reuse the donor attempt id: stage two hits its PRIMARY KEY and rolls back stage one.
    await expect(repo.claimOccurrence(claimInput(victim, { attemptId: "satt_shared", runId: "srun_victim", executionId: "sexec_victim" }))).rejects.toThrow();
    expect(await count((repo as unknown as { store: InMemorySqliteStateStore }).store, "SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ?", [victim.task_id])).toBe(0);
    expect((await repo.getTask(victim.task_id))!.next_run_at).toBe(victimNextBefore);
  });

  it("records an overlap-forbid skipped run without attempts and advances the task", async () => {
    const repo = new ScheduledTaskRepository(await memStore());
    const task = await seededTask(repo);
    const firstNextMs = Date.parse(task.next_run_at!);
    expect((await repo.claimOccurrence(claimInput(task))).status).toBe("claimed");

    const afterFirst = await repo.getTask(task.task_id);
    const skipScheduledFor = Date.parse(afterFirst!.next_run_at!);
    const skipSnapshot = snapshotFor(afterFirst!, skipScheduledFor);
    const skip = await repo.claimOccurrenceSkipped({
      task_id: task.task_id,
      expected_revision: afterFirst!.revision,
      expected_next_run_at: Date.parse(afterFirst!.next_run_at!),
      run_id: "srun_skipped",
      occurrence_key: `${task.task_id}:${afterFirst!.next_run_at}`,
      scheduled_for: skipScheduledFor,
      business_date: businessDateFor(skipScheduledFor, "UTC"),
      trigger_source: "automatic",
      next_run_at: skipScheduledFor + STEP_MS,
      completes_once: false,
      snapshot_json: skipSnapshot.json,
      snapshot_sha256: skipSnapshot.sha256,
      now: skipScheduledFor,
    });
    expect(skip?.status).toBe("skipped");
    expect(skip!.run.error_code).toBe("OVERLAP_FORBIDDEN");

    const finalTask = await repo.getTask(task.task_id);
    // Advanced twice: once by the real claim, once by the overlap skip.
    expect(Date.parse(finalTask!.next_run_at!)).toBe(firstNextMs + STEP_MS * 2);
    expect(await count((repo as unknown as { store: InMemorySqliteStateStore }).store, "SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE status = 'skipped'")).toBe(1);
    expect(await count((repo as unknown as { store: InMemorySqliteStateStore }).store, "SELECT COUNT(*) AS count FROM scheduled_task_run_attempts")).toBe(1);

    // No matching conditions → null instead of a partial write.
    const neverSnapshot = snapshotFor(finalTask!, 1);
    expect(await repo.claimOccurrenceSkipped({
      task_id: task.task_id,
      expected_revision: finalTask!.revision,
      expected_next_run_at: 1,
      run_id: "srun_never",
      occurrence_key: "never",
      scheduled_for: 1,
      business_date: "1970-01-01",
      trigger_source: "automatic",
      next_run_at: null,
      completes_once: false,
      snapshot_json: neverSnapshot.json,
      snapshot_sha256: neverSnapshot.sha256,
      now: NOW,
    })).toBeNull();
  });

  it("creates durable manual runs without touching automatic scheduling, and skips on overlap", async () => {
    const store = await memStore();
    const repo = new ScheduledTaskRepository(store);
    const task = await seededTask(repo);
    const automaticNext = task.next_run_at;

    const manual = await repo.createManualRun(task.task_id, NOW);
    expect(manual.status).toBe("created");
    expect(manual.run.trigger_source).toBe("manual");
    expect(manual.run.scheduled_for).toBe(new Date(NOW).toISOString());
    expect(manual.run.business_date).toBe(businessDateFor(NOW, "UTC"));
    expect(manual.attempt!.status).toBe("pending");
    expect(manual.run.snapshot.workspace_path_at_claim).toBe(task.workspace_path);
    expect(manual.run.occurrence_key).toContain(":manual:");
    expect((await repo.getTask(task.task_id))!.next_run_at).toBe(automaticNext);

    const overlap = await repo.createManualRun(task.task_id, NOW + 1);
    expect(overlap.status).toBe("skipped");
    expect(overlap.run.status).toBe("skipped");
    expect(overlap.attempt).toBeNull();
    expect(await count(store, "SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE status = 'pending'")).toBe(1);
    expect(await count(store, "SELECT COUNT(*) AS count FROM scheduled_task_run_attempts")).toBe(1);
    expect((await repo.getTask(task.task_id))!.next_run_at).toBe(automaticNext);

    // An active manual run also blocks the automatic claim (active_run_exists classification).
    const conflict = await repo.claimOccurrence(claimInput(task));
    expect(conflict).toEqual({ status: "conflict", reason: "active_run_exists" });
  });

  it("enforces optimistic revisions for patch and approve, resets approval only on scope changes", async () => {
    const repo = new ScheduledTaskRepository(await memStore());
    const task = await seededTask(repo);
    const scopeHash = task.approval.scope_hash;

    await expect(repo.patchTask(task.task_id, task.revision + 3, { name: "Too late" }, NOW)).rejects.toMatchObject({ code: "SCHEDULED_TASK_REVISION_CONFLICT" });
    await expect(repo.approveTask(task.task_id, task.revision + 3, scopeHash, [], [], NOW)).rejects.toMatchObject({ code: "SCHEDULED_TASK_REVISION_CONFLICT" });
    await expect(repo.approveTask(task.task_id, task.revision, `${scopeHash.slice(0, 8)}stale`, [], [], NOW)).rejects.toMatchObject({ code: "SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED" });
    const untouched = await repo.getTask(task.task_id);
    expect(untouched!.revision).toBe(1);
    expect(untouched!.name).toBe(task.name);
    expect(untouched!.approval.status).toBe("none");
    expect(untouched!.approval.scope_hash).toBe(scopeHash);

    const approved = await repo.approveTask(task.task_id, 1, scopeHash, ["genetics"], ["review"], NOW + 1);
    expect(approved.revision).toBe(1); // approve never bumps definition revision
    expect(approved.approval).toMatchObject({ status: "approved", categories: ["genetics"], terms: ["review"] });
    // Repeating the identical approve is idempotent: same row back, no writes.
    const repeat = await repo.approveTask(task.task_id, 1, scopeHash, ["genetics"], ["review"], NOW + 2);
    expect(repeat.revision).toBe(1);
    expect(repeat.approval.approved_at).toBe(approved.approval.approved_at);

    // Name-only patch keeps approval; revision bumps once.
    const renamed = await repo.patchTask(task.task_id, 1, { name: "Renamed" }, NOW + 3);
    expect(renamed.revision).toBe(2);
    expect(renamed.approval.status).toBe("approved");
    expect(renamed.approval.scope_hash).toBe(scopeHash);

    // Scope change recomputes hash and resets approval to none.
    const rescoped = await repo.patchTask(task.task_id, 2, { executor: { ...EXECUTOR, config: { ...EXECUTOR.config, query: "new query" } } }, NOW + 4);
    expect(rescoped.revision).toBe(3);
    expect(rescoped.approval.status).toBe("none");
    expect(rescoped.approval.scope_hash).not.toBe(scopeHash);

    // Schedule-only patch recomputes future next_run_at without resetting anything else.
    const rescheduled = await repo.patchTask(task.task_id, 3, { schedule: { ...SCHEDULE, every_seconds: 7200 } }, NOW + 5);
    expect(rescheduled.revision).toBe(4);
    expect(rescheduled.schedule).toEqual({ ...SCHEDULE, every_seconds: 7200 });
    expect(Date.parse(rescheduled.next_run_at!)).toBeGreaterThan(NOW + 5);
    expect(rescheduled.approval.status).toBe("none");
  });

  it("pauses, resumes, and soft-deletes with revision CAS and active-run protection", async () => {
    const repo = new ScheduledTaskRepository(await memStore());
    const task = await seededTask(repo);
    const paused = await repo.setTaskStatus(task.task_id, 1, "pause", NOW + 1);
    expect(paused.lifecycle_status).toBe("paused");
    expect(paused.next_run_at).toBeNull();

    const resumed = await repo.setTaskStatus(task.task_id, 2, "resume", NOW + 2);
    expect(resumed.lifecycle_status).toBe("active");
    expect(Date.parse(resumed.next_run_at!)).toBeGreaterThan(NOW + 2);

    const manual = await repo.createManualRun(task.task_id, NOW + 3);
    expect(manual.status).toBe("created");
    await expect(repo.setTaskStatus(task.task_id, 3, "delete", NOW + 4)).rejects.toMatchObject({ code: "TASK_HAS_ACTIVE_RUN" });

    const cancelled = await repo.requestCancel(manual.run.run_id, NOW + 5);
    expect(cancelled).toBe("cancelled");
    const deleted = await repo.setTaskStatus(task.task_id, 3, "delete", NOW + 6);
    expect(deleted.deleted_at).toBe(new Date(NOW + 6).toISOString());
    expect(deleted.next_run_at).toBeNull();
    expect(deleted.revision).toBe(4);
    // History stays readable after delete.
    expect(await repo.getRun(manual.run.run_id)).not.toBeNull();

    // A claimed once-task completes immediately; resume is refused (docs §5.11).
    const onceTask = await repo.insertTask(taskInput({ name: "once", schedule: { type: "once", at: new Date(NOW + STEP_MS * 2).toISOString(), timezone: "UTC" }, now: NOW + STEP_MS }));
    expect((await repo.claimOccurrence(claimInput(onceTask, { completesOnce: true, nextRunAt: null }))).status).toBe("claimed");
    const completed = await repo.getTask(onceTask.task_id);
    expect(completed!.lifecycle_status).toBe("completed");
    expect(completed!.next_run_at).toBeNull();
    await expect(repo.setTaskStatus(onceTask.task_id, 1, "resume", NOW + STEP_MS + 1)).rejects.toMatchObject({ code: "SCHEDULED_TASK_POLICY_VIOLATION" });
  });

  it("fences attempt leases between competing dispatchers, heartbeats, and stale owners", async () => {
    const [storeA, storeB] = await sharedFileStores();
    await seedProject(storeA);
    const repoA = new ScheduledTaskRepository(storeA);
    const repoB = new ScheduledTaskRepository(storeB);
    const task = await repoA.insertTask(taskInput());
    const manual = await repoA.createManualRun(task.task_id, NOW);
    const attemptId = manual.attempt!.attempt_id;

    const leases = await Promise.all([
      repoA.claimAttempt(attemptId, "instance-a", NOW, 30_000),
      repoB.claimAttempt(attemptId, "instance-b", NOW, 30_000),
    ]);
    const winners = leases.filter(Boolean);
    expect(winners).toHaveLength(1);
    const lease = winners[0]!;
    expect(lease.owner_generation).toBe(1);

    // Heartbeat extends only for the exact token+generation.
    expect(await repoB.heartbeatAttempt(attemptId, lease.owner_token, lease.owner_generation, NOW + 1_000, 30_000)).toBe(true);
    expect(await repoA.heartbeatAttempt(attemptId, "bogus-token", lease.owner_generation, NOW + 1_000, 30_000)).toBe(false);
    expect(await repoA.heartbeatAttempt(attemptId, lease.owner_token, lease.owner_generation + 5, NOW + 1_000, 30_000)).toBe(false);
    const heartbeat = await repoB.getAttempt(attemptId);
    expect(Date.parse(heartbeat!.lease_expires_at!)).toBe(NOW + 31_000);

    // Stale owner terminal write is rejected and leaves both states unchanged.
    expect(await repoA.finishAttempt(attemptId, "bogus-token", lease.owner_generation, { status: "succeeded", output_paths: ["a.json"] }, NOW + 2_000)).toBeNull();
    const stillRunning = await repoB.getAttempt(attemptId);
    expect(stillRunning!.status).toBe("running");
    expect(stillRunning!.owner_token).toBe(lease.owner_token);

    const finished = await repoB.finishAttempt(attemptId, lease.owner_token, lease.owner_generation, {
      status: "failed",
      outcome: "needs_attention",
      summary: { title: "Couldn’t complete the latest run", text: "Provider failed" },
      recommend_notify: true,
      error_code: "PROVIDER_FAILURE",
      output_paths: ["out/a.json"],
      usage: { tokens: 12 },
      retryable: true,
    }, NOW + 3_000);
    expect(finished!.status).toBe("failed");
    expect(finished!.ended_at).toBe(new Date(NOW + 3_000).toISOString());
    const runAfterFinish = await repoB.getRun(manual.run.run_id);
    expect(runAfterFinish).toMatchObject({
      status: "failed",
      outcome: "needs_attention",
      summary: { title: "Couldn’t complete the latest run", text: "Provider failed" },
      delivery: { policy: "only_when_relevant", delivered: true },
      error_code: "PROVIDER_FAILURE",
    });
    expect(runAfterFinish!.output_paths).toEqual(["out/a.json"]);
    expect(runAfterFinish!.latest_attempt_id).toBe(attemptId);

    const quietManual = await repoA.createManualRun(task.task_id, NOW + 4_000);
    const quietLease = await repoA.claimAttempt(quietManual.attempt!.attempt_id, "instance-a", NOW + 4_000, 30_000);
    await repoA.finishAttempt(quietManual.attempt!.attempt_id, quietLease!.owner_token, quietLease!.owner_generation, {
      status: "succeeded",
      outcome: "no_change",
      summary: { title: "No meaningful updates", item_count: 0 },
      recommend_notify: false,
    }, NOW + 5_000);
    expect(await repoA.getRun(quietManual.run.run_id)).toMatchObject({
      status: "succeeded",
      outcome: "no_change",
      summary: { title: "No meaningful updates", item_count: 0 },
      delivery: { policy: "only_when_relevant", delivered: false, suppressed_reason: "no_meaningful_change" },
    });
  });

  it("recovers expired leases into interrupted+retry or cancelled depending on cancel request and policy", async () => {
    const repo = new ScheduledTaskRepository(await memStore());
    const taskOne = await seededTask(repo, { name: "retry-me" });
    const manualOne = await repo.createManualRun(taskOne.task_id, NOW);
    const leaseOne = await repo.claimAttempt(manualOne.attempt!.attempt_id, "instance-a", NOW, 1_000);
    expect(leaseOne).not.toBeNull();
    const snapshotShaBefore = (await repo.getRun(manualOne.run.run_id))!.snapshot_sha256;
    const oldExecutionId = manualOne.attempt!.execution_id;

    const recovered = await repo.recoverExpiredLeases(NOW + 2_000, () => ({ execution_id: "sexec_retry_one", available_at: NOW + 2_500 }));
    expect(recovered).toEqual([{
      outcome: "retried",
      attempt_id: manualOne.attempt!.attempt_id,
      new_attempt_id: expect.any(String),
      run_id: manualOne.run.run_id,
      task_id: taskOne.task_id,
      execution_id: oldExecutionId,
      workspace_path: "/tmp/pi-science-stask-workspace",
    }]);
    const oldAttempt = await repo.getAttempt(manualOne.attempt!.attempt_id);
    expect(oldAttempt!.status).toBe("interrupted");
    expect(oldAttempt!.owner_token).toBe(leaseOne!.owner_token); // interrupted attempts keep owner evidence
    const retryAttempt = await repo.getAttempt(recovered[0]!.new_attempt_id!);
    expect(retryAttempt).toMatchObject({ status: "pending", attempt_no: 2, recovery_of_attempt_id: oldAttempt!.attempt_id, execution_id: "sexec_retry_one", available_at: new Date(NOW + 2_500).toISOString() });
    const retriedRun = await repo.getRun(manualOne.run.run_id);
    expect(retriedRun).toMatchObject({ status: "pending", outcome: null, summary: {}, delivery: null });
    expect(retriedRun!.snapshot_sha256).toBe(snapshotShaBefore); // same snapshot across retries
    expect(retriedRun!.latest_attempt_id).toBe(retryAttempt!.attempt_id);

    // Cancel-requested expired leases end cancelled without a retry.
    const taskTwo = await repo.insertTask(taskInput({ name: "cancel-me", now: NOW + 10 }));
    const manualTwo = await repo.createManualRun(taskTwo.task_id, NOW + 11);
    expect(await repo.claimAttempt(manualTwo.attempt!.attempt_id, "instance-a", NOW + 11, 1_000)).not.toBeNull();
    expect(await repo.requestCancel(manualTwo.run.run_id, NOW + 12)).toBe("requested");
    expect((await repo.getAttempt(manualTwo.attempt!.attempt_id))!.cancel_requested_at).toBe(new Date(NOW + 12).toISOString());

    const recoveredTwo = await repo.recoverExpiredLeases(NOW + 13_000);
    expect(recoveredTwo).toEqual([expect.objectContaining({ outcome: "cancelled", attempt_id: manualTwo.attempt!.attempt_id, run_id: manualTwo.run.run_id, task_id: taskTwo.task_id })]);
    expect((await repo.getAttempt(manualTwo.attempt!.attempt_id))!.status).toBe("cancelled");
    expect((await repo.getRun(manualTwo.run.run_id))!.status).toBe("cancelled");

    // Nothing left running → empty result; the retry attempt's outbox entry and
    // the second task's chain are all that remain.
    expect(await repo.recoverExpiredLeases(NOW + 14_000)).toEqual([]);
    expect(await repo.nearestDeadline()).toBe(Math.min(NOW + 2_500, Date.parse(taskTwo.next_run_at!)));
  });

  it("keeps nearestDeadline at the minimum of due task, pending outbox, and running lease", async () => {
    const repo = new ScheduledTaskRepository(await memStore());
    expect(await repo.nearestDeadline()).toBeNull();
    const task = await seededTask(repo);
    const taskDeadline = Date.parse(task.next_run_at!);
    expect(await repo.nearestDeadline()).toBe(taskDeadline);
    const manual = await repo.createManualRun(task.task_id, NOW);
    expect(await repo.nearestDeadline()).toBe(NOW); // pending attempt available_at
    const lease = await repo.claimAttempt(manual.attempt!.attempt_id, "instance-a", NOW, 45_000);
    expect(await repo.nearestDeadline()).toBe(Math.min(taskDeadline, NOW + 45_000)); // running lease vs task
    await repo.finishAttempt(manual.attempt!.attempt_id, lease!.owner_token, lease!.owner_generation, { status: "succeeded" }, NOW + 100);
    expect(await repo.nearestDeadline()).toBe(taskDeadline);
  });

  it("updates scheduled task workspace paths on moveLocation while snapshots keep the claim-time evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-stask-move-"));
    directories.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(join(source, ".pi-science"), { recursive: true });
    const store = await memStore();
    const workspaces = new WorkspaceRepository(store);
    const location = await workspaces.rememberWorkspace(source);
    const repo = new ScheduledTaskRepository(store);
    const task = await repo.insertTask(taskInput({ project_id: location.project_id, workspace_path: location.path }));
    const manual = await repo.createManualRun(task.task_id, NOW);

    await rename(source, destination);
    const canonicalDestination = await realpath(destination);
    await workspaces.moveLocation(location.project_id, location.path, canonicalDestination, true);

    const moved = await repo.getTask(task.task_id);
    expect(moved!.workspace_path).toBe(canonicalDestination);
    const run = await repo.getRun(manual.run.run_id);
    expect(run!.snapshot.workspace_path_at_claim).toBe(location.path); // historical evidence untouched
    expect(await repo.countActiveTasksByWorkspace(canonicalDestination)).toBe(1);
    expect(await repo.countActiveTasksByWorkspace(location.path)).toBe(0);
  });

  it("lists tasks with latest-run summaries, stable keyset pagination, and INVALID_CURSOR errors", async () => {
    const store = await memStore();
    const repo = new ScheduledTaskRepository(store);
    const taskOne = await seededTask(repo, { name: "one", now: NOW });
    const taskTwo = await repo.insertTask(taskInput({ name: "two", now: NOW + 1 }));
    const taskThree = await repo.insertTask(taskInput({ name: "three", now: NOW + 2 }));

    // taskThree gets a pending manual run; taskTwo a finished one; taskOne none.
    const manualThree = await repo.createManualRun(taskThree.task_id, NOW + 3);
    const manualTwo = await repo.createManualRun(taskTwo.task_id, NOW + 4);
    const leaseTwo = await repo.claimAttempt(manualTwo.attempt!.attempt_id, "instance-a", NOW + 5, 30_000);
    await repo.finishAttempt(manualTwo.attempt!.attempt_id, leaseTwo!.owner_token, leaseTwo!.owner_generation, { status: "succeeded", output_paths: ["two/report.md"] }, NOW + 6);

    const pageOne = await repo.listTasks({ limit: 2 });
    expect(pageOne.items.map((item) => item.task_id)).toEqual([taskThree.task_id, taskTwo.task_id]);
    expect(pageOne.next_cursor).toBeTruthy();
    expect(pageOne.items[0]).toMatchObject({
      task_id: taskThree.task_id,
      revision: 1,
      name: "three",
      lifecycle_status: "active",
      approval_status: "none",
    });
    expect(pageOne.items[0]!.schedule.type).toBe("interval");
    expect(pageOne.items[0]!.next_run_at).toBe(taskThree.next_run_at);
    expect(pageOne.items[0]!.latest_run).toMatchObject({ run_id: manualThree.run.run_id, status: "pending", latest_attempt_id: manualThree.attempt!.attempt_id });
    expect(pageOne.items[1]!.latest_run).toMatchObject({ run_id: manualTwo.run.run_id, status: "succeeded", ended_at: new Date(NOW + 6).toISOString(), latest_attempt_id: manualTwo.attempt!.attempt_id });
    expect(typeof pageOne.items[1]!.latest_run!.execution_id).toBe("string");

    const pageTwo = await repo.listTasks({ limit: 2, cursor: pageOne.next_cursor });
    expect(pageTwo.items.map((item) => item.task_id)).toEqual([taskOne.task_id]);
    expect(pageTwo.items[0]!.latest_run).toBeNull();
    expect(pageTwo.next_cursor).toBeNull();

    const filtered = await repo.listTasks({ projectId: "project_stask", workspacePath: "/nowhere" });
    expect(filtered.items).toEqual([]);

    for (const badCursor of ["not-base64!!", Buffer.from("[1,2]").toString("base64url"), Buffer.from('{"c":"x","t":1}').toString("base64url"), Buffer.from("{}").toString("base64url")]) {
      await expect(repo.listTasks({ cursor: badCursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    }
    await expect(repo.listRuns(taskOne.task_id, { cursor: "%%%" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(repo.listAttempts("missing", { cursor: Buffer.from('{"n":"x"}').toString("base64url") })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("pages runs and attempts with keyset cursors over stable ordering", async () => {
    const store = await memStore();
    const repo = new ScheduledTaskRepository(store);
    const task = await seededTask(repo);
    const first = await repo.createManualRun(task.task_id, NOW);
    const leaseFirst = await repo.claimAttempt(first.attempt!.attempt_id, "instance-a", NOW + 1, 30_000);
    await repo.finishAttempt(first.attempt!.attempt_id, leaseFirst!.owner_token, leaseFirst!.owner_generation, { status: "succeeded" }, NOW + 2);
    const second = await repo.createManualRun(task.task_id, NOW + 3);

    const runsPageOne = await repo.listRuns(task.task_id, { limit: 1 });
    expect(runsPageOne.items.map((run) => run.run_id)).toEqual([second.run.run_id]);
    expect(runsPageOne.next_cursor).toBeTruthy();
    const runsPageTwo = await repo.listRuns(task.task_id, { limit: 1, cursor: runsPageOne.next_cursor });
    expect(runsPageTwo.items.map((run) => run.run_id)).toEqual([first.run.run_id]);
    expect(runsPageTwo.next_cursor).toBeNull();
    const allAttempts = await repo.listAttempts(second.run.run_id);
    expect(allAttempts.items.map((attempt) => attempt.attempt_no)).toEqual([1]);
    expect(allAttempts.next_cursor).toBeNull(); // single page under default limit

    // Retry chain appends attempt_no=2 under UNIQUE(run_id, attempt_no); the
    // finished run returns to pending for the outbox.
    // Another run of the same task still holds the active slot → refused cleanly.
    await expect(repo.insertRetryAttempt(first.run.run_id, first.attempt!.attempt_id, { execution_id: "sexec_blocked", available_at: NOW + 8 }, NOW + 8)).rejects.toMatchObject({ code: "SQLITE_EXPECT_CHANGES" });
    expect(await repo.requestCancel(second.run.run_id, NOW + 8)).toBe("cancelled");
    const retried = await repo.insertRetryAttempt(first.run.run_id, first.attempt!.attempt_id, { execution_id: "sexec_retry_page", available_at: NOW + 9 }, NOW + 9);
    expect(retried.attempt_no).toBe(2);
    expect(retried.recovery_of_attempt_id).toBe(first.attempt!.attempt_id);
    expect((await repo.getRun(first.run.run_id))!.status).toBe("pending");
    await expect(repo.insertRetryAttempt(first.run.run_id, first.attempt!.attempt_id, { execution_id: "sexec_double", available_at: NOW + 10 }, NOW + 10)).rejects.toThrow();
    const attemptsAfterRetryPageOne = await repo.listAttempts(first.run.run_id, { limit: 1 });
    expect(attemptsAfterRetryPageOne.items.map((attempt) => attempt.attempt_no)).toEqual([2]);
    expect(attemptsAfterRetryPageOne.next_cursor).toBeTruthy();
    const attemptsAfterRetryPageTwo = await repo.listAttempts(first.run.run_id, { limit: 1, cursor: attemptsAfterRetryPageOne.next_cursor });
    expect(attemptsAfterRetryPageTwo.items.map((attempt) => attempt.attempt_no)).toEqual([1]);
    expect(attemptsAfterRetryPageTwo.next_cursor).toBeNull();
  });
});
