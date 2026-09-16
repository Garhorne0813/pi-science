import { describe, expect, it } from "vitest";

import { buildTurnPresentations } from "../conversation/turn-presentation";
import type { PiScienceEvent } from "../client/types";
import { emptyThread, foldEvent } from "./event-fold";

function envelope(overrides: Record<string, unknown>): PiScienceEvent {
  const seq = Number(overrides.seq ?? 0);
  return {
    schemaVersion: 2,
    workspaceId: "/workspace",
    sessionId: "session-v2",
    streamEpoch: "epoch-1",
    eventId: `epoch-1:${seq}`,
    seq,
    turnId: "turn-1",
    runId: "run-1",
    occurredAt: "2026-09-16T00:00:00.000Z",
    type: "run.started",
    payload: {},
    ...overrides,
  };
}

describe("V2 content ownership", () => {
  it("does not treat a reused part id in a later run as a stale revision", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started" }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "item.text.delta",
      itemId: "anonymous-20",
      payload: { partId: "anonymous-20:0", phase: "final_answer", baseRevision: 0, revision: 1, text: "run one final" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, type: "run.completed", payload: { outcome: "ok" } }));
    thread = foldEvent(thread, envelope({ seq: 4, type: "run.started", turnId: "turn-2", runId: "run-2" }));
    thread = foldEvent(thread, envelope({
      seq: 5,
      type: "item.text.delta",
      turnId: "turn-2",
      runId: "run-2",
      itemId: "anonymous-20",
      payload: { partId: "anonymous-20:0", phase: "final_answer", baseRevision: 0, revision: 1, text: "run two final" },
    }));

    const agents = thread.blocks.filter((block) => block.kind === "agent");
    expect(agents).toEqual([
      expect.objectContaining({ turnId: "turn-1", runId: "run-1", parts: [{ id: "anonymous-20:0", text: "run one final" }] }),
      expect.objectContaining({ turnId: "turn-2", runId: "run-2", parts: [{ id: "anonymous-20:0", text: "run two final" }] }),
    ]);
    expect(thread.foldState?.reconciliationRequired).toBe(false);
  });

  it("does not append a later run into the earlier run when the reused part revision happens to continue", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started" }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "item.text.delta",
      itemId: "anonymous-20",
      payload: { partId: "anonymous-20:0", phase: "final_answer", baseRevision: 0, revision: 1, text: "first answer" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, type: "run.completed", payload: { outcome: "ok" } }));
    thread = foldEvent(thread, envelope({ seq: 4, type: "run.started", turnId: "turn-2", runId: "run-2" }));
    thread = foldEvent(thread, envelope({
      seq: 5,
      type: "item.text.delta",
      turnId: "turn-2",
      runId: "run-2",
      itemId: "anonymous-20",
      payload: { partId: "anonymous-20:0", phase: "final_answer", baseRevision: 1, revision: 2, text: "second answer" },
    }));

    const agents = thread.blocks.filter((block) => block.kind === "agent");
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ turnId: "turn-1", runId: "run-1", parts: [{ id: "anonymous-20:0", text: "first answer" }] });
    expect(agents[1]).toMatchObject({ turnId: "turn-2", runId: "run-2", parts: [{ id: "anonymous-20:0", text: "second answer" }] });

    const turnOne = buildTurnPresentations(thread.blocks).find((turn) => turn.turnId === "turn-1");
    expect(turnOne?.finalAgent).toMatchObject({
      turnId: "turn-1",
      runId: "run-1",
      parts: [{ id: "anonymous-20:0", text: "first answer" }],
    });
  });

  it("isolates reused thinking part ids across runs", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started" }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "thinking.updated",
      itemId: "anonymous-21",
      payload: { partId: "anonymous-21:0", baseRevision: 0, revision: 1, text: "reason one" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, type: "run.completed", payload: { outcome: "ok" } }));
    thread = foldEvent(thread, envelope({ seq: 4, type: "run.started", turnId: "turn-2", runId: "run-2" }));
    thread = foldEvent(thread, envelope({
      seq: 5,
      type: "thinking.updated",
      turnId: "turn-2",
      runId: "run-2",
      itemId: "anonymous-21",
      payload: { partId: "anonymous-21:0", baseRevision: 0, revision: 1, text: "reason two" },
    }));

    const thinking = thread.blocks.filter((block) => block.kind === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]).toMatchObject({ turnId: "turn-1", runId: "run-1" });
    expect(thinking[0]?.kind === "thinking" && thinking[0].parts[0]?.text).toBe("reason one");
    expect(thinking[1]).toMatchObject({ turnId: "turn-2", runId: "run-2" });
    expect(thinking[1]?.kind === "thinking" && thinking[1].parts[0]?.text).toBe("reason two");
  });
});
