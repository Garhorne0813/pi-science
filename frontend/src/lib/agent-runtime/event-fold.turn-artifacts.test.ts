import { beforeEach, describe, expect, it } from "vitest";
import { attachTurnArtifacts, foldEvent, resetTurnBuffer } from "./event-fold";
import type { Thread } from "./event-fold";
import type { PiScienceEvent } from "../client/pi-science-client";

beforeEach(() => { resetTurnBuffer(); });

function threadWith(blocks: Array<{ kind: string; id: string; [key: string]: unknown }>): Thread {
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks: blocks as unknown as Thread["blocks"], index, loaded: true };
}

describe("foldEvent turn.artifacts", () => {
  it("folds turn.artifacts into an artifact-summary block after the assistant message", () => {
    let state = threadWith([
      { kind: "user", id: "user-1", text: "analyze" },
      { kind: "agent", id: "agent-1", parts: [{ id: "agent-1", text: "done" }] },
    ]);
    const event: PiScienceEvent = {
      type: "turn.artifacts", sessionId: "s", turnId: "turn-1", assistantMessageId: "agent-1",
      artifacts: [{ path: "work/plot.png", kind: "image", mime: "image/png", size: 10 }],
    };
    state = foldEvent(state, event);
    expect(state.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary"]);
    const summary = state.blocks[2];
    expect(summary).toMatchObject({ kind: "artifact-summary", turnId: "turn-1", assistantMessageId: "agent-1" });
    expect(state.index["turn-artifacts-turn-1"]).toBe(2);
  });

  it("appends when the assistant message is not in the thread yet", () => {
    let state = threadWith([{ kind: "user", id: "user-1", text: "hi" }]);
    const event: PiScienceEvent = {
      type: "turn.artifacts", sessionId: "s", turnId: "turn-9", assistantMessageId: "agent-unknown",
      artifacts: [{ path: "a.csv", kind: "table", mime: "text/csv", size: 5 }],
    };
    state = foldEvent(state, event);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "artifact-summary", turnId: "turn-9" });
  });

  it("anchors each strip after its own turn's agent block when the assistant message id is absent", () => {
    let state = threadWith([
      { kind: "user", id: "user-1", text: "a" },
      { kind: "agent", id: "part-1", parts: [{ id: "part-1", text: "r1" }] },
      { kind: "user", id: "user-2", text: "b" },
      { kind: "agent", id: "part-2", parts: [{ id: "part-2", text: "r2" }] },
    ]);
    const base = { type: "turn.artifacts", sessionId: "s" } as PiScienceEvent;
    state = foldEvent(state, { ...base, turnId: "turn-1", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] });
    state = foldEvent(state, { ...base, turnId: "turn-2", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] });
    expect(state.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(state.blocks[2]).toMatchObject({ turnId: "turn-1" });
    expect(state.blocks[5]).toMatchObject({ turnId: "turn-2" });
    expect(state.index["turn-artifacts-turn-1"]).toBe(2);
    expect(state.index["turn-artifacts-turn-2"]).toBe(5);
  });

  it("uses turnOrdinal to anchor a strip after the n-th agent block when earlier turns produced no records", () => {
    let state = threadWith([
      { kind: "user", id: "user-1", text: "a" },
      { kind: "agent", id: "part-1", parts: [{ id: "part-1", text: "r1" }] },
      { kind: "user", id: "user-2", text: "b" },
      { kind: "agent", id: "part-2", parts: [{ id: "part-2", text: "r2" }] },
      { kind: "user", id: "user-3", text: "c" },
      { kind: "agent", id: "part-3", parts: [{ id: "part-3", text: "r3" }] },
    ]);
    // Only turns 2 and 3 produced files; turn 1 had no record. A pure
    // record-ordinal fallback would place both strips after agent 1/2.
    const base = { type: "turn.artifacts", sessionId: "s" } as PiScienceEvent;
    state = foldEvent(state, { ...base, turnId: "turn-2", turnOrdinal: 2, artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] });
    state = foldEvent(state, { ...base, turnId: "turn-3", turnOrdinal: 3, artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] });
    expect(state.blocks.map((block) => block.kind)).toEqual(["user", "agent", "user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(state.blocks[4]).toMatchObject({ turnId: "turn-2" });
    expect(state.blocks[7]).toMatchObject({ turnId: "turn-3" });
    expect((state.blocks[4] as { turnOrdinal?: number }).turnOrdinal).toBe(2);
  });

  it("deduplicates by turn id, replacing in place", () => {
    let state = threadWith([{ kind: "user", id: "user-1", text: "hi" }]);
    const base = { type: "turn.artifacts", sessionId: "s", turnId: "turn-1" } as PiScienceEvent;
    state = foldEvent(state, { ...base, artifacts: [{ path: "a.png", kind: "image", mime: "image/png", size: 1 }] });
    state = foldEvent(state, { ...base, artifacts: [{ path: "a.png", kind: "image", mime: "image/png", size: 1 }, { path: "b.csv", kind: "table", mime: "text/csv", size: 2 }] });
    const summaries = state.blocks.filter((block) => block.kind === "artifact-summary");
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { artifacts: unknown[] }).artifacts).toHaveLength(2);
  });

  it("ignores empty artifact lists", () => {
    const state = threadWith([{ kind: "user", id: "user-1", text: "hi" }]);
    const next = foldEvent(state, { type: "turn.artifacts", sessionId: "s", turnId: "turn-1", artifacts: [] } as PiScienceEvent);
    expect(next.blocks.filter((block) => block.kind === "artifact-summary")).toHaveLength(0);
  });

  it("anchors at the turn end when a turn spans several assistant messages without ids", () => {
    let state = threadWith([{ kind: "user", id: "user-1", text: "analyze" }]);
    // Part ids mirror Pi's anonymous-N series: one narration message, then the
    // final answer — the strip must land after the LAST one, not in between.
    state = foldEvent(state, { type: "text.updated", sessionId: "s", partId: "anonymous-2", text: "narration" });
    state = foldEvent(state, { type: "text.updated", sessionId: "s", partId: "anonymous-3", text: "final answer" });
    state = foldEvent(state, { type: "turn.artifacts", sessionId: "s", turnId: "turn-1", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] });
    expect(state.blocks.map((block) => block.kind)).toEqual(["user", "agent", "agent", "artifact-summary"]);
    expect(state.index["turn-artifacts-turn-1"]).toBe(3);
  });

  it("anchors each strip at its own turn's end across two multi-message turns", () => {
    let state = threadWith([{ kind: "user", id: "user-1", text: "go" }]);
    const base = { type: "turn.artifacts", sessionId: "s" } as PiScienceEvent;
    // Turn 1: two assistant messages.
    state = foldEvent(state, { type: "text.updated", sessionId: "s", partId: "anonymous-2", text: "r1a" });
    state = foldEvent(state, { type: "text.updated", sessionId: "s", partId: "anonymous-3", text: "r1b" });
    state = foldEvent(state, { ...base, turnId: "turn-1", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] });
    // Turn 2 (agent_start clears the turn state) with two assistant messages.
    resetTurnBuffer();
    state = foldEvent(state, { type: "text.updated", sessionId: "s", partId: "anonymous-4", text: "r2a" });
    state = foldEvent(state, { type: "text.updated", sessionId: "s", partId: "anonymous-5", text: "r2b" });
    state = foldEvent(state, { ...base, turnId: "turn-2", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] });
    expect(state.blocks.map((block) => block.kind)).toEqual(["user", "agent", "agent", "artifact-summary", "agent", "agent", "artifact-summary"]);
    expect(state.blocks[3]).toMatchObject({ turnId: "turn-1" });
    expect(state.blocks[6]).toMatchObject({ turnId: "turn-2" });
  });

  it("treats an exact assistant message id as a turn anchor, not as an insertion position (FR-02)", () => {
    let state = threadWith([
      { kind: "user", id: "user-1", text: "x" },
      { kind: "agent", id: "exact", parts: [{ id: "exact", text: "matched" }] },
    ]);
    // A later live text block moves the turn-end anchor away from "exact".
    state = foldEvent(state, { type: "text.updated", sessionId: "s", partId: "live-part", text: "live text" });
    state = foldEvent(state, { type: "turn.artifacts", sessionId: "s", turnId: "turn-1", assistantMessageId: "exact", artifacts: [{ path: "a.png", kind: "image", mime: "image/png", size: 1 }] });
    // The strip lands after the turn's FINAL assistant message ("live-part"),
    // not right after "exact".
    expect(state.index["turn-artifacts-turn-1"]).toBe(3);
    expect(state.blocks[2]).toMatchObject({ id: "live-part" });
  });

  it("anchors after the final assistant message when the exact id is intermediate (T02)", () => {
    let state = threadWith([
      { kind: "user", id: "user-1", text: "analyze" },
      { kind: "agent", id: "agent-1", parts: [{ id: "agent-1", text: "narration" }] },
      { kind: "agent", id: "agent-2", parts: [{ id: "agent-2", text: "final answer" }] },
    ]);
    state = foldEvent(state, { type: "turn.artifacts", sessionId: "s", turnId: "turn-1", assistantMessageId: "agent-1", artifacts: [{ path: "result.csv", kind: "table", mime: "text/csv", size: 128 }] });
    expect(state.blocks.map((block) => block.kind)).toEqual(["user", "agent", "agent", "artifact-summary"]);
    expect(state.index["turn-artifacts-turn-1"]).toBe(3);
  });

  it("inserts a delayed artifact back into its own turn after the next user message (T04)", () => {
    let state = threadWith([
      { kind: "user", id: "user-1", text: "a" },
      { kind: "agent", id: "agent-1", parts: [{ id: "agent-1", text: "r1" }] },
      { kind: "user", id: "user-2", text: "b" },
      { kind: "agent", id: "agent-2", parts: [{ id: "agent-2", text: "r2" }] },
    ]);
    state = foldEvent(state, { type: "turn.artifacts", sessionId: "s", turnId: "turn-1", assistantMessageId: "agent-1", artifacts: [{ path: "x.csv", kind: "table", mime: "text/csv", size: 2 }] });
    expect(state.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent"]);
    expect(state.index["turn-artifacts-turn-1"]).toBe(2);
  });

  it("appends to the thread end for a tool-only turn without agent blocks", () => {
    let state = threadWith([
      { kind: "user", id: "user-1", text: "x" },
      { kind: "tool", id: "tool-1", callId: "c1", tool: "bash", status: "done" },
    ]);
    state = foldEvent(state, { type: "turn.artifacts", sessionId: "s", turnId: "turn-1", artifacts: [{ path: "a.csv", kind: "table", mime: "text/csv", size: 2 }] });
    expect(state.blocks.at(-1)).toMatchObject({ kind: "artifact-summary", turnId: "turn-1" });
  });
});

