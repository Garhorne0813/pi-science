import { describe, expect, it } from "vitest";
import { attachTurnArtifacts, emptyThread, foldEvent } from "./event-fold";
import type { Thread } from "./event-fold";
import type { PiScienceEvent } from "../client/pi-science-client";

function threadWith(blocks: Array<{ kind: string; id: string; [key: string]: unknown }>): Thread {
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks: blocks as Thread["blocks"], index, loaded: true };
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
      { turn_id: "turn-1", session_id: "s", assistant_message_id: "agent-1", ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] },
      { turn_id: "turn-2", session_id: "s", assistant_message_id: "agent-2", ended_at: "t", artifacts: [{ path: "y.csv", kind: "table", mime: "text/csv", size: 2 }] },
    ]);
    expect(next.blocks.map((block) => block.kind)).toEqual(["user", "agent", "artifact-summary", "user", "agent", "artifact-summary"]);
  });

  it("is idempotent across repeated calls and skips already-attached turns", () => {
    const thread = threadWith([
      { kind: "user", id: "u", text: "a" },
      { kind: "agent", id: "a1", parts: [{ id: "a1", text: "r" }] },
    ]);
    const turns = [{ turn_id: "turn-1", session_id: "s", assistant_message_id: "a1", ended_at: "t", artifacts: [{ path: "x.png", kind: "image", mime: "image/png", size: 1 }] }];
    const once = attachTurnArtifacts(thread, turns);
    const twice = attachTurnArtifacts(once, turns);
    expect(twice.blocks.filter((block) => block.kind === "artifact-summary")).toHaveLength(1);
  });

  it("appends turns whose assistant message is not in the loaded page", () => {
    const thread = threadWith([{ kind: "user", id: "u", text: "a" }]);
    const next = attachTurnArtifacts(thread, [
      { turn_id: "turn-1", session_id: "s", assistant_message_id: "missing-msg", ended_at: "t", artifacts: [{ path: "z.md", kind: "text", mime: "text/markdown", size: 3 }] },
    ]);
    expect(next.blocks.at(-1)).toMatchObject({ kind: "artifact-summary", turnId: "turn-1" });
  });
});
