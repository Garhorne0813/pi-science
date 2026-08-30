// ScheduledTaskScheduler (docs §6, §8.9, §11.3–§11.4): one nearest-deadline
// timer per process; ticks recover expired leases, atomically claim due
// occurrences (never running executors), wake the dispatcher and re-arm.
// The constructor does not start anything — start()/stop() are explicit.
import { executionIdFor } from "../runtime/executions/execution-repository.js";
import {
  newId,
  ScheduledTaskRepository,
  type ClaimOccurrenceInput,
  type LeaseRecoveryOutcome,
  type SkipOccurrenceInput,
} from "../storage/sqlite/repositories/scheduled-task-repository.js";
import { jitteredBackoffMs } from "./retry.js";
import { advanceNextRunAt, businessDateFor, MISFIRE_GRACE_MS } from "./schedule.js";
import { buildSnapshot } from "./service.js";
import type { RuntimeDiagnosticsInput } from "./service.js";
import type { ScheduledTask } from "./types.js";

/** docs §11.3: clock recheck is for system-clock adjustments and timer drift,
 * not per-task polling. */
export const CLOCK_RECHECK_MS = 60_000;
/** Hard cap so a far-future deadline stays inside setTimeout's 32-bit range. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ScheduledTaskSchedulerDeps {
  repository: ScheduledTaskRepository;
  /** Dispatcher wake hook (docs §11.1: the scheduler never awaits executors). */
  dispatch: () => void;
  now?: () => number;
  clockRecheckMs?: number;
  misfireGraceMs?: number;
  /** Deterministic rng for lease-recovery retry backoff jitter (docs §5.10). */
  rng?: () => number;
  /** Phase 5 hook: Execution reconciler per recovered lease (docs §8.9). */
  onLeaseRecovered?: (outcome: LeaseRecoveryOutcome) => void | Promise<void>;
  claimBatchSize?: number;
}

interface SchedulerRuntimeSlice {
  status: RuntimeDiagnosticsInput["status"];
  last_tick_at: string | null;
  next_deadline_at: string | null;
  last_error: string | null;
}

export class ScheduledTaskScheduler {
  private readonly now: () => number;
  private readonly clockRecheckMs: number;
  private readonly misfireGraceMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickPromise: Promise<void> | null = null;
  /** Serializes arm() so concurrent wakes can never leave two live timers. */
  private armChain: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  private lastTickAtMs: number | null = null;
  private nextDeadlineAtMs: number | null = null;
  private lastError: Error | null = null;

  constructor(private readonly deps: ScheduledTaskSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.clockRecheckMs = Math.max(1, deps.clockRecheckMs ?? CLOCK_RECHECK_MS);
    this.misfireGraceMs = Math.max(0, deps.misfireGraceMs ?? MISFIRE_GRACE_MS);
  }

  private get repository(): ScheduledTaskRepository {
    return this.deps.repository;
  }

