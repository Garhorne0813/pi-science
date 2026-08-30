import { describe, expect, it } from "vitest";
import type { AgentMessageBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import { finalAgentInCompletedTurn, intermediateAgentsInTurn, provisionalAgentInActiveTurn } from "./turn-analysis";
import { buildTurnPresentations } from "./turn-presentation";

const user = (id: string): ThreadBlock => ({ kind: "user", id, text: id });
const agent = (id: string, partial = false): AgentMessageBlock => ({ kind: "agent", id, parts: [{ id: `${id}-part`, text: id }], ...(partial ? { partial: true } : {}) });
const tool = (id: string, name = "read", status: ToolCallBlock["status"] = "done"): ThreadBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status });

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

  it("exposes live narration as provisional, never as final", () => {
    const blocks = [agent("agent-a"), tool("tool-1"), agent("answer-streaming")];
    expect(provisionalAgentInActiveTurn(blocks)?.id).toBe("answer-streaming");
    expect(finalAgentInCompletedTurn(blocks)?.id).toBe("answer-streaming");
  });
});

describe("buildTurnPresentations", () => {
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
});
