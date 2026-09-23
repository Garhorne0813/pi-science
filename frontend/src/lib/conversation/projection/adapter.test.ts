import { describe, expect, it } from "vitest";
import type { Thread } from "../../agent-runtime/event-fold";
import type { ThreadBlock } from "../../../types/thread";
import { latestByRevision, LEGACY_STREAM_EPOCH, projectConversation } from "./adapter";

function thread(blocks: ThreadBlock[], foldState?: Thread["foldState"]): Thread {
  return { blocks, index: Object.fromEntries(blocks.map((block, index) => [block.id, index])), loaded: true, ...(foldState ? { foldState } : {}) };
}

describe("conversation projection adapter", () => {
  it("projects a turn with stable protocol identities and a unique final answer", () => {
    const projection = projectConversation(thread([
      { kind: "user", id: "user-local", itemId: "user-item", turnId: "turn-1", revision: 1, text: "question" },
      { kind: "tool", id: "tool-local", itemId: "tool-item", turnId: "turn-1", revision: 2, callId: "call-1", tool: "python", status: "done", output: "42" },
      { kind: "agent", id: "agent-local", itemId: "answer-item", turnId: "turn-1", revision: 3, presentationRole: "final", parts: [{ id: "part-1", text: "answer" }] },
    ]), { lastTurnLifecycle: "settled", lastTurnId: "turn-1", streamEpoch: "epoch-1", throughSeq: 9 });

    expect(projection).toMatchObject({ streamEpoch: "epoch-1", throughSeq: 9, sessionState: "idle" });
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]).toMatchObject({ id: "turn-1", revision: 3, user: { id: "user-item", revision: 1 }, answer: { id: "answer-item", revision: 3, role: "final", state: "complete", markdown: "answer" } });
    expect(projection.turns[0].activities).toEqual([expect.objectContaining({ id: "tool-local", revision: 2, kind: "kernel", state: "success" })]);
  });

  it("separates pending interactions and keeps the active answer provisional", () => {
    const projection = projectConversation(thread([
      { kind: "user", id: "u1", turnId: "turn-1", text: "question" },
      { kind: "tool", id: "approval", itemId: "approval-item", turnId: "turn-1", revision: 4, callId: "approval-call", tool: "permission_request", status: "waiting-approval", title: "Install scipy" },
      { kind: "agent", id: "draft", itemId: "draft-item", turnId: "turn-1", revision: 5, partial: true, parts: [{ id: "draft-part", text: "working" }] },
    ]), { lastTurnLifecycle: "waiting", lastTurnId: "turn-1" });

    expect(projection.activeTurnId).toBe("turn-1");
    expect(projection.sessionState).toBe("waiting_user");
    expect(projection.turns[0].interactions).toEqual([expect.objectContaining({ id: "approval", state: "pending", kind: "permission" })]);
    expect(projection.turns[0].activities.map((activity) => activity.id)).not.toContain("approval");
    expect(projection.turns[0].answer).toMatchObject({ role: "provisional", state: "streaming" });
  });

  it("uses an explicit legacy epoch and stable artifact fallback identities", () => {
    const projection = projectConversation(thread([
      { kind: "user", id: "u1", turnId: "turn-1", text: "question" },
      { kind: "artifact-summary", id: "summary-1", turnId: "turn-1", artifacts: [{ path: "results/fit.csv", kind: "data", mime: "text/csv", size: 12 }] },
    ]));

    expect(projection.streamEpoch).toBe(LEGACY_STREAM_EPOCH);
    expect(projection.turns[0].artifacts).toEqual([expect.objectContaining({ id: "summary-1:results/fit.csv", filename: "fit.csv", kind: "dataset", state: "published" })]);
  });

  it("updates a versioned artifact in place and drops a stale replay", () => {
    const projection = projectConversation(thread([
      { kind: "user", id: "u1", turnId: "turn-1", text: "question" },
      { kind: "artifact-summary", id: "summary-1", turnId: "turn-1", artifacts: [
        { path: "results/fit-v2.csv", artifactId: "artifact-fit", version: 2, revision: 3, state: "published", kind: "data", mime: "text/csv", size: 20 },
        { path: "results/fit-v1.csv", artifactId: "artifact-fit", version: 1, kind: "data", mime: "text/csv", size: 10 },
      ] },
    ]));
    expect(projection.turns[0].artifacts).toEqual([expect.objectContaining({ id: "artifact-fit", version: 2, revision: 3, state: "published", path: "results/fit-v2.csv" })]);
  });

  it("keeps the first position while replacing only with a newer revision", () => {
    expect(latestByRevision([
      { id: "a", revision: 2, value: "current" },
      { id: "b", revision: 1, value: "second" },
      { id: "a", revision: 1, value: "stale" },
      { id: "b", revision: 3, value: "new" },
    ])).toEqual([
      { id: "a", revision: 2, value: "current" },
      { id: "b", revision: 3, value: "new" },
    ]);
  });
});
