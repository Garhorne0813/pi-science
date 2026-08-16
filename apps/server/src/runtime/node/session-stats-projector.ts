import type { SessionStats } from "@pi-science/contracts";

/** Wall-clock timing projector for whole-session stats. The Pi runtime's
 *  `get_session_stats` already owns the durable whole-log counters (turns,
 *  tool calls, token usage); this projector owns what the runtime does not
 *  report: per-message LLM/TTFT/decode wall time and per-tool wall time, all
 *  derived from the control-plane event stream.
 *
 *  Semantics (mirroring the upstream DeepSeek harness whole-log projection):
 *  - llmMs: assistant `message_start` → `message_end`.
 *  - ttftMs: `message_start` → first non-empty text delta; ttftSteps counts
 *    one per message that produced a first token.
 *  - decodeMs: first non-empty text delta → `message_end`. Token/s is derived
 *    client-side as total output tokens / (decodeMs / 1000).
 *  - toolMs: `tool_execution_start` → `tool_execution_end`, paired by callId
 *    and removed on first end so a repeated end can never double-count.
 *  - `agent_settled` clears stale pending entries (cancelled/aborted steps
 *    must not leak time into later turns).
 *
 *  Pi Orbit web events do not always carry a stable message id: the raw
 *  `message_start/message_update/message_end` events can omit `message.id`
 *  entirely (the normalized stream then uses synthetic `anonymous-N` partIds).
 *  The projector therefore tracks the currently-streaming assistant message
 *  per tracker and falls back to a tracker-local synthetic key when the raw
 *  events omit the id, so wall time is attributed even for fully anonymous
 *  streams. When the first text delta arrives before any `message_start`, the
 *  pending message is anchored at the most recent `agent_start` so TTFT stays
 *  meaningful.
 *
 *  Timing is persisted as part of the stats checkpoint, so refresh recovers it
 *  even when the runtime is idle. The first `timingWithCheckpoint` call per
 *  runtime generation decides how the persisted base is used (folded in once
 *  for a rebuild, declared irrelevant for a fresh session), so runtime
 *  rebuilds keep accumulating instead of resetting the clock and later
 *  checkpoints can never be added twice. */

export interface SessionTiming {
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
}

interface PendingMessage {
  startedAt: number;
  firstDeltaAt: number | null;
}

interface Tracker {
  base: SessionTiming;
  pending: Map<string, PendingMessage>;
  pendingTools: Map<string, number>;
  /** Key of the assistant message currently streaming (real id when the
   *  runtime provides one, otherwise a tracker-local fallback key). */
  activeKey: string | null;
  /** Monotonic per-tracker counter for synthetic message keys. */
  fallbackCounter: number;
  /** Wall time of the most recent `agent_start`; anchors a pending message
   *  when the first text delta arrives before any `message_start`. */
  agentStartedAt: number | null;
}

function emptyTiming(): SessionTiming {
  return { llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 };
}

export function addTiming(left: SessionTiming, right: SessionTiming): SessionTiming {
  return {
    llmMs: left.llmMs + right.llmMs,
    toolMs: left.toolMs + right.toolMs,
    ttftMs: left.ttftMs + right.ttftMs,
    ttftSteps: left.ttftSteps + right.ttftSteps,
    decodeMs: left.decodeMs + right.decodeMs,
  };
}

/** Element-wise maximum of two timing slices. Used to merge the persisted
 *  checkpoint (authoritative, produced by the live raw-event projector) with
 *  the durable-event backfill: the backfill only fills missing/zero timing and
 *  must never accumulate on top of the checkpoint. */
export function maxTiming(left: SessionTiming | null, right: SessionTiming | null): SessionTiming {
  const a = left ?? emptyTiming();
  const b = right ?? emptyTiming();
  return {
    llmMs: Math.max(a.llmMs, b.llmMs),
    toolMs: Math.max(a.toolMs, b.toolMs),
    ttftMs: Math.max(a.ttftMs, b.ttftMs),
    ttftSteps: Math.max(a.ttftSteps, b.ttftSteps),
    decodeMs: Math.max(a.decodeMs, b.decodeMs),
  };
}

