// Dispatcher tests for Phase 4 (docs §14.2 Attempt/Lease/Restart rows): fenced
// claiming, heartbeat renewal, cancellation, outbox draining after restart,
// bounded parallelism and retryable-failure backoff. Real timers with tiny
// injectable heartbeat/lease values — no long sleeps anywhere.
import { afterEach, describe, expect, it } from "vitest";
import { ScheduledTaskRepository } from "../storage/sqlite/repositories/scheduled-task-repository.js";
import { InMemorySqliteStateStore, SqliteStateStore } from "../storage/sqlite/state-store.js";
import { ExecutorRegistry, FakeExecutor, type ExecutorContext, type ScheduledTaskExecutor } from "./executor.js";
import { ScheduledTaskDispatcher } from "./dispatcher.js";

const NOW = 1_800_000_000_000;
const WORKSPACE = "/tmp/pi-science-stask-dispatcher-workspace";

const SCHEDULE = { type: "interval", every_seconds: 3600, anchor_at: "2026-01-01T00:00:00Z", timezone: "UTC" };
const RETRY = { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 };
const BUDGET = { max_wall_time_seconds: 900 };
const EXECUTOR_CONFIG = { kind: "literature_digest" as const, config: { query: "CRISPR review", providers: ["pubmed" as const], max_results: 30, language: "zh-CN" as const } };

const stores: SqliteStateStore[] = [];
const dispatchers: ScheduledTaskDispatcher[] = [];

afterEach(async () => {
  await Promise.allSettled(dispatchers.splice(0).map((dispatcher) => dispatcher.shutdown()));
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
});

interface Harness {
  store: InMemorySqliteStateStore;
  repository: ScheduledTaskRepository;
  registry: ExecutorRegistry;
  rngValues: number[];
  setNow(ms: number): void;
  getNow(): number;
}

async function harness(): Promise<Harness> {
  const store = new InMemorySqliteStateStore();
  stores.push(store);
  await store.start();
  await store.run(
    "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES ('project_disp', 'disp', 1, ?, ?, ?)",
    [NOW, NOW, NOW],
  );
  let nowMs = NOW;
  const rngValues: number[] = [];
  return {
    store,
    repository: new ScheduledTaskRepository(store),
    registry: new ExecutorRegistry(),
    rngValues,
    setNow(ms: number) { nowMs = ms; },
    getNow: () => nowMs,
  };
}

function makeDispatcher(h: Harness, overrides: Partial<ConstructorParameters<typeof ScheduledTaskDispatcher>[0]> = {}): ScheduledTaskDispatcher {
  const dispatcher = new ScheduledTaskDispatcher({
    repository: h.repository,
    registry: h.registry,
    now: () => h.getNow(),
    heartbeatMs: 10,
    leaseMs: 2000,
    rng: () => h.rngValues.shift() ?? 0.5,
    ...overrides,
  });
  dispatchers.push(dispatcher);
  return dispatcher;
}

/** One durable pending attempt via a manual run — the crash-safe outbox entry. */
async function pendingOutboxEntry(h: Harness, name: string, atMs = h.getNow()) {
  const task = await h.repository.insertTask({
    project_id: "project_disp",
    workspace_path: WORKSPACE,
    name,
    schedule: SCHEDULE,
    executor: EXECUTOR_CONFIG,
    output: { relative_root: "outputs/digest" },
    retry: RETRY,
    budget: BUDGET,
    now: atMs,
  });
  const manual = await h.repository.createManualRun(task.task_id, atMs);
  if (manual.status !== "created" || !manual.attempt) throw new Error(`expected durable attempt for ${name}`);
  return { task, run: manual.run, attempt: manual.attempt };
}

/** Polls until fn yields a truthy value; bounded to keep wall clock tiny. */
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
  }
}

