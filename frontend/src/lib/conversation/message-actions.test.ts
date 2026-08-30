import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "../../types/thread";
import { agentActionTextByBlock, lastCompletedAgentMessageText } from "./message-actions";

const user = (id: string): ThreadBlock => ({ kind: "user", id, text: id });
const agent = (id: string, text: string, partial = false): ThreadBlock => ({
  kind: "agent",
  id,
  parts: [{ id, text }],
  partial,
});
const tool = (id: string, status: "running" | "done" = "done"): ThreadBlock => ({
  kind: "tool",
  id: `tool-${id}`,
  callId: id,
  tool: "read",
  status,
});

describe("agent message actions", () => {
  it("copies only the final visible answer after tool calls", () => {
    const actions = agentActionTextByBlock([
      user("u1"),
      agent("a-before", "先读取文件。"),
      tool("read"),
      agent("a-final", "读取完成。"),
    ]);

    expect([...actions.entries()]).toEqual([
      ["a-final", "读取完成。"],
    ]);
  });

  it("does not show an action while a tool or final text is still pending", () => {
    expect(agentActionTextByBlock([user("u1"), agent("a1", "处理中"), tool("read", "running")]).size).toBe(0);
    expect(agentActionTextByBlock([user("u1"), agent("a1", "处理中", true)]).size).toBe(0);
  });

  it("keeps one action per completed user turn", () => {
    const blocks = [user("u1"), agent("a1", "第一条"), user("u2"), agent("a2", "第二条")];
    expect([...agentActionTextByBlock(blocks).keys()]).toEqual(["a1", "a2"]);
    expect(lastCompletedAgentMessageText(blocks)).toBe("第二条");
  });
});
