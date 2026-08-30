// ScheduledTaskDispatcher (docs §8.5–§8.8, §11.4): leases pending attempts out
// of the durable outbox, runs executors outside any SQLite transaction with a
// heartbeat-renewed owner fence, honors cancel_requested_at and converts
// retryable failures into backoff-scheduled retry attempts. Bounded by
// max_parallel (default 2, docs §15.5).
import { executionIdFor } from "../runtime/executions/execution-repository.js";
import {
  newId,
  ScheduledTaskRepository,
  type AttemptLease,
  type FinishAttemptTerminal,
} from "../storage/sqlite/repositories/scheduled-task-repository.js";
import { jitteredBackoffMs } from "./retry.js";
import type { ExecutorContext, ExecutorRegistry, ExecutorResult } from "./executor.js";
import type { RuntimeDiagnosticsInput } from "./service.js";
import type { ScheduledTask, ScheduledTaskRunAttempt, ScheduledTaskSnapshot } from "./types.js";

/** docs §15.5 hard limit: max scheduled Pi attempts running globally. */
export const DEFAULT_MAX_PARALLEL = 2;
/** docs §8.6 defaults; both are test-injectable. */
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 5_000;

export interface ScheduledTaskDispatcherDeps {
  repository: ScheduledTaskRepository;
  registry: ExecutorRegistry;
  now?: () => number;
  maxParallel?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  /** Deterministic random source for ±10% retry-backoff jitter (docs §5.10). */
  rng?: () => number;
  ownerInstanceId?: string;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

interface DispatcherRuntimeSlice {
  dispatcher_active: number;
  dispatcher_limit: number;
  last_error: string | null;
}

export class ScheduledTaskDispatcher {
  private readonly now: () => number;
  readonly maxParallel: number;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly ownerInstanceId: string;

  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private draining = false;
  private drainQueued = false;
  private stopping = false;
  private lastError: Error | null = null;

  constructor(private readonly deps: ScheduledTaskDispatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.maxParallel = Math.max(1, deps.maxParallel ?? DEFAULT_MAX_PARALLEL);
    this.heartbeatMs = Math.max(1, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.leaseMs = Math.max(this.heartbeatMs * 2, deps.leaseMs ?? DEFAULT_LEASE_MS);
    this.ownerInstanceId = deps.ownerInstanceId ?? newId("inst");
  }

  private get repository(): ScheduledTaskRepository {
    return this.deps.repository;
  }

  /** docs §8.7 wake: coalesced non-blocking drain trigger. */
  wake(): void {
    void this.drainAvailable();
  }

  /** Only ever claims; every executor runs on its own unawaited promise
   * (docs §8.7). Concurrent callers coalesce into one claim loop. */
  async drainAvailable(): Promise<void> {
    if (this.stopping) return;
    if (this.draining) {
      this.drainQueued = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainQueued = false;
        await this.claimUntilFull();
      } while (this.drainQueued && !this.stopping);
    } finally {
      this.draining = false;
    }
  }

