/** Ownership isolation of the fold's content bookkeeping.
 *
 *  Content keys are raw part/item ids. A later run may reuse the exact same id,
 *  and the fold must then treat it as new content: its own revision waterline,
 *  its own replayed segments, its own materialized block. These cases are the
 *  acceptance matrix for that boundary. */

import { describe, expect, it } from "vitest";

import { emptyThread, foldEvent, type Thread } from "./event-fold";
import type { PiScienceEvent } from "../client/types";
import type { ThreadBlock } from "../../types/thread";
import { installRuntimeTestEnvironment } from "./test-helpers";

installRuntimeTestEnvironment();

const envelope = (overrides: Record<string, unknown>): PiScienceEvent => ({
  schemaVersion: 2,
  workspaceId: "/workspace",
  sessionId: "session-v2",
  streamEpoch: "epoch-1",
  eventId: `epoch-1:${String(overrides.seq)}`,
  seq: 0,
  turnId: "turn-1",
  runId: "run-1",
  occurredAt: "2026-09-08T00:00:00.000Z",
  type: "run.started",
  payload: {},
  ...overrides,
});

function texts(thread: Thread, kind: ThreadBlock["kind"]): string[] {
  return thread.blocks
    .filter((block) => block.kind === kind)
    .map((block) => block.kind === "thinking" || block.kind === "agent" ? block.parts.map((part) => part.text).join("") : "");
}

function agentTexts(thread: Thread): string[] {
  return texts(thread, "agent");
}

