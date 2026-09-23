import { describe, expect, it } from "vitest";
import type { AgentMessageBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import { finalAgentInCompletedTurn, intermediateAgentsInTurn, provisionalAgentInActiveTurn } from "./turn-analysis";
import { buildTurnPresentations } from "./turn-presentation";

const user = (id: string): ThreadBlock => ({ kind: "user", id, text: id });
const agent = (id: string, partial = false): AgentMessageBlock => ({ kind: "agent", id, parts: [{ id: `${id}-part`, text: id }], ...(partial ? { partial: true } : {}) });
const tool = (id: string, name = "read", status: ToolCallBlock["status"] = "done"): ThreadBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status });
const inTurn = (block: ThreadBlock, turnId: string): ThreadBlock => ({ ...block, turnId } as ThreadBlock);

describe("turn analysis", () => {
  it("finds the final agent after the last execution tool", () => {
    const blocks = [agent("agent-a"), tool("tool-1"), agent("agent-b"), tool("tool-2"), agent("agent-c")];
    expect(finalAgentInCompletedTurn(blocks)?.id).toBe("agent-c");
    expect(intermediateAgentsInTurn(blocks).map((block) => block.id)).toEqual(["agent-a", "agent-b"]);
  });

  it("does not promote narration when the turn ends on an execution tool", () => {
    const blocks = [agent("agent-a"), tool("tool-1")];
    expect(finalAgentInCompletedTurn(blocks)).toBeNull();
    expect(intermediateAgentsInTurn(blocks).map((block) => block.id)).toEqual(["agent-a"]);
  });

  it("allows plan-control updates after the final answer", () => {
    const blocks = [tool("tool-1"), agent("agent-final"), tool("todo-1", "todo")];
    expect(finalAgentInCompletedTurn(blocks)?.id).toBe("agent-final");
  });

  it("keeps narration hidden while an interaction waits", () => {
    const blocks = [agent("agent-a"), tool("permission", "permission_request", "waiting-approval")];
    expect(finalAgentInCompletedTurn(blocks)).toBeNull();
    expect(intermediateAgentsInTurn(blocks).map((block) => block.id)).toEqual(["agent-a"]);
  });

  it("does not promote explicit intermediate commentary to a completed answer", () => {
    const blocks = [user("u1"), { ...agent("commentary"), presentationRole: "intermediate" as const }];
    const turn = buildTurnPresentations(blocks)[0];
    expect(turn.finalAgent).toBeNull();
    expect(turn.completed).toBe(false);
    expect(turn.intermediateAgents.map((block) => block.id)).toEqual(["commentary"]);
  });

  it("exposes live narration as provisional, never as final", () => {
    const blocks = [agent("agent-a"), tool("tool-1"), agent("answer-streaming")];
    expect(provisionalAgentInActiveTurn(blocks)?.id).toBe("answer-streaming");
    expect(finalAgentInCompletedTurn(blocks)?.id).toBe("answer-streaming");
  });
});

