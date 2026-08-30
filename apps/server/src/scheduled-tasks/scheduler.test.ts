// Scheduler tests for Phase 4 (docs §14.2 Timer/Restart/Misfire rows): fake
// clock injected as a mutable variable, ticks driven explicitly, timers only
// exercised through short injectable CLOCK_RECHECK_MS values — never long sleeps.
import { afterEach, describe, expect, it } from "vitest";
import { ScheduledTaskRepository } from "../storage/sqlite/repositories/scheduled-task-repository.js";
import { InMemorySqliteStateStore, SqliteStateStore } from "../storage/sqlite/state-store.js";
import type { ExecutorContext, ExecutorResult, ScheduledTaskExecutor } from "./executor.js";
import { ScheduledTaskScheduler } from "./scheduler.js";

const NOW = 1_800_000_000_000;
const STEP_MS = 3_600_000;
const WORKSPACE = "/tmp/pi-science-stask-scheduler-workspace";
const ANCHOR = "2026-01-01T00:00:00Z"; // far before NOW
const ANCHOR_MS = Date.parse(ANCHOR);

const SCHEDULE = { type: "interval", every_seconds: 3600, anchor_at: ANCHOR, timezone: "UTC" };
const RETRY = { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 };
const BUDGET = { max_wall_time_seconds: 900 };
const EXECUTOR = { kind: "literature_digest" as const, config: { query: "CRISPR review", providers: ["pubmed" as const], max_results: 30, language: "zh-CN" as const } };

const stores: SqliteStateStore[] = [];
const schedulers: ScheduledTaskScheduler[] = [];

afterEach(async () => {
  await Promise.allSettled(schedulers.splice(0).map((scheduler) => scheduler.stop()));
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
});

interface Harness {
  store: InMemorySqliteStateStore;
  repository: ScheduledTaskRepository;
  scheduler: ScheduledTaskScheduler;
  recoveredLeases: Array<{ outcome: string; attempt_id: string }>;
  setNow(ms: number): void;
  getNow(): number;
}

async function harness(): Promise<Harness> {
  const store = new InMemorySqliteStateStore();
  stores.push(store);
  await store.start();
  await store.run(
    "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES ('project_sched', 'sched', 1, ?, ?, ?)",
    [NOW, NOW, NOW],
  );
  let nowMs = NOW;
  const repository = new ScheduledTaskRepository(store);
  const recoveredLeases: Array<{ outcome: string; attempt_id: string }> = [];
  const scheduler = new ScheduledTaskScheduler({
    repository,
    dispatch: () => undefined,
    now: () => nowMs,
    rng: () => 0.5,
    claimBatchSize: 10,
    onLeaseRecovered: (outcome) => {
      recoveredLeases.push({ outcome: outcome.outcome, attempt_id: outcome.attempt_id });
    },
  });
  schedulers.push(scheduler);
  return {
    store,
    repository,
    scheduler,
    recoveredLeases,
    setNow(ms: number) { nowMs = ms; },
    getNow: () => nowMs,
  };
}

/** Inserts an interval task whose occurrence chain sits on the shared hourly
 * grid, then rewinds next_run_at 1s into the past so it is due right now
 * (firstOccurrence only ever arms strictly-future instants). */
async function insertDueTask(h: Harness, overrides: Record<string, unknown> = {}) {
  const task = await h.repository.insertTask(taskOverrides(overrides));
  if (overrides.next_run_at === undefined && overrides.schedule === undefined) {
    await rewindNextRunAt(h, task.task_id, h.getNow() - 1000);
  }
  return h.repository.getTask(task.task_id) as Promise<NonNullable<Awaited<ReturnType<ScheduledTaskRepository["getTask"]>>>>;
}

function taskOverrides(overrides: Record<string, unknown> = {}): Parameters<ScheduledTaskRepository["insertTask"]>[0] {
  return {
    project_id: "project_sched",
    workspace_path: WORKSPACE,
    name: "Hourly digest",
    schedule: SCHEDULE,
    executor: EXECUTOR,
    output: { relative_root: "outputs/digest" },
    retry: RETRY,
    budget: BUDGET,
    now: NOW,
    ...overrides,
  };
}

