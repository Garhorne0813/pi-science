import { describe, expect, it } from "vitest";
import { foldEventRecordsTiming, maxTiming, mergeSessionStats, SessionStatsProjector, timingFromStats, type SseEventLike } from "./session-stats-projector.js";

const KEY = "cwd\0session";

function event(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

describe("SessionStatsProjector", () => {
  it("accumulates llm/ttft/decode wall time per completed assistant message", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("message_start", { message: { id: "m1", role: "assistant" } }), 1000);
    projector.track(KEY, event("message_update", { message: { id: "m1" }, assistantMessageEvent: { type: "text_delta", delta: "  " } }), 1100); // blank delta: not first token
    projector.track(KEY, event("message_update", { message: { id: "m1" }, assistantMessageEvent: { type: "text_delta", delta: "Hi" } }), 1400); // first non-empty
    projector.track(KEY, event("message_update", { message: { id: "m1" }, assistantMessageEvent: { type: "text_end", content: "Hi!" } }), 1500);
    projector.track(KEY, event("message_end", { message: { id: "m1", role: "assistant" } }), 3000);

    const timing = projector.timing(KEY);
    expect(timing.llmMs).toBe(2000); // 1000 → 3000
    expect(timing.ttftMs).toBe(400); // 1000 → 1400
    expect(timing.ttftSteps).toBe(1);
    expect(timing.decodeMs).toBe(1600); // 1400 → 3000
  });

  it("ignores duplicate message_end and messages without start", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("message_end", { message: { id: "ghost" } }), 1000);
    projector.track(KEY, event("message_start", { message: { id: "m1" } }), 1000);
    projector.track(KEY, event("message_end", { message: { id: "m1" } }), 2000);
    projector.track(KEY, event("message_end", { message: { id: "m1" } }), 3000); // duplicate: ignored
    const timing = projector.timing(KEY);
    expect(timing.llmMs).toBe(1000);
  });

  it("pairs tool wall time by callId and never double-counts a repeated end", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("tool_execution_start", { toolCallId: "t1" }), 4000);
    projector.track(KEY, event("tool_execution_end", { toolCallId: "t1" }), 6000);
    projector.track(KEY, event("tool_execution_end", { toolCallId: "t1" }), 9000); // repeated end: ignored
    projector.track(KEY, event("tool_execution_end", { toolCallId: "t2" }), 5000); // no matching start: ignored
    expect(projector.timing(KEY).toolMs).toBe(2000);
  });

  it("clears pending entries on agent_settled so aborted work never leaks", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("message_start", { message: { id: "m1" } }), 1000);
    projector.track(KEY, event("tool_execution_start", { toolCallId: "t1" }), 1500);
    projector.track(KEY, event("agent_settled", {}), 2000);
    projector.track(KEY, event("message_end", { message: { id: "m1" } }), 3000); // start cleared: ignored
    projector.track(KEY, event("tool_execution_end", { toolCallId: "t1" }), 3000); // start cleared: ignored
    expect(projector.timing(KEY)).toEqual({ llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 });
  });

  it("folds checkpoint base timing in and keeps accumulating on top of it", () => {
    const projector = new SessionStatsProjector();
    projector.timingWithCheckpoint(KEY, { llmMs: 5000, toolMs: 1000, ttftMs: 200, ttftSteps: 2, decodeMs: 3000 });
    projector.track(KEY, event("message_start", { message: { id: "m2" } }), 10_000);
    projector.track(KEY, event("message_end", { message: { id: "m2" } }), 12_000);
    const timing = projector.timing(KEY);
    expect(timing.llmMs).toBe(7000);
    expect(timing.ttftSteps).toBe(2); // no first token in this message
  });

  it("fresh session: first collect without a checkpoint ignores later checkpoints", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("message_start", { message: { id: "m1" } }), 1000);
    projector.track(KEY, event("message_end", { message: { id: "m1" } }), 2000);
    // First collect: no checkpoint exists yet → live timing, decision recorded.
    expect(projector.timingWithCheckpoint(KEY, null).llmMs).toBe(1000);
    // The caller persisted its own output; the next collect passes it back.
    // The own checkpoint must be ignored (no double count).
    const own = { llmMs: 1000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 };
    expect(projector.timingWithCheckpoint(KEY, own).llmMs).toBe(1000);
    projector.track(KEY, event("message_start", { message: { id: "m2" } }), 3000);
    projector.track(KEY, event("message_end", { message: { id: "m2" } }), 4000);
    expect(projector.timingWithCheckpoint(KEY, own).llmMs).toBe(2000);
  });

  it("rebuild generation folds the checkpoint once on top of live delta", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("message_start", { message: { id: "m3" } }), 20_000); // events fold before the checkpoint load resolves
    projector.track(KEY, event("message_end", { message: { id: "m3" } }), 21_000);
    const checkpoint = { llmMs: 9000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 };
    const combined = projector.timingWithCheckpoint(KEY, checkpoint);
    expect(combined.llmMs).toBe(10_000); // 9000 base + 1000 live delta
  });

  it("repeated collects with the same or a different checkpoint never add again", () => {
    const projector = new SessionStatsProjector();
    const checkpoint = { llmMs: 9000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 };
    projector.timingWithCheckpoint(KEY, checkpoint);
    expect(projector.timingWithCheckpoint(KEY, checkpoint).llmMs).toBe(9000);
    expect(projector.timingWithCheckpoint(KEY, { ...checkpoint, llmMs: 99_000 }).llmMs).toBe(9000);
    expect(projector.timing(KEY).llmMs).toBe(9000);
  });

  it("tracks wall time for fully anonymous messages without any message id", () => {
    const projector = new SessionStatsProjector();
    // Pi Orbit web mode emits raw events whose message object carries no id;
    // the projector must fall back to a tracker-local key for each message.
    projector.track(KEY, event("agent_start", {}), 1000);
    projector.track(KEY, event("message_start", { message: { role: "assistant" } }), 1100);
    projector.track(KEY, event("message_update", { message: {}, assistantMessageEvent: { type: "text_delta", delta: "hello" } }), 1500);
    projector.track(KEY, event("message_end", { message: {} }), 3000);

    // A second anonymous message in the same session gets its own key.
    projector.track(KEY, event("message_start", { message: {} }), 3100);
    projector.track(KEY, event("message_update", { message: {}, assistantMessageEvent: { type: "text_delta", delta: "again" } }), 3300);
    projector.track(KEY, event("message_end", { message: {} }), 4000);

    const timing = projector.timing(KEY);
    expect(timing.llmMs).toBe(2800); // (1100→3000) + (3100→4000)
    expect(timing.ttftMs).toBe(600); // (1100→1500) + (3100→3300)
    expect(timing.ttftSteps).toBe(2);
    expect(timing.decodeMs).toBe(2200); // (1500→3000) + (3300→4000)
  });

  it("anchors a first delta at agent_start when message_start never arrives", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("agent_start", {}), 1000);
    projector.track(KEY, event("message_update", { message: {}, assistantMessageEvent: { type: "text_delta", delta: "hi" } }), 2000);
    projector.track(KEY, event("message_end", { message: {} }), 4000);

    const timing = projector.timing(KEY);
    expect(timing.llmMs).toBe(3000); // anchored at agent_start (1000 → 4000)
    expect(timing.ttftMs).toBe(1000); // 1000 → 2000
    expect(timing.ttftSteps).toBe(1);
    expect(timing.decodeMs).toBe(2000); // 2000 → 4000
  });

  it("clears the anonymous active key on agent_settled so the next turn starts fresh", () => {
    const projector = new SessionStatsProjector();
    projector.track(KEY, event("message_start", { message: {} }), 1000);
    projector.track(KEY, event("agent_settled", {}), 2000);
    projector.track(KEY, event("message_end", { message: {} }), 3000); // stale: ignored
    expect(projector.timing(KEY)).toEqual({ llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 });
  });
});