describe("scheduled task dispatcher — owner fencing", () => {
  it("lets exactly one of two dispatchers own and finish the same attempt", async () => {
    const h = await harness();
    const fake = new FakeExecutor();
    h.registry.register(fake);
    const { attempt } = await pendingOutboxEntry(h, "contested");

    const first = makeDispatcher(h, { ownerInstanceId: "owner_first" });
    const second = makeDispatcher(h, { ownerInstanceId: "owner_second" });
    await Promise.all([first.drainAvailable(), second.drainAvailable()]);

    await waitFor(() => (fake.calls.length === 1 ? true : null));
    await waitFor(async () => (await h.repository.getAttempt(attempt.attempt_id))?.status === "succeeded");
    expect(fake.calls).toHaveLength(1);
    expect((await h.repository.listAttempts(attempt.run_id)).items.filter((row) => row.owner_instance_id !== null)).toHaveLength(1);

    // Second dispatcher must not have executed anything else either.
    expect(first.getActiveCount() + second.getActiveCount()).toBe(0);
  });

  it("renews leases only for the live token; stale tokens cannot heartbeat or finish", async () => {
    const h = await harness();
    const { attempt } = await pendingOutboxEntry(h, "fenced");
    const lease = await h.repository.claimAttempt(attempt.attempt_id, "owner_a", h.getNow(), 1000);
    if (!lease) throw new Error("claim failed");

    expect(await h.repository.heartbeatAttempt(attempt.attempt_id, "wrong-token", lease.owner_generation, h.getNow() + 10, 1000)).toBe(false);
    expect(await h.repository.heartbeatAttempt(attempt.attempt_id, lease.owner_token, lease.owner_generation, h.getNow() + 10, 1000)).toBe(true);
    const renewed = await h.repository.getAttempt(attempt.attempt_id);
    expect(Date.parse(renewed!.lease_expires_at!)).toBe(h.getNow() + 10 + 1000);

    // Stale owner cannot write the terminal state…
    const staleFinish = await h.repository.finishAttempt(attempt.attempt_id, "wrong-token", lease.owner_generation, { status: "succeeded" }, h.getNow() + 20);
    expect(staleFinish).toBeNull();
    // …and the live owner's fenced write succeeds.
    const finish = await h.repository.finishAttempt(attempt.attempt_id, lease.owner_token, lease.owner_generation, { status: "failed", error_code: "PROVIDER_500" }, h.getNow() + 20);
    expect(finish?.status).toBe("failed");
  });

  it("marks an expired lease interrupted and rejects the old owner afterwards", async () => {
    const h = await harness();
    const { run, attempt } = await pendingOutboxEntry(h, "crashed-owner");
    const lease = await h.repository.claimAttempt(attempt.attempt_id, "owner_dead", h.getNow(), 50);
    if (!lease) throw new Error("claim failed");
    h.setNow(h.getNow() + 500); // lease long expired, no renewal

    const outcomes = await h.repository.recoverExpiredLeases(h.getNow());
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["interrupted"]);
    const interrupted = await h.repository.getAttempt(attempt.attempt_id);
    expect(interrupted!.status).toBe("interrupted");
    const runAfter = await h.repository.getRun(run.run_id);
    expect(runAfter!.status).toBe("interrupted");
    // Snapshot untouched by recovery (docs §5.10 retries reuse the original snapshot).
    expect(runAfter!.snapshot_sha256).toBe(run.snapshot_sha256);

    // The dead owner surfaces late and must be rejected by fencing.
    const lateFinish = await h.repository.finishAttempt(attempt.attempt_id, lease.owner_token, lease.owner_generation, { status: "succeeded" }, h.getNow());
    expect(lateFinish).toBeNull();
  });
});