describe("attachTurnArtifacts (history restore)", () => {
  it("inserts persisted summaries after matching assistant messages", () => {
    const thread = threadWith([
      { kind: "user", id: "user-1", text: "a" },
      { kind: "agent", id: "agent-1", parts: [{ id: "agent-1", text: "r1" }] },
      { kind: "user", id: "user-2", text: "b" },
      { kind: "agent", id: "agent-2", parts: [{ id: "agent-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: "agent-1", turn_ordinal: null, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: "agent-2", turn_ordinal: null, ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
  });

  it("repositions a persisted intermediate assistant id to the turn's final message (T05)", () => {
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "narration" }] },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "final" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: "msg-1", turn_ordinal: null, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "agent", "artifact-summary"]);
    expect(next.index["turn-artifacts-turn-1"]).toBe(3);
  });

  it("is idempotent across repeated calls and skips already-attached turns", () => {
    const thread = threadWith([
      { kind: "user", id: "u", text: "a" },
      { kind: "agent", id: "a1", parts: [{ id: "a1", text: "r" }] },
    ]);
    const turns = [{ turn_id: "turn-1", session_id: "s", assistant_message_id: "a1", turn_ordinal: null, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] }];
    const once = attachTurnArtifacts(thread, turns);
    const twice = attachTurnArtifacts(once, turns);
    expect(twice.blocks.filter((block) => block.kind === "artifact-summary")).toHaveLength(1);
  });

  it("attaches by turn order when persisted ids are absent", () => {
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: null, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: null, ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(next.blocks[2]).toMatchObject({ turnId: "turn-1" });
    expect(next.blocks[5]).toMatchObject({ turnId: "turn-2" });
  });

  it("resolves duplicate ordinals by record position (stale runtime-rebuild data)", () => {
    // Legacy data: two records both carry turn_ordinal=1 because the counter
    // used to live on the runtime record and reset on rebuild. Each strip must
    // still land in its own turn (1st and 2nd turn ends).
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(next.index["turn-artifacts-turn-1"]).toBe(2);
    expect(next.index["turn-artifacts-turn-2"]).toBe(5);
  });

  it("resolves mixed legacy+new ordinals [1,1,2] by record position after the duplicate", () => {
    // Browser-verified failure (session 019fdd43): legacy records 1MBO/1LYZ
    // both carry turn_ordinal=1 (runtime-rebuild counter reset), then a new
    // record 2PTN carries turn_ordinal=2 (nextTurnOrdinal = max(1)+1). The
    // ordinal=2 is unique but its true turn is 3; once the sequence is known
    // broken (duplicate seen), every later record must use its record
    // position so all three strips land in turns 1/2/3.
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
      { kind: "user", id: "u3", text: "c" },
      { kind: "agent", id: "msg-3", parts: [{ id: "msg-3", text: "r3" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1mbo", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "t", artifacts: [{ path: "1MBO.pdb", kind: "structure", mime: "text/plain", size: 1 }] },
      { turn_id: "turn-1lyz", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "t", artifacts: [{ path: "1LYZ.pdb", kind: "structure", mime: "text/plain", size: 2 }] },
      { turn_id: "turn-2ptn", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "t", artifacts: [{ path: "2PTN.pdb", kind: "structure", mime: "text/plain", size: 3 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual([
      "user", "agent", "artifact-summary",
      "user", "agent", "artifact-summary",
      "user", "agent", "artifact-summary",
    ]);
    expect(next.index["turn-artifacts-turn-1mbo"]).toBe(2);
    expect(next.index["turn-artifacts-turn-1lyz"]).toBe(5);
    expect(next.index["turn-artifacts-turn-2ptn"]).toBe(8);
  });

  it("keeps unique ordinals authoritative over record order", () => {
    // turn-1 has no record; turn-2/turn-3 carry ordinals 2/3 (unique). The
    // record order fallback must not take over when ordinals are unique.
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
      { kind: "user", id: "u3", text: "c" },
      { kind: "agent", id: "msg-3", parts: [{ id: "msg-3", text: "r3" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-3", session_id: "s", assistant_message_id: null, turn_ordinal: 3, ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(next.index["turn-artifacts-turn-2"]).toBe(4);
    expect(next.index["turn-artifacts-turn-3"]).toBe(7);
  });

  it("anchors by turn_ordinal when earlier turns produced no records", () => {
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
      { kind: "user", id: "u3", text: "c" },
      { kind: "agent", id: "msg-3", parts: [{ id: "msg-3", text: "r3" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-3", session_id: "s", assistant_message_id: null, turn_ordinal: 3, ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(next.blocks[4]).toMatchObject({ turnId: "turn-2" });
    expect(next.blocks[7]).toMatchObject({ turnId: "turn-3" });
  });

  it("anchors by ended_at across record-less turns with out-of-order write times (session 019fdd43)", () => {
    // Browser-verified failure: four turns, the third (u3/msg-3) produced no
    // artifact record; legacy duplicate ordinals [1,1] plus a new ordinal 2
    // cannot express the gap. The ended_at timestamp identifies the true turn
    // even when JSONL write order differs from chronological order (turn A
    // at 17:27 is written BEFORE turn B at 17:12).
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a", timestamp: "2026-08-07T17:27:02.000Z" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }], timestamp: "2026-08-07T17:27:37.000Z" },
      { kind: "user", id: "u2", text: "b", timestamp: "2026-08-07T17:12:17.000Z" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }], timestamp: "2026-08-07T17:12:39.000Z" },
      { kind: "user", id: "u3", text: "c", timestamp: "2026-08-07T17:32:55.000Z" },
      { kind: "agent", id: "msg-3", parts: [{ id: "msg-3", text: "r3" }], timestamp: "2026-08-07T17:33:24.000Z" },
      { kind: "user", id: "u4", text: "d", timestamp: "2026-08-09T07:45:47.000Z" },
      { kind: "agent", id: "msg-4", parts: [{ id: "msg-4", text: "r4" }], timestamp: "2026-08-09T07:46:02.000Z" },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1mbo", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "2026-08-07T17:27:37.836Z", artifacts: [{ path: "1MBO.pdb", kind: "structure", mime: "text/plain", size: 1 }] },
      { turn_id: "turn-1lyz", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "2026-08-07T17:12:39.091Z", artifacts: [{ path: "1LYZ.pdb", kind: "structure", mime: "text/plain", size: 2 }] },
      { turn_id: "turn-2ptn", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "2026-08-09T07:46:02.885Z", artifacts: [{ path: "2PTN.pdb", kind: "structure", mime: "text/plain", size: 3 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual([
      "user", "agent", "artifact-summary",
      "user", "agent", "artifact-summary",
      "user", "agent",
      "user", "agent", "artifact-summary",
    ]);
    // 1MBO after turn A (u1/msg-1), 1LYZ after turn B (u2/msg-2), 2PTN after
    // turn D (u4/msg-4) — the record-less turn C (u3/msg-3) is skipped.
    expect(next.index["turn-artifacts-turn-1mbo"]).toBe(2);
    expect(next.index["turn-artifacts-turn-1lyz"]).toBe(5);
    expect(next.index["turn-artifacts-turn-2ptn"]).toBe(10);
  });

  it("falls back to ordinals when no timestamped user block exists", () => {
    // Paged history can lack user timestamps: ended_at anchoring must give up
    // and let the ordinal/record-position path take over.
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "2026-08-07T17:27:37.836Z", artifacts: [{ path: "1MBO.pdb", kind: "structure", mime: "text/plain", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "2026-08-07T17:12:39.091Z", artifacts: [{ path: "1LYZ.pdb", kind: "structure", mime: "text/plain", size: 2 }] },
    ]);
    expect(next.index["turn-artifacts-turn-1"]).toBe(2);
    expect(next.index["turn-artifacts-turn-2"]).toBe(5);
  });

  it("anchors at the turn end when only a tail history page is loaded", () => {
    const thread = threadWith([
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "earlier" }], timestamp: "2026-08-28T03:28:09.000Z" },
      { kind: "tool", id: "tool-1", callId: "call-1", tool: "bash", status: "done" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "final" }], timestamp: "2026-08-28T03:33:10.000Z" },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "2026-08-28T03:33:17.479Z", artifacts: [{ path: "result.csv", kind: "table", mime: "text/csv", size: 1 }] },
    ]);
    expect(next.index["turn-artifacts-turn-1"]).toBe(3);
    expect(next.blocks.at(-1)).toMatchObject({ turnId: "turn-1" });
  });

  it("uses agent timestamps when tail history is out of write order", () => {
    const thread = threadWith([
      { kind: "agent", id: "msg-late", parts: [{ id: "msg-late", text: "target" }], timestamp: "2026-08-28T03:33:10.000Z" },
      { kind: "agent", id: "msg-early", parts: [{ id: "msg-early", text: "older" }], timestamp: "2026-08-28T03:28:09.000Z" },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "2026-08-28T03:33:17.479Z", artifacts: [{ path: "result.csv", kind: "table", mime: "text/csv", size: 1 }] },
    ]);
    expect(next.index["turn-artifacts-turn-1"]).toBe(1);
    expect(next.blocks[0]).toMatchObject({ id: "msg-late" });
  });

  it("anchors by turn_ordinal to the END of a multi-message turn", () => {
    // Turn 1 spans two assistant messages (anonymous part ids, no message id)
    // — the strip must land after the LAST one, not between them.
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1a", parts: [{ id: "msg-1a", text: "r1a" }] },
      { kind: "agent", id: "msg-1b", parts: [{ id: "msg-1b", text: "r1b" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(next.blocks[3]).toMatchObject({ turnId: "turn-1" });
    expect(next.blocks[6]).toMatchObject({ turnId: "turn-2" });
    expect(next.index["turn-artifacts-turn-1"]).toBe(3);
    expect(next.index["turn-artifacts-turn-2"]).toBe(6);
  });

  it("anchors a tool-only turn at its own span end", () => {
    // Turn 1 produces no assistant text (tool-only) — the strip belongs at the
    // end of turn 1's span (before the next user message), not at the thread end.
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "tool", id: "tool-1", callId: "c1", tool: "bash", status: "done" },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "tool", "artifact-summary", "user", "agent"]);
    expect(next.index["turn-artifacts-turn-1"]).toBe(2);
  });

  it("falls back to the n-th agent block when user boundaries are missing", () => {
    // Paged history without early user messages: afterTurnEnd cannot delimit
    // turns, so it falls back to the ordinal-th agent block approximation.
    const thread = threadWith([
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
    ]);
    expect(next.index["turn-artifacts-turn-2"]).toBe(2);
  });

  it("repositions a strip already inserted at a fallback position by SSE replay", () => {
    // SSE replay folded turn-2 at the record-ordinal fallback position
    // (after the first agent block) because the full history had not arrived.
    const replayed = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "artifact-summary", id: "turn-artifacts-turn-2", turnId: "turn-2", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(replayed, [
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "user", "agent", "artifact-summary"]);
    expect(next.blocks[4]).toMatchObject({ turnId: "turn-2" });
    expect(next.index["turn-artifacts-turn-2"]).toBe(4);
  });

  it("mixes exact id matches and turn-order fallback", () => {
    const thread = threadWith([
      { kind: "user", id: "u1", text: "a" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }] },
      { kind: "user", id: "u2", text: "b" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }] },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: "msg-1", turn_ordinal: null, ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: null, ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(next.blocks[2]).toMatchObject({ turnId: "turn-1" });
    expect(next.blocks[5]).toMatchObject({ turnId: "turn-2" });
  });

  it("appends turns whose assistant message is not in the loaded page", () => {
    const thread = threadWith([{ kind: "user", id: "u", text: "a" }]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: "missing-msg", turn_ordinal: null, ended_at: "t", artifacts: [{ path: "z.md", kind: "text", mime: "text/markdown", size: 3 }] },
    ]);
    expect(next.blocks.at(-1)).toMatchObject({ kind: "artifact-summary", turnId: "turn-1" });
  });

  it("defers a strip whose turn is outside a partial history window (windowComplete: false)", () => {
    // Restore path: only the LAST page is loaded. The old turn's user/agent
    // blocks are not in the window, so every guess-based anchor would land
    // the strip on the newer turn — defer it instead.
    const thread = threadWith([
      { kind: "user", id: "u2", text: "b", timestamp: "2026-08-30T04:39:32.000Z" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }], timestamp: "2026-08-30T04:40:39.000Z" },
    ]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "2026-08-29T16:44:56.000Z", artifacts: [{ path: "old.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "2026-08-30T04:40:39.064Z", artifacts: [{ path: "new.png", kind: "image", mime: "image/png", size: 2 }] },
    ], { windowComplete: false });
    const strips = next.blocks.filter((block) => block.kind === "artifact-summary");
    expect(strips).toHaveLength(1);
    expect(strips[0]).toMatchObject({ turnId: "turn-2" });
    expect(next.index["turn-artifacts-turn-2"]).toBe(2);
  });

  it("places a deferred strip after its own turn once the older page is prepended", () => {
    const tail = threadWith([
      { kind: "user", id: "u2", text: "b", timestamp: "2026-08-30T04:39:32.000Z" },
      { kind: "agent", id: "msg-2", parts: [{ id: "msg-2", text: "r2" }], timestamp: "2026-08-30T04:40:39.000Z" },
    ]);
    const turns = [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: null, turn_ordinal: 1, ended_at: "2026-08-29T16:44:56.000Z", artifacts: [{ path: "old.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: null, turn_ordinal: 2, ended_at: "2026-08-30T04:40:39.064Z", artifacts: [{ path: "new.png", kind: "image", mime: "image/png", size: 2 }] },
    ];
    const deferred = attachTurnArtifacts(tail, turns, { windowComplete: false });
    // The older page arrives (loadHistoryPage prepends it), then attach re-runs.
    const older = threadWith([
      { kind: "user", id: "u1", text: "a", timestamp: "2026-08-29T16:42:58.000Z" },
      { kind: "agent", id: "msg-1", parts: [{ id: "msg-1", text: "r1" }], timestamp: "2026-08-29T16:44:56.000Z" },
    ]);
    const mergedBlocks = [...older.blocks, ...deferred.blocks];
    const index: Record<string, number> = {};
    mergedBlocks.forEach((block, position) => { index[block.id] = position; });
    const full = attachTurnArtifacts({ blocks: mergedBlocks, index, loaded: true }, turns, { windowComplete: true });
    expect(full.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
    expect(full.blocks[2]).toMatchObject({ turnId: "turn-1" });
    expect(full.blocks[5]).toMatchObject({ turnId: "turn-2" });
  });
});