describe("run-scoped fold ownership", () => {
  it("starts each run's content from an empty revision waterline (case A)", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, runId: "run-1", turnId: "turn-1" }));
    thread = foldEvent(thread, envelope({
      seq: 2, runId: "run-1", turnId: "turn-1", itemId: "anonymous-20",
      type: "item.text.delta",
      payload: { partId: "anonymous-20:0", baseRevision: 0, revision: 1, text: "first" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, runId: "run-1", turnId: "turn-1", itemId: "anonymous-20", type: "item.completed", payload: { revision: 1 } }));
    thread = foldEvent(thread, envelope({ seq: 4, runId: "run-1", turnId: "turn-1", type: "run.completed", payload: {} }));

    // The next run reuses the identical part id, and its revision counter
    // starts over at the same base an earlier run already consumed.
    thread = foldEvent(thread, envelope({ seq: 5, runId: "run-2", turnId: "turn-2" }));
    thread = foldEvent(thread, envelope({
      seq: 6, runId: "run-2", turnId: "turn-2", itemId: "anonymous-20",
      type: "item.text.delta",
      payload: { partId: "anonymous-20:0", baseRevision: 0, revision: 1, text: "second" },
    }));

    expect(agentTexts(thread)).toEqual(["first", "second"]);
    expect(thread.foldState?.reconciliationRequired).toBe(false);
  });

  it("does not extend a previous run when the reused revisions look contiguous (case B)", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, runId: "run-1", turnId: "turn-1" }));
    thread = foldEvent(thread, envelope({
      seq: 2, runId: "run-1", turnId: "turn-1", itemId: "answer-1",
      type: "item.text.delta",
      payload: { partId: "answer-1", baseRevision: 0, revision: 1, text: "first answer" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, runId: "run-1", turnId: "turn-1", itemId: "answer-1", type: "item.completed", payload: { revision: 1 } }));
    thread = foldEvent(thread, envelope({ seq: 4, runId: "run-1", turnId: "turn-1", type: "run.completed", payload: {} }));

    thread = foldEvent(thread, envelope({ seq: 5, runId: "run-2", turnId: "turn-2" }));
    thread = foldEvent(thread, envelope({
      seq: 6, runId: "run-2", turnId: "turn-2", itemId: "answer-1",
      type: "item.text.delta",
      payload: { partId: "answer-1", baseRevision: 1, revision: 2, text: "second answer" },
    }));

    expect(agentTexts(thread)).toEqual(["first answer", "second answer"]);
    // The first turn's answer block is not rewritten by the second run.
    expect(thread.blocks.find((block) => block.kind === "agent" && block.turnId === "turn-1"))
      .toMatchObject({ parts: [expect.objectContaining({ text: "first answer" })] });
  });

  it("separates reused reasoning parts across runs (case C)", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, runId: "run-1", turnId: "turn-1" }));
    thread = foldEvent(thread, envelope({
      seq: 2, runId: "run-1", turnId: "turn-1", itemId: "anonymous-21",
      type: "thinking.updated",
      payload: { partId: "anonymous-21:0", baseRevision: 0, revision: 1, text: "reason one" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, runId: "run-1", turnId: "turn-1", type: "run.completed", payload: {} }));

    thread = foldEvent(thread, envelope({ seq: 4, runId: "run-2", turnId: "turn-2" }));
    thread = foldEvent(thread, envelope({
      seq: 5, runId: "run-2", turnId: "turn-2", itemId: "anonymous-21",
      type: "thinking.updated",
      payload: { partId: "anonymous-21:0", baseRevision: 0, revision: 1, text: "reason two" },
    }));

    expect(texts(thread, "thinking")).toEqual(["reason one", "reason two"]);
    expect(thread.foldState?.reconciliationRequired).toBe(false);
  });

  it("falls back to the turn when the wire carries no run id (case D)", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { type: "agent_start", sessionId: "session-legacy", turnId: "legacy-turn-1" });
    thread = foldEvent(thread, { type: "text.updated", sessionId: "session-legacy", turnId: "legacy-turn-1", partId: "p-1", text: "one" });
    thread = foldEvent(thread, { type: "session.idle", sessionId: "session-legacy", turnId: "legacy-turn-1" });
    thread = foldEvent(thread, { type: "agent_start", sessionId: "session-legacy", turnId: "legacy-turn-2" });
    thread = foldEvent(thread, { type: "text.updated", sessionId: "session-legacy", turnId: "legacy-turn-2", partId: "p-1", text: "two" });

    expect(agentTexts(thread)).toEqual(["one", "two"]);
    expect(thread.foldState?.contentStateOwner).toBe("turn:legacy-turn-2");
  });

  it("gives a reused part id its own block even inside the same turn", () => {
    // A later run reusing a part id must neither extend nor overwrite the
    // earlier row: the previous text stays visible and the new content gets
    // its own row, in the same turn.
    let thread = emptyThread();
    thread = foldEvent(thread, { type: "agent_start", sessionId: "session-legacy", turnId: "turn-1", runId: "run-1" });
    thread = foldEvent(thread, { type: "text.updated", sessionId: "session-legacy", turnId: "turn-1", runId: "run-1", partId: "p-1", text: "one" });
    thread = foldEvent(thread, { type: "tool.updated", sessionId: "session-legacy", turnId: "turn-1", runId: "run-1", callId: "call-1", tool: "bash", status: "done" });
    thread = foldEvent(thread, { type: "text.updated", sessionId: "session-legacy", turnId: "turn-1", runId: "run-2", partId: "p-1", text: "two" });

    const agents = thread.blocks.filter((block) => block.kind === "agent");
    expect(agentTexts(thread)).toEqual(["one", "two"]);
    expect(agents.every((block) => block.turnId === "turn-1")).toBe(true);
  });

  it("drops ownership bookkeeping across a stream epoch boundary (case E)", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, runId: "run-1", turnId: "turn-1" }));
    thread = foldEvent(thread, envelope({
      seq: 2, runId: "run-1", turnId: "turn-1", itemId: "answer-1",
      type: "item.text.delta",
      payload: { partId: "answer-1", baseRevision: 0, revision: 4, text: "old epoch" },
    }));
    expect(thread.foldState?.contentStateOwner).toBe("run:run-1");

    thread = foldEvent(thread, envelope({ seq: 1, streamEpoch: "epoch-2", runId: "run-1", turnId: "turn-1" }));
    expect(thread.foldState?.contentStateOwner).toBeUndefined();
    expect(thread.foldState?.contentStateByOwner).toBeUndefined();

    // The same run identity and part id in the new epoch is folded from an
    // empty waterline: revision 1 with an old base is accepted, not rejected.
    thread = foldEvent(thread, envelope({
      seq: 2, streamEpoch: "epoch-2", runId: "run-1", turnId: "turn-1", itemId: "answer-1",
      type: "item.text.delta",
      payload: { partId: "answer-1", baseRevision: 0, revision: 1, text: "new epoch" },
    }));
    expect(agentTexts(thread)).toContain("new epoch");
  });

  it("reconciles an earlier run's sequence gap without leaking into the next run (case F)", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, runId: "run-1", turnId: "turn-1" }));
    thread = foldEvent(thread, envelope({
      seq: 3, runId: "run-1", turnId: "turn-1", itemId: "answer-1",
      type: "item.text.delta",
      payload: { partId: "answer-1", baseRevision: 1, revision: 2, text: " world" },
    }));
    expect(thread.foldState?.reconciliationRequired).toBe(true);

    // The missing lower revision replays and rebuilds the canonical text.
    thread = foldEvent(thread, envelope({
      seq: 2, runId: "run-1", turnId: "turn-1", itemId: "answer-1",
      type: "item.text.delta",
      payload: { partId: "answer-1", baseRevision: 0, revision: 1, text: "hello" },
    }));
    expect(agentTexts(thread)).toEqual(["hello world"]);

    thread = foldEvent(thread, envelope({ seq: 4, runId: "run-1", turnId: "turn-1", type: "run.completed", payload: {} }));
    thread = foldEvent(thread, envelope({ seq: 5, runId: "run-2", turnId: "turn-2" }));
    thread = foldEvent(thread, envelope({
      seq: 6, runId: "run-2", turnId: "turn-2", itemId: "answer-1",
      type: "item.text.delta",
      payload: { partId: "answer-1", baseRevision: 1, revision: 2, text: "next turn" },
    }));

    expect(agentTexts(thread)).toEqual(["hello world", "next turn"]);
  });

  it("keeps one scope across records that carry no identity", () => {
    // `session.stats` consumes a stream position but ships no envelope at all.
    // Resolving it to a different boundary would rebuild the row it belongs to
    // and lose the text accumulated so far.
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({
      seq: 1, runId: undefined, turnId: undefined, itemId: "p-1",
      type: "text.updated", payload: { partId: "p-1", text: "hello" },
    }));
    thread = foldEvent(thread, envelope({
      seq: 2, runId: undefined, turnId: undefined, itemId: undefined,
      type: "session.stats", payload: {},
    }));
    thread = foldEvent(thread, envelope({
      seq: 3, runId: undefined, turnId: undefined, itemId: "p-1",
      type: "text.updated", payload: { partId: "p-1", text: " world" },
    }));

    expect(agentTexts(thread)).toEqual(["hello world"]);
    expect(thread.blocks.filter((block) => block.kind === "agent")).toHaveLength(1);
  });

  it("bounds the retained owner views", () => {
    let thread = emptyThread();
    for (let index = 0; index < 132; index += 1) {
      const seq = index * 2 + 1;
      thread = foldEvent(thread, envelope({ seq, runId: `run-${index}`, turnId: `turn-${index}`, eventId: `epoch-1:${seq}` }));
      thread = foldEvent(thread, envelope({
        seq: seq + 1, runId: `run-${index}`, turnId: `turn-${index}`, itemId: `item-${index}`, eventId: `epoch-1:${seq + 1}`,
        type: "item.text.delta",
        payload: { partId: `part-${index}`, baseRevision: 0, revision: 1, text: `t${index}` },
      }));
    }
    const owners = Object.keys(thread.foldState?.contentStateByOwner ?? {});
    expect(owners.length).toBeLessThanOrEqual(128);
  });
});
