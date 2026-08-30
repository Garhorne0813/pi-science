import { describe, expect, it } from "vitest";
import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { finalAgentInCompletedTurn, intermediateAgentsInTurn, provisionalAgentInActiveTurn } from "./turn-analysis";
import { buildTurnPresentations } from "./turn-presentation";

const user = (id: string): ThreadBlock => ({ kind: "user", id, text: id });
const agent = (id: string, partial = false): ThreadBlock => ({ kind: "agent", id, parts: [{ id: `${id}-part`, text: id }], ...(partial ? { partial: true } : {}) });
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
    const active = buildTurnPresentations(blocks, { lastTurnActive: true })[0];
    expect(active.finalAgent).toBeNull();
    expect(active.provisionalAgent?.id).toBe("answer");
    expect(active.completed).toBe(false);
    const settled = buildTurnPresentations(blocks)[0];
    expect(settled.finalAgent?.id).toBe("answer");
    expect(settled.provisionalAgent).toBeNull();
    expect(settled.completed).toBe(true);
  });

  it("never marks earlier turns active even when the store is working", () => {
    const turns = buildTurnPresentations([user("u1"), agent("a1"), user("u2"), agent("a2")], { lastTurnActive: true });
    expect(turns[0].active).toBe(false);
    expect(turns[1].active).toBe(true);
  });
});