describe("maxTiming", () => {
  it("picks the larger value per field and treats null as zero", () => {
    const base = { llmMs: 5000, toolMs: 0, ttftMs: 200, ttftSteps: 2, decodeMs: 3000 };
    const backfill = { llmMs: 8000, toolMs: 1500, ttftMs: 0, ttftSteps: 0, decodeMs: 0 };
    expect(maxTiming(base, backfill)).toEqual({ llmMs: 8000, toolMs: 1500, ttftMs: 200, ttftSteps: 2, decodeMs: 3000 });
    expect(maxTiming(null, backfill)).toEqual(backfill);
    expect(maxTiming(base, null)).toEqual(base);
    expect(maxTiming(null, null)).toEqual({ llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 });
  });
});

describe("foldEventRecordsTiming", () => {
  function record(createdAt: string, payload: Record<string, unknown>): SseEventLike {
    return { created_at: createdAt, data: JSON.stringify(payload) };
  }

  it("recovers non-zero llm/ttft/decode for two anonymous text turns (real event-store shape)", () => {
    const records: SseEventLike[] = [
      record("2026-08-16T05:22:59.000Z", { type: "agent_start", sessionId: "s" }),
      record("2026-08-16T05:23:00.000Z", { type: "text.updated", sessionId: "s", partId: "anonymous-1", text: "" }),
      record("2026-08-16T05:23:01.000Z", { type: "text.updated", sessionId: "s", partId: "anonymous-1", text: "hello" }),
      record("2026-08-16T05:23:02.000Z", { type: "text.updated", sessionId: "s", partId: "anonymous-1", text: " world" }),
      record("2026-08-16T05:23:03.000Z", { type: "agent_end", sessionId: "s" }),
      record("2026-08-16T05:23:03.100Z", { type: "session.idle", sessionId: "s" }),
      record("2026-08-16T05:23:04.000Z", { type: "session.stats", sessionId: "s", stats: {} }),
      record("2026-08-16T05:23:20.000Z", { type: "agent_start", sessionId: "s" }),
      record("2026-08-16T05:23:22.000Z", { type: "text.updated", sessionId: "s", partId: "anonymous-2", text: "second" }),
      record("2026-08-16T05:23:25.000Z", { type: "agent_end", sessionId: "s" }),
    ];

    const timing = foldEventRecordsTiming(records);
    expect(timing.llmMs).toBe(9000); // (05:22:59→05:23:03) + (05:23:20→05:23:25)
    expect(timing.ttftMs).toBe(4000); // (2s) + (2s)
    expect(timing.ttftSteps).toBe(2);
    expect(timing.decodeMs).toBe(5000); // (2s) + (3s)
    expect(timing.toolMs).toBe(0);
  });

  it("subtracts tool time from llm and decode, pairing by callId without double counting", () => {
    const records: SseEventLike[] = [
      record("2026-08-16T06:00:00.000Z", { type: "agent_start", sessionId: "s" }),
      record("2026-08-16T06:00:01.000Z", { type: "text.updated", sessionId: "s", partId: "a", text: "first" }),
      record("2026-08-16T06:00:02.000Z", { type: "tool.updated", sessionId: "s", callId: "t1", tool: "bash", status: "running" }),
      record("2026-08-16T06:00:04.000Z", { type: "tool.updated", sessionId: "s", callId: "t1", tool: "bash", status: "running" }), // update: ignored for pairing
      record("2026-08-16T06:00:06.000Z", { type: "tool.updated", sessionId: "s", callId: "t1", tool: "bash", status: "done" }),
      record("2026-08-16T06:00:07.000Z", { type: "agent_end", sessionId: "s" }),
    ];

    const timing = foldEventRecordsTiming(records);
    expect(timing.toolMs).toBe(4000); // 02→06, the duplicate running update ignored
    expect(timing.llmMs).toBe(3000); // 7s elapsed − 4s tool
    expect(timing.ttftMs).toBe(1000);
    // decode = end(07) − first(01) = 6s − tool after first (02→06) 4s = 2s.
    expect(timing.decodeMs).toBe(2000);
  });

  it("discards an unclosed turn when a new agent_start arrives (no merge into the next turn)", () => {
    const records: SseEventLike[] = [
      record("2026-08-16T09:00:00.000Z", { type: "agent_start", sessionId: "s" }),
      record("2026-08-16T09:00:01.000Z", { type: "text.updated", sessionId: "s", partId: "a", text: "partial" }),
      // No agent_end before the next turn starts: the stale turn must be
      // discarded, not counted up to the new agent_start.
      record("2026-08-16T09:00:10.000Z", { type: "agent_start", sessionId: "s" }),
      record("2026-08-16T09:00:11.000Z", { type: "text.updated", sessionId: "s", partId: "b", text: "full" }),
      record("2026-08-16T09:00:15.000Z", { type: "agent_end", sessionId: "s" }),
    ];
    const timing = foldEventRecordsTiming(records);
    // Only the second (closed) turn counts: 10→15 llm, 11→15 decode.
    expect(timing.llmMs).toBe(5000);
    expect(timing.ttftMs).toBe(1000);
    expect(timing.ttftSteps).toBe(1);
    expect(timing.decodeMs).toBe(4000);
    expect(timing.toolMs).toBe(0);
  });

  it("folding the same records twice yields the same timing (no accumulation)", () => {
    const records: SseEventLike[] = [
      record("2026-08-16T07:00:00.000Z", { type: "agent_start", sessionId: "s" }),
      record("2026-08-16T07:00:01.000Z", { type: "text.updated", sessionId: "s", partId: "a", text: "x" }),
      record("2026-08-16T07:00:05.000Z", { type: "agent_end", sessionId: "s" }),
    ];
    const first = foldEventRecordsTiming(records);
    const second = foldEventRecordsTiming(records);
    expect(second).toEqual(first);
    expect(first.llmMs).toBe(5000);
    expect(first.decodeMs).toBe(4000);
  });

  it("ignores malformed records and leaves an in-flight turn out of the totals", () => {
    const records: SseEventLike[] = [
      record("not-a-date", { type: "agent_start", sessionId: "s" }),
      { created_at: "2026-08-16T08:00:00.000Z", data: "{broken json" },
      record("2026-08-16T08:00:00.000Z", { type: "agent_start", sessionId: "s" }),
      record("2026-08-16T08:00:01.000Z", { type: "text.updated", sessionId: "s", partId: "a", text: "partial" }),
      // No agent_end/session.idle: the turn is still in flight and must not count.
    ];
    const timing = foldEventRecordsTiming(records);
    expect(timing).toEqual({ llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 });
  });
});