  /** docs §11.5 shutdown: stop claiming, abort everything in flight, settle. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
    this.active.clear();
    this.controllers.clear();
  }

  getActiveCount(): number {
    return this.active.size;
  }

  describe(): DispatcherRuntimeSlice {
    return {
      dispatcher_active: this.active.size,
      dispatcher_limit: this.maxParallel,
      last_error: this.lastError?.message ?? null,
    };
  }

  // --- internals ---------------------------------------------------------------

  private async claimUntilFull(): Promise<void> {
    while (!this.stopping && this.active.size < this.maxParallel) {
      let pendingAttempts: ScheduledTaskRunAttempt[];
      try {
        pendingAttempts = await this.repository.listPendingAttempts(this.now(), Math.max(this.maxParallel * 2, 10));
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        return;
      }
      const candidate = pendingAttempts.find((attempt) => !this.active.has(attempt.attempt_id));
      if (!candidate) return;
      // Fenced claim; losing the race just means another owner took it (docs §8.5).
      let lease: AttemptLease | null = null;
      try {
        lease = await this.repository.claimAttempt(candidate.attempt_id, this.ownerInstanceId, this.now(), this.leaseMs);
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (!lease) continue;
      const execution = this.runAttempt(lease);
      this.active.set(lease.attempt_id, execution);
      // One slot freed → refill immediately without waiting for siblings (docs §8.7).
      const onSettled = (): void => {
        this.active.delete(lease.attempt_id);
        this.controllers.delete(lease.attempt_id);
        this.wake();
      };
      void execution.then(onSettled, onSettled);
    }
  }

  private async runAttempt(lease: AttemptLease): Promise<void> {
    const attemptId = lease.attempt_id;
    const controller = new AbortController();
    this.controllers.set(attemptId, controller);
    let lostLease = false;
    let cancelRequested = false;

    const run = await this.repository.getRun(lease.run_id);
    const attempt = await this.repository.getAttempt(attemptId);
    if (!run || !attempt) {
      this.lastError = new Error(`claimed attempt vanished: ${attemptId}`);
      return;
    }
    const snapshot = run.snapshot;
    let outcome: ExecutorResult | null = null;

    // Heartbeat chain: renew the lease and observe cancellation / loss (docs §8.6).
    let heartbeatHandle: ReturnType<typeof setTimeout> | null = null;
    let heartbeatsStopped = false;
    const beat = async (): Promise<void> => {
      if (heartbeatsStopped) return;
      try {
        const extended = await this.repository.heartbeatAttempt(attemptId, lease.owner_token, lease.owner_generation, this.now(), this.leaseMs);
        if (!extended) {
          // Lease lost: stop the executor immediately and write nothing (docs §8.6).
          lostLease = true;
          controller.abort();
          return;
        }
        const fresh = await this.repository.getAttempt(attemptId);
        if (fresh?.cancel_requested_at != null) {
          cancelRequested = true;
          controller.abort();
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
      }
    };
    const scheduleBeat = (): void => {
      if (heartbeatsStopped) return;
      heartbeatHandle = setTimeout(() => {
        heartbeatHandle = null;
        void beat().finally(scheduleBeat);
      }, this.heartbeatMs);
      heartbeatHandle.unref?.();
    };

    try {
      // Early cancel check between claim and execution start (docs §12.4).
      const fresh = await this.repository.getAttempt(attemptId);
      if (fresh?.cancel_requested_at != null) cancelRequested = true;

      if (!cancelRequested) {
        const executor = this.deps.registry.get(snapshot.executor.kind);
        const ctx: ExecutorContext = {
          task: snapshotToTaskView(snapshot),
          run,
          attempt,
          workspacePath: snapshot.workspace_path_at_claim,
          cwd: snapshot.workspace_path_at_claim,
          signal: controller.signal,
          now: () => this.now(),
          log: (message, details) => this.deps.log?.(`[scheduled-task:${snapshot.task_id}] ${message}`, details),
        };
        if (!executor) {
          outcome = { status: "failed", retryable: false, errorCode: "EXECUTOR_UNAVAILABLE", errorMessage: `no executor registered for kind ${snapshot.executor.kind}` };
        } else {
          scheduleBeat();
          try {
            outcome = await executor.execute(ctx);
          } catch (error) {
            // Thrown executor errors classify through the same retryable gate (docs §8.7).
            outcome = {
              status: "failed",
              retryable: (error as { retryable?: boolean }).retryable === true,
              errorCode: "EXECUTOR_ERROR",
              errorMessage: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
    } finally {
      heartbeatsStopped = true;
      if (heartbeatHandle !== null) clearTimeout(heartbeatHandle);
    }

    if (lostLease) return; // stale owner must not touch state (docs §8.6)

    const terminal: FinishAttemptTerminal = cancelRequested
      ? { status: "cancelled", outcome: "completed", summary: { title: "Run cancelled" }, recommend_notify: false, error_code: "CANCELLED", error_message: "cancel was requested while the attempt was running" }
      : {
          status: outcome!.status,
          retryable: outcome!.retryable ?? null,
          error_code: outcome!.errorCode ?? (outcome!.status === "succeeded" ? null : "EXECUTOR_ERROR"),
          error_message: outcome!.errorMessage ?? null,
          output_paths: outcome!.outputPaths ?? [],
          usage: outcome!.usage ?? {},
          outcome: outcome!.outcome,
          summary: outcome!.summary,
          recommend_notify: outcome!.recommendNotify,
        };

    // Owner-fenced terminal write; null ⇒ we lost the lease meanwhile and must
    // not update the Run or schedule retries (docs §8.6).
    let written = null;
    try {
      written = await this.repository.finishAttempt(attemptId, lease.owner_token, lease.owner_generation, terminal, this.now());
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (!written) return;

    // Retryable failure → durable retry outbox entry with jittered backoff
    // (docs §5.10/§8.7); otherwise the run stays terminal.
    const canRetry = terminal.status === "failed" && terminal.retryable === true && run.attempt_count < snapshot.retry.max_attempts;
    if (canRetry) {
      const availableAt = this.now() + jitteredBackoffMs(snapshot.retry, attempt.attempt_no, this.deps.rng ?? Math.random);
      const retryAttemptId = newId("satt");
      try {
        await this.repository.insertRetryAttempt(run.run_id, attemptId, {
          attempt_id: retryAttemptId,
          execution_id: executionIdFor("scheduled-task-attempt", retryAttemptId),
          available_at: availableAt,
        }, this.now());
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
}

/** Executor-facing view built ONLY from the claim-time snapshot (docs §5.10:
 * attempts never read the newest task config). Non-executed fields are neutral
 * placeholders because executors must not depend on them. */
function snapshotToTaskView(snapshot: ScheduledTaskSnapshot): ScheduledTask {
  return {
    task_id: snapshot.task_id,
    project_id: snapshot.project_id,
    workspace_path: snapshot.workspace_path_at_claim,
    schema_version: 1,
    revision: snapshot.revision,
    name: snapshot.name,
    display: snapshot.display,
    origin: snapshot.origin,
    delivery_policy: snapshot.delivery_policy,
    lifecycle_status: "active",
    schedule: snapshot.schedule,
    executor: snapshot.executor,
    output: snapshot.output,
    approval: {
      status: snapshot.approval.status,
      scope_hash: snapshot.approval.scope_hash,
      approved_revision: snapshot.approval.approved_revision,
      categories: snapshot.approval.categories,
      terms: [],
      approved_at: null,
    },
    retry: snapshot.retry,
    budget: snapshot.budget,
    misfire_policy: snapshot.misfire_policy,
    concurrency_policy: snapshot.concurrency_policy,
    next_run_at: null,
    last_scheduled_at: null,
    last_run_id: null,
    created_at: snapshot.claimed_at,
    updated_at: snapshot.claimed_at,
    deleted_at: null,
  };
}