  // --- lifecycle ---------------------------------------------------------------

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.tick();
  }

  /** docs §8.9 restart recovery order — every step idempotent; safe to repeat. */
  async startupOnce(): Promise<void> {
    if (this.closed) return;
    await this.tick();
  }

  async stop(): Promise<void> {
    this.clearCurrentTimer();
    this.started = false;
    this.closed = true;
    // Wait for an in-flight tick to settle before callers close SQLite (docs §11.5).
    await this.tickPromise?.catch(() => undefined);
  }

  /** docs §11.3 wake: only rearms the timer; never runs executors inline. */
  wake(): void {
    if (!this.started || this.closed) return;
    void this.arm().catch(() => undefined);
  }

  /** Test seam: the invariant is zero or one live timer handle (docs §14.2 Timer row). */
  getActiveTimerHandleCount(): number {
    return this.timer === null ? 0 : 1;
  }

  describe(): SchedulerRuntimeSlice {
    return {
      status: this.closed ? "stopped" : this.started ? "running" : "starting",
      last_tick_at: this.lastTickAtMs === null ? null : new Date(this.lastTickAtMs).toISOString(),
      next_deadline_at: this.nextDeadlineAtMs === null ? null : new Date(this.nextDeadlineAtMs).toISOString(),
      last_error: this.lastError?.message ?? null,
    };
  }

  // --- tick ------------------------------------------------------------------

  /** Single-flight (docs §11.4): overlapping triggers join the in-flight pass. */
  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = (async () => {
      try {
        await this.recoverExpiredLeasesBatch();
        await this.claimDueOccurrencesBatch();
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        try {
          this.deps.dispatch();
        } catch {
          // Dispatcher wake failures must not break arming (docs §11.4).
        }
        try {
          await this.arm();
        } catch (error) {
          this.lastError = error instanceof Error ? error : new Error(String(error));
        }
        this.lastTickAtMs = this.now();
      }
    })().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  // --- timer -------------------------------------------------------------------

  /** docs §11.3: delay = min(nearestDeadline - now, CLOCK_RECHECK_MS, 2^31-1). */
  arm(): Promise<void> {
    const chained = this.armChain.then(() => this.doArm());
    this.armChain = chained.catch(() => undefined);
    return chained;
  }

  private clearCurrentTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async doArm(): Promise<void> {
    this.clearCurrentTimer();
    const started = this.started && !this.closed;
    if (!started) return;
    const nowMs = this.now();
    const deadline = await this.repository.nearestDeadline();
    if (!this.started || this.closed) return;
    this.nextDeadlineAtMs = deadline;
    const delay = Math.max(0, Math.min(deadline === null ? this.clockRecheckMs : deadline - nowMs, this.clockRecheckMs, MAX_TIMER_DELAY_MS));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => undefined);
    }, delay);
    this.timer.unref?.();
  }

  // --- recovery and claiming ------------------------------------------------

  /** docs §8.9 step "recover expired running attempts": repository performs the
   * fenced CAS batch; planRetry computes deterministic execution ids and the
   * jittered backoff for each fresh pending attempt. */
  private async recoverExpiredLeasesBatch(): Promise<void> {
    const outcomes = await this.repository.recoverExpiredLeases(this.now(), (expired) => {
      if (expired.attempt_no >= expired.retry.max_attempts) return null;
      return {
        execution_id: executionIdFor("scheduled-task-attempt", expired.attempt_id, "retry", String(expired.attempt_no + 1)),
        available_at: this.now() + jitteredBackoffMs(expired.retry, expired.attempt_no, this.deps.rng ?? Math.random),
      };
    });
    for (const outcome of outcomes) {
      await this.deps.onLeaseRecovered?.(outcome);
    }
  }

  /** docs §8.2/§5.7: claim every due occurrence atomically. Misfire beyond
   * grace resolves through advanceNextRunAt; coalesce lands a reconcile Run at
   * missed.through, skip inserts a terminal MISFIRE_SKIPPED Run without attempts. */
  private async claimDueOccurrencesBatch(): Promise<number> {
    let claimed = 0;
    for (;;) {
      // Ticks stay runnable before start() (startupOnce) and after it; only a
      // closed scheduler stops claiming.
      if (this.closed) break;
      const dueTasks = await this.repository.listDueTasks(this.now(), this.deps.claimBatchSize ?? 50);
      if (dueTasks.length === 0) break;
      let advancedAny = false;
      for (const task of dueTasks) {
        if (this.closed) break;
        const claimedOrSkipped = await this.claimOne(task);
        advancedAny ||= claimedOrSkipped;
        claimed += claimedOrSkipped ? 1 : 0;
      }
      if (!advancedAny) break; // everything raced; retrying immediately would spin
    }
    return claimed;
  }

  private async claimOne(task: ScheduledTask): Promise<boolean> {
    const nowMs = this.now();
    const currentNextMs = Date.parse(task.next_run_at!);
    const advance = advanceNextRunAt(task.schedule, currentNextMs, nowMs, task.misfire_policy, this.misfireGraceMs);
    const scheduledFor = advance.action === "due" || advance.action === "none" ? currentNextMs : advance.missed!.through;
    const trigger_source: "automatic" | "reconcile" = advance.action === "coalesce" || advance.action === "skip" ? "reconcile" : "automatic";
    const snapshotPayload = buildSnapshot(task, nowMs);
    // docs §5.7 step 4: reconcile runs carry the missed window as evidence.
    const contextJson = advance.missed
      ? JSON.stringify({ missed_from: new Date(advance.missed.from).toISOString(), missed_through: new Date(advance.missed.through).toISOString() })
      : "{}";
    const shared = {
      task_id: task.task_id,
      expected_revision: task.revision,
      expected_next_run_at: currentNextMs,
      scheduled_for: scheduledFor,
      business_date: businessDateFor(scheduledFor, task.schedule.timezone),
      trigger_source,
      next_run_at: advance.next_run_at,
      completes_once: task.schedule.type === "once",
      snapshot_json: snapshotPayload.json,
      snapshot_sha256: snapshotPayload.sha256,
      context_json: contextJson,
      now: nowMs,
    };

    if (advance.action === "skip") {
      // docs §5.7 skip: terminal skipped Run, zero attempts, no active-run requirement.
      const skipped = await this.repository.claimOccurrenceSkipped({
        ...shared,
        run_id: newId("srun"),
        occurrence_key: `${task.task_id}:${scheduledFor}`,
        error_code: "MISFIRE_SKIPPED",
        error_message: "occurrences older than the misfire grace window were skipped by policy",
        requires_active_run: false,
      } satisfies SkipOccurrenceInput);
      return skipped !== null;
    }

    const runId = newId("srun");
    const attemptId = newId("satt");
    const result = await this.repository.claimOccurrence({
      ...shared,
      run_id: runId,
      attempt_id: attemptId,
      execution_id: executionIdFor("scheduled-task-attempt", attemptId),
      occurrence_key: `${task.task_id}:${scheduledFor}`,
    } satisfies ClaimOccurrenceInput);
    if (result.status === "claimed") return true;
    if (result.status === "conflict" && result.reason === "active_run_exists") {
      // docs §5.8 overlap forbid: terminal skipped Run + advance, still no Attempt.
      const skipped = await this.repository.claimOccurrenceSkipped({
        ...shared,
        run_id: newId("srun"),
        occurrence_key: `${task.task_id}:${scheduledFor}`,
        error_code: "OVERLAP_FORBIDDEN",
        error_message: "concurrency policy forbids parallel runs",
      } satisfies SkipOccurrenceInput);
      return skipped !== null;
    }
    // already_claimed / revision_conflict / not_due / lost_race: leave the task
    // for the next tick instead of fighting the winner (docs §8.10).
    return false;
  }
}