describe("buildTurnPresentations", () => {
  it("keeps resumed runtime turns inside one live user reply", () => {
    const blocks: ThreadBlock[] = [
      inTurn(user("u1"), "run-1"),
      inTurn(tool("read-1"), "run-1"),
      { ...agent("progress"), turnId: "run-2", presentationRole: "intermediate" },
      inTurn(tool("read-2", "read", "running"), "run-2"),
    ];
    const turns = buildTurnPresentations(blocks, { lastTurnId: "run-2", lastTurnLifecycle: "active" });
    expect(turns).toHaveLength(1);
    expect(turns[0].lifecycle).toBe("active");
    expect(turns[0].activityBlocks.map((block) => block.id)).toEqual(["read-1", "progress", "read-2"]);
  });

  it("routes a late artifact to its previous user turn without settling the live reply", () => {
    const turns = buildTurnPresentations([
      inTurn(user("u1"), "run-1"),
      inTurn(tool("first"), "run-1"),
      inTurn(user("u2"), "run-2"),
      inTurn(tool("second", "read", "running"), "run-2"),
      { kind: "artifact-summary", id: "late", turnId: "run-1", artifacts: [] },
    ], { lastTurnId: "run-2", lastTurnLifecycle: "active" });
    expect(turns).toHaveLength(2);
    expect(turns[0].artifacts.map((block) => block.id)).toEqual(["late"]);
    expect(turns[1].lifecycle).toBe("active");
  });

  it("aggregates narration-separated tools into one turn", () => {
    const turns = buildTurnPresentations([user("user-1"), agent("agent-a"), tool("tool-1"), agent("agent-b"), tool("tool-2"), agent("agent-c")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].executionTools.map((block) => block.id)).toEqual(["tool-1", "tool-2"]);
    expect(turns[0].intermediateAgents.map((block) => block.id)).toEqual(["agent-a", "agent-b"]);
    expect(turns[0].finalAgent?.id).toBe("agent-c");
  });

  it("splits turns at user blocks and keeps an orphan history prefix", () => {
    const turns = buildTurnPresentations([agent("orphan"), user("user-1"), agent("answer-1"), user("user-2"), agent("answer-2")]);
    expect(turns.map((turn) => turn.id)).toEqual(["orphan", "user-1", "user-2"]);
  });

  it("classifies todo and interaction without polluting execution", () => {
    const turn = buildTurnPresentations([user("user-1"), tool("read-1"), tool("todo-1", "todo"), tool("ask-1", "ask_user_question", "waiting-approval"), tool("grep-1", "grep")])[0];
    expect(turn.executionTools.map((block) => block.id)).toEqual(["read-1", "grep-1"]);
    expect(turn.planControlTools.map((block) => block.id)).toEqual(["todo-1"]);
    expect(turn.interactionTools.map((block) => block.id)).toEqual(["ask-1"]);
  });

  it("marks running tool-only turns incomplete and settled tool-only turns complete", () => {
    expect(buildTurnPresentations([user("user-1"), agent("agent-a"), tool("tool-1", "read", "running")])[0].completed).toBe(false);
    expect(buildTurnPresentations([user("user-1"), agent("agent-a"), tool("tool-1")])[0].completed).toBe(true);
  });

  it("demotes the active turn's answer to provisional while the turn streams", () => {
    const blocks = [user("user-1"), agent("agent-a"), tool("tool-1"), agent("answer")];
    const active = buildTurnPresentations(blocks, { lastTurnLifecycle: "active" })[0];
    expect(active.finalAgent).toBeNull();
    expect(active.provisionalAgent?.id).toBe("answer");
    expect(active.completed).toBe(false);
    const settled = buildTurnPresentations(blocks)[0];
    expect(settled.finalAgent?.id).toBe("answer");
    expect(settled.provisionalAgent).toBeNull();
    expect(settled.completed).toBe(true);
  });

  it("never marks earlier turns active even when the store is working", () => {
    const turns = buildTurnPresentations([user("u1"), agent("a1"), user("u2"), agent("a2")], { lastTurnLifecycle: "active" });
    expect(turns[0].active).toBe(false);
    expect(turns[1].active).toBe(true);
  });

  it("shows a semantic final answer while it is still streaming", () => {
    const turn = buildTurnPresentations([user("u1"), tool("tool-1"), { ...agent("final"), presentationRole: "final", partial: true }], { lastTurnLifecycle: "active" })[0];
    expect(turn.finalAgent?.id).toBe("final");
    expect(turn.provisionalAgent).toBeNull();
    expect(turn.completed).toBe(false);
  });

  it("does not promote provisional narration after abort or terminal failure", () => {
    const blocks = [user("u1"), agent("narration"), tool("tool-1"), agent("provisional")];
    for (const lifecycle of ["aborted", "failed"] as const) {
      const turn = buildTurnPresentations(blocks, { lastTurnLifecycle: lifecycle })[0];
      expect(turn.lifecycle).toBe(lifecycle);
      expect(turn.finalAgent).toBeNull();
      expect(turn.provisionalAgent).toBeNull();
      expect(turn.completed).toBe(false);
    }
  });

  it("keeps partial answer text beside a terminal stream error", () => {
    const blocks = [user("u1"), agent("partial-answer"), { kind: "status-line" as const, id: "error-1", text: "stream closed", level: "error" as const }];
    const turn = buildTurnPresentations(blocks, { lastTurnLifecycle: "failed" })[0];
    expect(turn.finalAgent).toBeNull();
    expect(turn.provisionalAgent?.id).toBe("partial-answer");
  });

  it("does not promote narration in a todo-only settled or failed turn", () => {
    for (const lifecycle of ["settled", "failed"] as const) {
      const turn = buildTurnPresentations([user("u1"), agent("planning"), tool("todo", "todo")], { lastTurnLifecycle: lifecycle })[0];
      expect(turn.finalAgent).toBeNull();
      expect(turn.planControlTools).toHaveLength(1);
      expect(turn.activityTools).toHaveLength(0);
    }
  });

  it("keeps a final answer when todo bookkeeping follows real execution", () => {
    const turn = buildTurnPresentations([user("u1"), tool("read"), agent("final"), tool("todo", "todo")], { lastTurnLifecycle: "settled" })[0];
    expect(turn.finalAgent?.id).toBe("final");
  });

  it("keeps an explicit final across successful read-only verification", () => {
    const turn = buildTurnPresentations([
      user("u1"),
      { ...agent("final"), presentationRole: "final" },
      tool("verify-read", "read"),
      { ...agent("verification"), presentationRole: "intermediate" },
    ], { lastTurnLifecycle: "settled" })[0];
    expect(turn.finalAgent?.id).toBe("final");
    expect(turn.activityBlocks.map((block) => block.id)).toEqual(["verify-read", "verification"]);
  });

  it("keeps an explicit final across observation tools named by presentation metadata", () => {
    const observed: ToolCallBlock = {
      kind: "tool",
      id: "custom-read",
      callId: "custom-read-call",
      tool: "provider_specific_reader",
      status: "done",
      presentation: { version: 1, kind: "read", title: "Inspect output", importance: "micro", domain: "generic" },
    };
    const turn = buildTurnPresentations([user("u1"), { ...agent("final"), presentationRole: "final" }, observed], { lastTurnLifecycle: "settled" })[0];
    expect(turn.finalAgent?.id).toBe("final");
  });

  it("invalidates an explicit final when read-only verification fails", () => {
    const turn = buildTurnPresentations([user("u1"), { ...agent("final"), presentationRole: "final" }, tool("verify-read", "read", "error")], { lastTurnLifecycle: "settled" })[0];
    expect(turn.finalAgent).toBeNull();
    expect(turn.activityBlocks.map((block) => block.id)).toEqual(["final", "verify-read"]);
  });

  it("invalidates an explicit final when later mutation supersedes it", () => {
    const turn = buildTurnPresentations([user("u1"), { ...agent("final"), presentationRole: "final" }, tool("late-edit", "edit")], { lastTurnLifecycle: "settled" })[0];
    expect(turn.finalAgent).toBeNull();
    expect(turn.activityBlocks.map((block) => block.id)).toEqual(["final", "late-edit"]);
  });

  it("invalidates an explicit final for opaque or unknown execution", () => {
    for (const name of ["bash", "provider_specific_tool"]) {
      const turn = buildTurnPresentations([user("u1"), { ...agent("final"), presentationRole: "final" }, tool("late-tool", name)], { lastTurnLifecycle: "settled" })[0];
      expect(turn.finalAgent).toBeNull();
    }
  });

  it("uses the newer final after a mutating tool invalidates the old candidate", () => {
    const turn = buildTurnPresentations([
      user("u1"),
      { ...agent("final-a"), presentationRole: "final" },
      tool("late-edit", "edit"),
      { ...agent("final-b"), presentationRole: "final" },
    ], { lastTurnLifecycle: "settled" })[0];
    expect(turn.finalAgent?.id).toBe("final-b");
    expect(turn.activityBlocks.map((block) => block.id)).toEqual(["final-a", "late-edit"]);
  });

  it("keeps a positioned legacy strip inside its owning turn", () => {
    const blocks: ThreadBlock[] = [
      user("u1"),
      tool("tool-1"),
      user("u2"),
      tool("tool-2", "bash", "running"),
      {
        kind: "artifact-summary",
        id: "strip-1",
        turnId: "opaque-published-uuid",
        artifacts: [{ path: "a.csv", kind: "table", mime: "text/csv", size: 1 }],
      } as ThreadBlock,
    ];
    const turns = buildTurnPresentations(blocks, { lastTurnLifecycle: "active" });
    const running = turns.find((turn) => turn.blocks.some((block) => block.id === "tool-2"));
    const strip = turns.find((turn) => turn.blocks.some((block) => block.id === "strip-1"));
    expect(running?.active).toBe(true);
    expect(running?.lifecycle).toBe("active");
    expect(strip).toBe(running);
    expect(turns).toHaveLength(2);
  });

  it("still finds the active turn when lastTurnId matches no group", () => {
    // History restore rebuilds the running turn under a user-message key, so
    // the streamed turn id no longer identifies any group. Every group would
    // otherwise render as settled and the live turn would read "Completed".
    const blocks: ThreadBlock[] = [user("u1"), tool("tool-1"), user("u2"), tool("tool-2", "bash", "running")];
    const turns = buildTurnPresentations(blocks, { lastTurnId: "turn-not-present", lastTurnLifecycle: "active" });
    const running = turns.find((turn) => turn.blocks.some((block) => block.id === "tool-2"));
    expect(running?.active).toBe(true);
    expect(running?.lifecycle).toBe("active");
  });
});
