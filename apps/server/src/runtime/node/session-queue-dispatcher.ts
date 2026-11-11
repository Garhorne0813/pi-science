import type { QueuedMessage } from "@pi-science/contracts";
import { SessionQueueRepository } from "../../modules/session/session-queue-repository.js";

export interface QueueSessionFacts {
  is_streaming?: boolean;
  is_compacting?: boolean;
  pending_message_count?: number;
}

export interface QueueSessionFailure {
  failure: string;
  code?: string;
}

export interface QueueDispatchSessions {
  state(sessionId: string, cwd: string): Promise<QueueSessionFacts | QueueSessionFailure>;
  command(
    sessionId: string,
    cwd: string,
    type: string,
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; code?: string; data?: unknown }>;
}

/** Outcomes that mean "not now" rather than "this entry is broken". The worker
 *  is still busy or a permission barrier is mid-flight, so the entry goes back
 *  to the head of the queue and the next tick tries again. */
const RETRYABLE = new Set([
  "busy",
  "session_busy",
  "runtime_busy",
  "approval_revision_conflict",
  "permission_transition_failed",
  "runtime_evicted",
  "runtime_capacity_exceeded",
  "agent_turn_capacity_exceeded",
]);

export type DispatchTick =
  | "empty"
  | "paused"
  | "busy"
  | "unknown_session"
  | "dispatched"
  | "requeued"
  | "failed";

/** Drains one session's follow-up queue. The authoritative session state is the
 *  gate: a queued message is handed to the agent only once the previous turn has
 *  actually finished, so an approval or questionnaire wait is never bypassed. */
export class SessionQueueDispatcher {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ticking = new Set<string>();

  constructor(
    private readonly sessions: QueueDispatchSessions,
    private readonly queue: SessionQueueRepository = new SessionQueueRepository(),
    private readonly intervalMs = 400,
  ) {}

  /** Schedule a drain soon, then keep polling while the queue still has work. */
  kick(cwd: string, sessionId: string, options: { immediate?: boolean } = {}): void {
    const key = `${cwd}\u0000${sessionId}`;
    if (this.timers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(key);
        void this.tick(cwd, sessionId);
      },
      options.immediate ? 0 : this.intervalMs,
    );
    timer.unref?.();
    this.timers.set(key, timer);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Stop scheduling and wait for an in-flight tick to finish. A tick that was
   *  already running may queue its successor after `stop`, so the timers are
   *  cleared again once it returns; callers that delete the queue directory
   *  right afterwards must not race a pending write. */
  async stopAndDrain(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    this.stop();
    while (this.ticking.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.stop();
    }
    this.stop();
  }

  async tick(cwd: string, sessionId: string): Promise<DispatchTick> {
    const key = `${cwd}\u0000${sessionId}`;
    if (this.ticking.has(key)) return "busy";
    this.ticking.add(key);
    try {
      const queue = await this.queue.read(cwd, sessionId);
      if (queue.paused) return "paused";
      if (!queue.entries.some((entry) => entry.status === "queued")) return "empty";

      const state = await this.sessions
        .state(sessionId, cwd)
        .catch((error: unknown) => ({ failure: String(error), code: "state_failed" }));
      if ("failure" in state) return "unknown_session";
      if (state.is_streaming || state.is_compacting || (state.pending_message_count ?? 0) > 0) {
        this.kick(cwd, sessionId);
        return "busy";
      }

      const claimed = await this.queue.claimNext(cwd, sessionId);
      if (!claimed) return (await this.queue.read(cwd, sessionId)).paused ? "paused" : "empty";
      const outcome = await this.dispatch(cwd, sessionId, claimed);
      // Keep draining: more entries may be waiting behind this one.
      this.kick(cwd, sessionId);
      return outcome;
    } finally {
      this.ticking.delete(key);
    }
  }

  private async dispatch(
    cwd: string,
    sessionId: string,
    entry: QueuedMessage,
  ): Promise<DispatchTick> {
    let result: { success: boolean; code?: string; data?: unknown };
    try {
      // The entry id doubles as the prompt's client message id, so the existing
      // prompt ledger recognises a retried dispatch instead of sending twice.
      result = await this.sessions.command(sessionId, cwd, "prompt", {
        message: entry.text,
        client_message_id: entry.id,
      });
    } catch {
      await this.queue.settle(cwd, sessionId, entry.id, {
        status: "queued",
        error_code: "dispatch_threw",
      });
      return "requeued";
    }
    if (result.success) {
      // The worker reports the persisted message id as `durableMessageId`;
      // older command results used the snake_case field. Prefer the current
      // name so a dispatched entry links to the message the thread shows.
      const data = result.data as
        | { durableMessageId?: string; durable_message_id?: string }
        | undefined;
      const deliveredId =
        typeof data?.durableMessageId === "string"
          ? data.durableMessageId
          : typeof data?.durable_message_id === "string"
            ? data.durable_message_id
            : undefined;
      await this.queue.settle(cwd, sessionId, entry.id, {
        status: "dispatched",
        ...(deliveredId ? { delivered_message_id: deliveredId } : {}),
      });
      return "dispatched";
    }
    const code =
      typeof result.code === "string" && result.code ? result.code : "runtime_command_failed";
    if (RETRYABLE.has(code)) {
      await this.queue.settle(cwd, sessionId, entry.id, { status: "queued", error_code: code });
      return "requeued";
    }
    await this.queue.settle(cwd, sessionId, entry.id, { status: "failed", error_code: code });
    return "failed";
  }
}
