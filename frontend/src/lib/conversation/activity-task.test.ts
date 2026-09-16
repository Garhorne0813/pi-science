import { describe, expect, it } from "vitest";
import type { AgentMessageBlock, ToolCallBlock } from "../../types/thread";
import { selectActivityTask } from "./activity-task";

const narration: AgentMessageBlock = { kind: "agent", id: "a1", presentationRole: "intermediate", parts: [{ id: "p1", text: "定位第二轮回复停止跟随的原因" }] };
const read: ToolCallBlock = { kind: "tool", id: "r1", callId: "r1", tool: "read", status: "running", input: { path: "scroll.ts" } };

describe("selectActivityTask", () => {
  it("uses task narration instead of inventing a purpose from a file path", () => {
    expect(selectActivityTask([narration, read])).toMatchObject({ text: narration.parts[0].text, sourceId: "a1", responding: false });
    expect(selectActivityTask([read])).toMatchObject({ text: null, fallback: "read" });
  });

  it("rejects mechanical descriptions and falls back to the model's purpose", () => {
    expect(selectActivityTask([narration, { ...read, input: { ...read.input, description: "Reading scroll.ts" } }]).text).toBe(narration.parts[0].text);
  });

  it("uses a newer in-progress plan and updates when its active task changes", () => {
    const todo: ToolCallBlock = { ...read, id: "todo", tool: "todo", status: "done", details: { tasks: [{ id: 1, subject: "Fix scrolling", activeForm: "修复第二轮消息的跟随", status: "in_progress" }] } };
    expect(selectActivityTask([narration, todo, read]).text).toBe("修复第二轮消息的跟随");
    expect(selectActivityTask([narration, { ...todo, details: { tasks: [{ id: 1, subject: "Verify two consecutive replies", status: "in_progress" }] } }, read]).text).toBe("Verify two consecutive replies");
  });

  it("switches to responding when answer prose follows completed tools", () => {
    expect(selectActivityTask([{ ...read, status: "done" }, { ...narration, presentationRole: "final" }])).toMatchObject({ text: null, responding: true, fallback: "respond" });
  });

  it("accepts fresh progress during a running tool and preserves long reports", () => {
    const update = { ...narration, id: "a2", parts: [{ id: "p2", text: "正在验证新的跟随逻辑\n保留完整的检查说明，便于回看。" }] };
    const task = selectActivityTask([narration, read, update]);
    expect(task.text).toBe("正在验证新的跟随逻辑");
    expect(task.sourceId).toBeUndefined();
  });
});