describe("scheduled task dispatcher — execution flow", () => {
  it("aborts the executor on cancel_requested_at and writes a cancelled terminal state", async () => {
    const h = await harness();
    let seenContext: ExecutorContext | null = null;
    const fake = new FakeExecutor({ hangUntilAbort: true, onExecute: (ctx) => { seenContext = ctx; } });
    h.registry.register(fake);
    const { run, attempt } = await pendingOutboxEntry(h, "cancellable");

    const dispatcher = makeDispatcher(h);
    dispatcher.wake();
    await waitFor(() => (seenContext ? true : null));
    expect(seenContext!.signal.aborted).toBe(false);

    const requested = await h.repository.requestCancel(run.run_id, h.getNow());
    expect(requested).toBe("requested");

    await waitFor(async () => (await h.repository.getAttempt(attempt.attempt_id))?.status === "cancelled");
    expect(seenContext!.signal.aborted).toBe(true);
    const runAfter = await h.repository.getRun(run.run_id);
    expect(runAfter!.status).toBe("cancelled");
    expect(runAfter!.error_code).toBe("CANCELLED");
    // Cancellation never spawns retry attempts (docs §12.4).
    expect((await h.repository.listAttempts(run.run_id)).items).toHaveLength(1);
    await dispatcher.shutdown();
  });

  it("drains the durable pending outbox after a simulated restart", async () => {
    const h = await harness();
    const fake = new FakeExecutor();
    h.registry.register(fake);
    const { attempt } = await pendingOutboxEntry(h, "post-crash");
    // Nothing runs until a dispatcher appears (the pre-restart world).
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 30));
    expect(fake.calls).toHaveLength(0);

    const restarted = makeDispatcher(h, { ownerInstanceId: "owner_restarted" });
    await restarted.drainAvailable();
    await waitFor(async () => (await h.repository.getAttempt(attempt.attempt_id))?.status === "succeeded");
    expect((await h.repository.getRun(attempt.run_id))!.status).toBe("succeeded");
  });

  it("holds a third attempt in the outbox while max_parallel=2 slots are busy", async () => {
    const h = await harness();
    const startedTasks: string[] = [];
    const releaseFns = new Map<string, () => void>();
    const gatedExecutor: ScheduledTaskExecutor = {
      kind: "literature_digest",
      async execute(ctx: ExecutorContext) {
        startedTasks.push(ctx.task.task_id);
        // Gate release OR abort must both unwind the executor promise.
        await new Promise<void>((resolveGate, rejectGate) => {
          releaseFns.set(ctx.task.task_id, () => resolveGate());
          ctx.signal.addEventListener("abort", () => rejectGate(new Error("aborted")), { once: true });
        });
        return { status: "succeeded" as const };
      },
    };
    h.registry.register(gatedExecutor);

    const a = await pendingOutboxEntry(h, "A", h.getNow());
    const b = await pendingOutboxEntry(h, "B", h.getNow() + 1);
    const c = await pendingOutboxEntry(h, "C", h.getNow() + 2);
    // Make all three available while preserving the deterministic available_at order.
    h.setNow(h.getNow() + 1000);

    const dispatcher = makeDispatcher(h, { maxParallel: 2 });
    await dispatcher.drainAvailable();

    // Exactly the two oldest attempts run; C stays pending in the outbox.
    await waitFor(() => (startedTasks.length === 2 ? true : null));
    expect(new Set(startedTasks)).toEqual(new Set([a.task.task_id, b.task.task_id]));
    expect((await h.repository.getAttempt(c.attempt.attempt_id))!.status).toBe("pending");
    expect(dispatcher.getActiveCount()).toBe(2);

    // Freeing one slot wakes the dispatcher, which claims C immediately.
    releaseFns.get(a.task.task_id)!();
    await waitFor(() => startedTasks.includes(c.task.task_id));
    expect(startedTasks.length).toBe(3);

    releaseFns.get(b.task.task_id)!();
    releaseFns.get(c.task.task_id)!();
    await waitFor(async () => (await h.repository.getAttempt(c.attempt.attempt_id))?.status === "succeeded");
    await dispatcher.shutdown();
  });

  it("fails non-retryably with EXECUTOR_UNAVAILABLE when no executor is registered", async () => {
    const h = await harness();
    const { run, attempt } = await pendingOutboxEntry(h, "no-executor");
    const dispatcher = makeDispatcher(h);
    await dispatcher.drainAvailable();
    const done = await waitFor(async () => {
      const row = await h.repository.getAttempt(attempt.attempt_id);
      return row?.status === "failed" ? row : undefined;
    });
    expect(done!.error_code).toBe("EXECUTOR_UNAVAILABLE");
    expect((await h.repository.getRun(run.run_id))!.error_code).toBe("EXECUTOR_UNAVAILABLE");
    // Non-retryable ⇒ no second attempt even though the policy allows one.
    expect((await h.repository.listAttempts(run.run_id)).items).toHaveLength(1);
  });

  it("schedules a jittered retry attempt after a retryable executor throw", async () => {
    // min(30s × multiplier^0, 600s) × (0.9 + rng × 0.2) per docs §5.10.
    for (const [rngValue, expectedDelay] of [[0.5, 30_000], [0, 27_000], [1, 33_000]] as const) {
      const isolated = await harness();
      const throwing = new FakeExecutor({ throwAfterAttempts: 99, thrownError: Object.assign(new Error("provider 503"), { retryable: true }) });
      isolated.registry.register(throwing);
      const entry = await pendingOutboxEntry(isolated, `retryable-${rngValue}`);
      const dispatcher = makeDispatcher(isolated, { rng: () => rngValue });

      await dispatcher.drainAvailable();
      const fresh = await waitFor(async () =>
        (await isolated.repository.listAttempts(entry.run.run_id)).items.find((row) => row.attempt_no === 2),
      );
      expect(fresh!.status).toBe("pending");
      expect(Date.parse(fresh!.available_at)).toBe(isolated.getNow() + expectedDelay);
      // Retry joins the same run with the original snapshot (docs §5.10).
      const runAfter = await isolated.repository.getRun(entry.run.run_id);
      expect(runAfter!.status).toBe("pending");
      expect(runAfter!.snapshot_sha256).toBe(entry.run.snapshot_sha256);
      expect((await isolated.repository.getAttempt(entry.attempt.attempt_id))!.error_code).toBe("EXECUTOR_ERROR");
    }
  });

  it("leaves the run terminal when attempts are exhausted after a retryable failure", async () => {
    const h = await harness();
    const exhausted = await h.repository.insertTask({
      project_id: "project_disp",
      workspace_path: WORKSPACE,
      name: "exhausted",
      schedule: SCHEDULE,
      executor: EXECUTOR_CONFIG,
      output: { relative_root: "outputs/digest" },
      retry: { ...RETRY, max_attempts: 1 },
      budget: BUDGET,
      now: h.getNow(),
    });
    const manual = await h.repository.createManualRun(exhausted.task_id, h.getNow());
    if (!manual.attempt) throw new Error("expected attempt");
    const fake = new FakeExecutor({ throwAfterAttempts: 99, thrownError: Object.assign(new Error("provider down"), { retryable: true }) });
    h.registry.register(fake);
    const dispatcher = makeDispatcher(h);
    await dispatcher.drainAvailable();
    const done = await waitFor(async () => {
      const row = await h.repository.getAttempt(manual.attempt!.attempt_id);
      return row?.status === "failed" ? row : undefined;
    });
    expect(done!.error_code).toBe("EXECUTOR_ERROR");
    expect((await h.repository.getRun(manual.run.run_id))!.status).toBe("failed");
    expect((await h.repository.listAttempts(manual.run.run_id)).items).toHaveLength(1);
  });
});