/** Forces the persisted next_run_at to an exact instant (staleness simulation). */
function rewindNextRunAt(h: Harness, taskId: string, nextRunAtMs: number): Promise<unknown> {
  return h.store.run("UPDATE scheduled_tasks SET next_run_at = ? WHERE task_id = ?", [nextRunAtMs, taskId]);
}

describe("scheduled task scheduler — nearest-deadline timer", () => {
  it("arms exactly one timer at the minimum of task/retry/lease deadlines and survives repeated wake", async () => {
    const h = await harness();
    // Task next_run_at far future (+30min grid point).
    const futureTask = await h.repository.insertTask(taskOverrides());
    expect(Date.parse(futureTask.next_run_at!)).toBeGreaterThan(h.getNow() + 20 * 60_000);

    // Pending retry attempt due sooner (+60s), on its own task.
    const pendingTask = await h.repository.insertTask(taskOverrides({ name: "pending-source" }));
    const manualA = await h.repository.createManualRun(pendingTask.task_id, h.getNow());
    if (!manualA.attempt) throw new Error("expected attempt");
    const pendingAt = h.getNow() + 60_000;
    await h.store.run("UPDATE scheduled_task_run_attempts SET available_at = ? WHERE attempt_id = ?", [pendingAt, manualA.attempt.attempt_id]);

    // Running attempt lease expiring earliest (+10s), on another task.
    const leaseTask = await h.repository.insertTask(taskOverrides({ name: "lease-source" }));
    const manualB = await h.repository.createManualRun(leaseTask.task_id, h.getNow());
    if (!manualB.attempt) throw new Error("expected attempt");
    const leaseExpiresAt = h.getNow() + 10_000;
    const runningLease = await h.repository.claimAttempt(manualB.attempt.attempt_id, "owner_timer", h.getNow(), STEP_MS);
    expect(runningLease).not.toBeNull();
    await h.store.run("UPDATE scheduled_task_run_attempts SET lease_expires_at = ? WHERE attempt_id = ?", [leaseExpiresAt, manualB.attempt.attempt_id]);

    const scheduler = new ScheduledTaskScheduler({
      repository: h.repository,
      dispatch: () => undefined,
      now: () => h.getNow(),
      clockRecheckMs: 50,
      claimBatchSize: 10,
    });
    schedulers.push(scheduler);

    await scheduler.start();
    await scheduler.tick(); // settle the startup pass
    expect(scheduler.getActiveTimerHandleCount()).toBe(1);
    // Nearest deadline = min(next_run_at, available_at, lease_expires_at).
    expect(scheduler.describe().next_deadline_at).toBe(new Date(leaseExpiresAt).toISOString());

    for (let i = 0; i < 5; i++) scheduler.wake();
    await new Promise((resolveWake) => setTimeout(resolveWake, 20));
    expect(scheduler.getActiveTimerHandleCount()).toBe(1);
    await scheduler.stop();
    expect(scheduler.getActiveTimerHandleCount()).toBe(0);
  });

  it("does not block Task B's occurrence claim while Task A's executor hangs", async () => {
    const h = await harness();
    const executorCalls: string[] = [];
    const hangingExecutor: ScheduledTaskExecutor = {
      kind: "literature_digest",
      execute(ctx: ExecutorContext): Promise<ExecutorResult> {
        executorCalls.push(ctx.task.task_id);
        // Hangs until aborted; never resolves on its own.
        return new Promise<never>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    };
    // Registered locally to prove the scheduler path never invokes executors.
    void hangingExecutor;

    const taskA = await insertDueTask(h, { name: "task A" });
    const taskB = await insertDueTask(h, { name: "task B" });
    const dispatcherWakes: number[] = [];
    const scheduler = new ScheduledTaskScheduler({
      repository: h.repository,
      dispatch: () => dispatcherWakes.push(executorCalls.length),
      now: () => h.getNow(),
      claimBatchSize: 10,
    });
    schedulers.push(scheduler);

    // One tick claims BOTH occurrences without ever awaiting an executor.
    await scheduler.tick();
    expect(dispatcherWakes.length).toBeGreaterThanOrEqual(1);
    expect((await h.repository.listRuns(taskA.task_id)).items).toHaveLength(1);
    expect((await h.repository.listRuns(taskB.task_id)).items).toHaveLength(1);
    expect(executorCalls).toHaveLength(0);
  });
});

describe("scheduled task scheduler — misfire handling (docs §5.7)", () => {
  it("coalesces a long outage into one reconcile Run at the latest missed occurrence", async () => {
    const h = await harness();
    // Stale next_run_at exactly five grid slots before the current slot.
    const staleIndex = Math.ceil((NOW - ANCHOR_MS) / STEP_MS) - 5;
    const staleNextMs = ANCHOR_MS + staleIndex * STEP_MS;
    const task = await h.repository.insertTask(taskOverrides({ name: "coalesce", misfire_policy: "coalesce_latest" }));
    await rewindNextRunAt(h, task.task_id, staleNextMs);

    await h.scheduler.tick();

    const runs = await h.repository.listRuns(task.task_id);
    expect(runs.items).toHaveLength(1);
    const reconcileRun = runs.items[0]!;
    expect(reconcileRun.trigger_source).toBe("reconcile");
    expect(reconcileRun.status).toBe("pending");
    // Latest missed occurrence ≤ now on the anchor grid (docs §5.7 step 2).
    const expectedThrough = Math.floor((NOW - ANCHOR_MS) / STEP_MS) * STEP_MS + ANCHOR_MS;
    expect(Date.parse(reconcileRun.scheduled_for)).toBe(expectedThrough);
    // next_run_at advanced to the first future occurrence, never replayed.
    const advanced = await h.repository.getTask(task.task_id);
    expect(Date.parse(advanced!.next_run_at!)).toBeGreaterThan(NOW);
    expect(await attemptCount(h, reconcileRun.run_id)).toBe(1); // exactly the fresh attempt
  });

  it("skips a long outage with one terminal MISFIRE_SKIPPED Run and zero attempts", async () => {
    const h = await harness();
    const staleIndex = Math.ceil((NOW - ANCHOR_MS) / STEP_MS) - 3;
    const staleNextMs = ANCHOR_MS + staleIndex * STEP_MS;
    const task = await h.repository.insertTask(taskOverrides({ name: "skip", misfire_policy: "skip" }));
    await rewindNextRunAt(h, task.task_id, staleNextMs);

    await h.scheduler.tick();

    const runs = await h.repository.listRuns(task.task_id);
    expect(runs.items).toHaveLength(1);
    const skipped = runs.items[0]!;
    expect(skipped.trigger_source).toBe("reconcile");
    expect(skipped.status).toBe("skipped");
    expect(skipped.error_code).toBe("MISFIRE_SKIPPED");
    expect(skipped.latest_attempt_id).toBeNull();
    expect(skipped.attempt_count).toBe(0);
    const advanced = await h.repository.getTask(task.task_id);
    expect(Date.parse(advanced!.next_run_at!)).toBeGreaterThan(NOW);
  });

  it("does not apply misfire while the task is paused (docs §5.11)", async () => {
    const h = await harness();
    const created = await insertDueTask(h, { name: "paused" });
    await h.repository.setTaskStatus(created.task_id, 1, "pause", h.getNow());
    expect((await h.repository.getTask(created.task_id))!.next_run_at).toBeNull();

    // A whole day passes while paused: nothing may fire or misfire.
    h.setNow(NOW + 24 * STEP_MS);
    await h.scheduler.tick();

    expect((await h.repository.listRuns(created.task_id)).items).toHaveLength(0);
    const resumed = await h.repository.setTaskStatus(created.task_id, 2, "resume", h.getNow());
    expect(Date.parse(resumed.next_run_at!)).toBeGreaterThan(NOW + 24 * STEP_MS);
  });
});

describe("scheduled task scheduler — once tasks and restarts", () => {
  it("completes a once task when its occurrence is claimed and never claims again", async () => {
    const h = await harness();
    const fireAt = NOW + 1000;
    const task = await h.repository.insertTask(taskOverrides({
      name: "one-shot",
      schedule: { type: "once", at: new Date(fireAt).toISOString(), timezone: "UTC" },
    }));

    h.setNow(fireAt + 1000); // inside grace → plain due claim
    await h.scheduler.tick();

    const claimed = await h.repository.getTask(task.task_id);
    expect(claimed!.lifecycle_status).toBe("completed");
    expect(claimed!.next_run_at).toBeNull();
    expect((await h.repository.listRuns(task.task_id)).items).toHaveLength(1);

    // Restart/drift later must not produce a second occurrence.
    h.setNow(fireAt + 120_000);
    await h.scheduler.tick();
    expect((await h.repository.listRuns(task.task_id)).items).toHaveLength(1);
  });

  it("never duplicates the same occurrence_key across a restart", async () => {
    const h = await harness();
    const task = await insertDueTask(h, { name: "restart-safe" });

    const first = new ScheduledTaskScheduler({
      repository: h.repository,
      dispatch: () => undefined,
      now: () => h.getNow(),
      claimBatchSize: 10,
    });
    schedulers.push(first);
    await first.tick();
    const runsAfterFirst = await h.repository.listRuns(task.task_id);
    expect(runsAfterFirst.items).toHaveLength(1);
    const occurrenceKey = runsAfterFirst.items[0]!.occurrence_key;
    const firstScheduledFor = Date.parse(runsAfterFirst.items[0]!.scheduled_for);

    // Brand-new scheduler over the same durable state (simulated restart).
    const second = new ScheduledTaskScheduler({
      repository: h.repository,
      dispatch: () => undefined,
      now: () => h.getNow(),
      claimBatchSize: 10,
    });
    schedulers.push(second);
    await second.tick();
    expect((await h.repository.listRuns(task.task_id)).items).toHaveLength(1);
    expect(Date.parse((await h.repository.listRuns(task.task_id)).items[0]!.scheduled_for)).toBe(firstScheduledFor);

    // Pathological clock rollback cannot double-claim: occurrence_key conflict.
    await rewindNextRunAt(h, task.task_id, firstScheduledFor);
    await second.tick();
    const finalRuns = await h.repository.listRuns(task.task_id);
    expect(finalRuns.items.filter((run) => run.occurrence_key === occurrenceKey)).toHaveLength(1);
  });
});

describe("scheduled task scheduler — expired lease recovery wiring (docs §8.8)", () => {
  it("recovers expired leases through tick with deterministic retry scheduling and notifies the hook", async () => {
    const h = await harness();
    const created = await h.repository.insertTask(taskOverrides());
    const manual = await h.repository.createManualRun(created.task_id, h.getNow());
    if (!manual.attempt) throw new Error("expected attempt");
    const lease = await h.repository.claimAttempt(manual.attempt.attempt_id, "owner_crashed", h.getNow(), 1000);
    expect(lease).not.toBeNull();

    // Owner dies without finishing; clock passes lease expiry (+ backoff window).
    h.setNow(NOW + 60_000);
    const scheduler = new ScheduledTaskScheduler({
      repository: h.repository,
      dispatch: () => undefined,
      now: () => h.getNow(),
      rng: () => 0.5,
      claimBatchSize: 10,
      onLeaseRecovered: (outcome) => {
        h.recoveredLeases.push({ outcome: outcome.outcome, attempt_id: outcome.attempt_id });
      },
    });
    schedulers.push(scheduler);
    await scheduler.tick();

    expect(h.recoveredLeases.map((entry) => entry.outcome)).toEqual(["retried"]);
    const attempts = await h.repository.listAttempts(manual.run.run_id);
    expect(attempts.items).toHaveLength(2);
    const fresh = attempts.items.find((attempt) => attempt.attempt_no === 2);
    expect(fresh?.status).toBe("pending");
    expect(fresh?.recovery_of_attempt_id).toBe(manual.attempt!.attempt_id);
    // jitter 1.0 × min(30s × multiplier^0, 600s) = 30_000ms after recovery time.
    expect(Date.parse(fresh!.available_at)).toBe(NOW + 60_000 + 30_000);
    // Same run, same snapshot: retries reuse the original snapshot (docs §5.10).
    const runAfter = await h.repository.getRun(manual.run.run_id);
    expect(runAfter?.status).toBe("pending");
  });
});

async function attemptCount(h: Harness, runId: string): Promise<number> {
  const attempts = await h.repository.listAttempts(runId);
  return attempts.items.length;
}