describe("mergeSessionStats", () => {
  it("prefers runtime counters and attaches projector timing", () => {
    const stats = mergeSessionStats(
      {
        userMessages: 3,
        assistantMessages: 4,
        toolCalls: 7,
        toolResults: 7,
        totalMessages: 16,
        tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
        cost: 0.45,
      },
      { llmMs: 6000, toolMs: 2500, ttftMs: 300, ttftSteps: 4, decodeMs: 5200 },
    );
    expect(stats.userMessages).toBe(3);
    expect(stats.toolCalls).toBe(7);
    expect(stats.tokens.input).toBe(50000);
    expect(stats.decodeMs).toBe(5200);
    expect(stats.ttftSteps).toBe(4);
  });

  it("coerces missing or invalid fields to zeros", () => {
    const stats = mergeSessionStats({ userMessages: "2", tokens: {} }, { llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 });
    expect(stats.userMessages).toBe(2);
    expect(stats.tokens.input).toBe(0);
    expect(stats.toolResults).toBe(0);
  });
});

describe("timingFromStats", () => {
  it("extracts the timing slice from a persisted stats checkpoint", () => {
    const timing = timingFromStats({ userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, llmMs: 10, decodeMs: 8, ttftSteps: 1 });
    expect(timing).toEqual({ llmMs: 10, toolMs: 0, ttftMs: 0, ttftSteps: 1, decodeMs: 8 });
  });

  it("returns null for a missing checkpoint", () => {
    expect(timingFromStats(null)).toBeNull();
  });
});
