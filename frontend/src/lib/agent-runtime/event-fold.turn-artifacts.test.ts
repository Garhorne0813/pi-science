import { describe, expect, it } from "vitest";
import { attachTurnArtifacts, foldEvent } from "./event-fold";
import type { Thread } from "./event-fold";
import type { PiScienceEvent } from "../client/pi-science-client";

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
});