/** Extract the timing slice of a persisted stats checkpoint (fields are
 *  optional there; 0 when absent). */
export function timingFromStats(stats: SessionStats | null): SessionTiming | null {
  if (!stats) return null;
  return {
    llmMs: stats.llmMs ?? 0,
    toolMs: stats.toolMs ?? 0,
    ttftMs: stats.ttftMs ?? 0,
    ttftSteps: stats.ttftSteps ?? 0,
    decodeMs: stats.decodeMs ?? 0,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class SessionStatsProjector {
  private readonly trackers = new Map<string, Tracker>();
  /** Keys whose checkpoint-prefix decision has been made for the current
   *  runtime generation. After the first `timingWithCheckpoint` call the
   *  checkpoint is either folded into the base exactly once (rebuild
   *  generation) or declared irrelevant (fresh session), so any later
   *  checkpoint — including one the caller itself just persisted from this
   *  tracker's output — can never be added again. */
  private readonly decided = new Set<string>();

  private tracker(key: string): Tracker {
    let tracker = this.trackers.get(key);
    if (!tracker) {
      tracker = { base: emptyTiming(), pending: new Map(), pendingTools: new Map(), activeKey: null, fallbackCounter: 0, agentStartedAt: null };
      this.trackers.set(key, tracker);
    }
    return tracker;
  }

  /** Synthetic key for an id-less assistant message. The NUL prefix cannot
   *  collide with runtime-provided ids, and the counter is per-tracker so two
   *  sessions never share a key sequence. */
  private fallbackKey(tracker: Tracker): string {
    tracker.fallbackCounter += 1;
    return `\u0000pi-fallback-${tracker.fallbackCounter}`;
  }

  clear(key: string): void {
    this.trackers.delete(key);
    this.decided.delete(key);
  }

  /** Current accumulated timing since runtime start (plus any folded base). */
  timing(key: string): SessionTiming {
    const tracker = this.trackers.get(key);
    if (!tracker) return emptyTiming();
    return { ...tracker.base };
  }

  /** First call per runtime generation decides the checkpoint prefix.
   *  - checkpoint == null: fresh session — the live tracker covers the whole
   *    session, so the decision is recorded and later checkpoints (including
   *    one saved from this tracker's own output) are ignored.
   *  - checkpoint != null: rebuild generation — the persisted base is folded
   *    into the tracker once, even when live events already accumulated, and
   *    the live tracker only covers the suffix after the checkpoint.
   *  Later calls only return the tracker timing and never add again. */
  timingWithCheckpoint(key: string, checkpoint: SessionTiming | null): SessionTiming {
    if (this.decided.has(key)) return this.timing(key);
    this.decided.add(key);
    if (checkpoint) {
      const tracker = this.tracker(key);
      tracker.base = addTiming(checkpoint, tracker.base);
    }
    return this.timing(key);
  }

  /** Fold one raw Pi event into the tracker. Unknown event types are ignored. */
  track(key: string, event: Record<string, unknown>, now: number): void {
    const type = String(event.type ?? "");
    if (type === "agent_start") {
      const tracker = this.tracker(key);
      tracker.agentStartedAt = now;
      return;
    }
    if (type === "message_start") {
      const message = event.message;
      const record = isRecord(message) ? message : {};
      if (String(record.role ?? "assistant") !== "assistant") return;
      const id = String(record.id ?? event.messageId ?? "");
      const tracker = this.tracker(key);
      const messageKey = id || this.fallbackKey(tracker);
      tracker.activeKey = messageKey;
      tracker.pending.set(messageKey, { startedAt: now, firstDeltaAt: null });
      return;
    }
    if (type === "message_update") {
      const assistant = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : {};
      const kind = String(assistant.type ?? "");
      if (!["text_delta", "text"].includes(kind)) return;
      const delta = String(assistant.delta ?? assistant.text ?? assistant.content ?? "");
      if (!delta.trim()) return;
      const message = event.message;
      const record = isRecord(message) ? message : {};
      const id = String(record.id ?? event.messageId ?? "");
      const tracker = this.tracker(key);
      let messageKey = id || tracker.activeKey;
      if (!messageKey) {
        // No message_start and no active message yet: anchor the pending entry
        // at the most recent agent_start so TTFT stays meaningful for fully
        // anonymous streams.
        if (tracker.agentStartedAt === null) return;
        messageKey = this.fallbackKey(tracker);
        tracker.activeKey = messageKey;
        tracker.pending.set(messageKey, { startedAt: tracker.agentStartedAt, firstDeltaAt: null });
      }
      const pending = tracker.pending.get(messageKey);
      if (pending && pending.firstDeltaAt === null) pending.firstDeltaAt = now;
      return;
    }
    if (type === "message_end") {
      const message = event.message;
      const record = isRecord(message) ? message : {};
      const id = String(record.id ?? event.messageId ?? "");
      const tracker = this.tracker(key);
      const messageKey = id || tracker.activeKey;
      if (!messageKey) return;
      const pending = tracker.pending.get(messageKey);
      if (!pending) return;
      tracker.pending.delete(messageKey);
      if (tracker.activeKey === messageKey) tracker.activeKey = null;
      const duration = Math.max(0, now - pending.startedAt);
      tracker.base.llmMs += duration;
      if (pending.firstDeltaAt !== null) {
        tracker.base.ttftMs += Math.max(0, pending.firstDeltaAt - pending.startedAt);
        tracker.base.ttftSteps += 1;
        tracker.base.decodeMs += Math.max(0, now - pending.firstDeltaAt);
      }
      return;
    }
    if (type === "tool_execution_start") {
      const callId = String(event.toolCallId ?? "");
      if (callId) {
        const tracker = this.tracker(key);
        tracker.pendingTools.set(callId, now);
      }
      return;
    }
    if (type === "tool_execution_end") {
      const callId = String(event.toolCallId ?? "");
      if (!callId) return;
      const tracker = this.tracker(key);
      const startedAt = tracker.pendingTools.get(callId);
      if (startedAt === undefined) return;
      tracker.pendingTools.delete(callId);
      tracker.base.toolMs += Math.max(0, now - startedAt);
      return;
    }
    if (type === "agent_settled") {
      // Cancelled/aborted turns: drop unpaired pending entries so their
      // partial wall time cannot leak into a later turn's statistics.
      const tracker = this.tracker(key);
      tracker.pending.clear();
      tracker.pendingTools.clear();
      tracker.activeKey = null;
      tracker.agentStartedAt = null;
    }
  }
}

/** Merge the runtime's authoritative whole-log counters with control-plane
 *  timing into one stats object. Counters always win from `runtimeData`
 *  (fresh fold); timing comes from the projector. */
export function mergeSessionStats(
  runtimeData: Record<string, unknown>,
  timing: SessionTiming,
): SessionStats {
  const tokens = isRecord(runtimeData.tokens) ? runtimeData.tokens : {};
  const num = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  const stats: SessionStats = {
    userMessages: Math.max(0, Math.round(num(runtimeData.userMessages))),
    assistantMessages: Math.max(0, Math.round(num(runtimeData.assistantMessages))),
    toolCalls: Math.max(0, Math.round(num(runtimeData.toolCalls))),
    toolResults: Math.max(0, Math.round(num(runtimeData.toolResults))),
    totalMessages: Math.max(0, Math.round(num(runtimeData.totalMessages))),
    tokens: {
      input: num(tokens.input),
      output: num(tokens.output),
      cacheRead: num(tokens.cacheRead),
      cacheWrite: num(tokens.cacheWrite),
      total: num(tokens.total),
    },
    cost: num(runtimeData.cost),
    llmMs: timing.llmMs,
    toolMs: timing.toolMs,
    ttftMs: timing.ttftMs,
    ttftSteps: timing.ttftSteps,
    decodeMs: timing.decodeMs,
  };
  return stats;
}

/** Shape of the durable SSE records retained by the control plane's event
 *  store (`DurableEventStore.readAfter`). Kept structural so this module has
 *  no dependency on the event-store implementation. */
export interface SseEventLike {
  created_at: string;
  data: string;
}

/** Fold persisted normalized SSE records into whole-session wall-clock timing.
 *  The event store retains the control-plane's normalized stream (`agent_start`,
 *  `text.updated`, `tool.updated`, `agent_end`/`session.idle`) with
 *  `created_at` timestamps, so sessions whose raw Pi events lacked message ids
 *  — or that ran before the raw-event projector existed — can still recover
 *  timing without touching the live runtime.
 *
 *  Per turn: start = `agent_start`; first token = first non-empty
 *  `text.updated`; end = `agent_end` (falling back to `session.idle`). Tool
 *  time is paired per callId (`running` → `done`/`error`) and never
 *  double-counted. `llmMs` = turn elapsed − tool time; `ttft` = start → first
 *  token; `decode` = first token → end − tool time after the first token.
 *  A turn still open at the end of the log is left out (in-flight). */
export function foldEventRecordsTiming(records: readonly SseEventLike[]): SessionTiming {
  const timing = emptyTiming();
  let turn: { startAt: number; firstTokenAt: number | null; tools: Array<{ start: number; end: number }> } | null = null;
  const pendingTools = new Map<string, number>();

  const closeTurn = (endAt: number) => {
    if (!turn) return;
    const end = Math.max(endAt, turn.startAt);
    const toolMs = turn.tools.reduce((sum, tool) => sum + Math.max(0, tool.end - tool.start), 0);
    timing.toolMs += toolMs;
    timing.llmMs += Math.max(0, end - turn.startAt - toolMs);
    if (turn.firstTokenAt !== null) {
      timing.ttftMs += Math.max(0, turn.firstTokenAt - turn.startAt);
      timing.ttftSteps += 1;
      let toolAfterFirst = 0;
      for (const tool of turn.tools) {
        if (tool.end <= turn.firstTokenAt) continue;
        toolAfterFirst += Math.max(0, tool.end - Math.max(tool.start, turn.firstTokenAt));
      }
      timing.decodeMs += Math.max(0, end - turn.firstTokenAt - toolAfterFirst);
    }
    turn = null;
  };

  for (const record of records) {
    const at = Date.parse(record.created_at);
    if (!Number.isFinite(at)) continue;
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(record.data) as unknown;
      payload = isRecord(parsed) ? parsed : null;
    } catch {
      continue;
    }
    if (!payload) continue;
    const type = String(payload.type ?? "");
    if (type === "agent_start") {
      // A new turn without a recorded end must not merge into the next one:
      // discard the stale turn instead of counting it.
      turn = null;
      pendingTools.clear();
      turn = { startAt: at, firstTokenAt: null, tools: [] };
      continue;
    }
    if (!turn) continue;
    if (type === "text.updated") {
      const text = String(payload.text ?? "");
      if (turn.firstTokenAt === null && text.trim().length > 0) turn.firstTokenAt = at;
      continue;
    }
    if (type === "tool.updated") {
      const callId = String(payload.callId ?? "");
      const status = String(payload.status ?? "");
      if (!callId) continue;
      if (status === "running") {
        // Repeated running updates for the same call must not overwrite the
        // original start; only the first one anchors the pairing.
        if (!pendingTools.has(callId)) pendingTools.set(callId, at);
      } else if (status === "done" || status === "error") {
        const start = pendingTools.get(callId);
        if (start !== undefined) {
          pendingTools.delete(callId);
          turn.tools.push({ start, end: at });
        }
      }
      continue;
    }
    if (type === "agent_end" || type === "session.idle") {
      closeTurn(at);
    }
  }
  return timing;
}
