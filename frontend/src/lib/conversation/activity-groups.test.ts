import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "../../types/thread";
import { groupActivityBlocks } from "./activity-groups";

const tool = (id: string, toolName: string, extra: Partial<Extract<ThreadBlock, { kind: "tool" }>> = {}): ThreadBlock => ({
  kind: "tool", id, callId: `${id}-call`, tool: toolName, status: "done", ...extra,
});
const agent = (id: string): ThreadBlock => ({ kind: "agent", id, parts: [{ id, text: "public commentary" }] });

describe("activity grouping", () => {
  it("groups adjacent exploration operations but keeps commentary as a boundary", () => {
    const groups = groupActivityBlocks([tool("read-1", "read"), tool("read-2", "grep"), agent("note"), tool("read-3", "read")]);
    expect(groups.map((group) => group.blocks.map((block) => block.id))).toEqual([["read-1", "read-2"], ["note"], ["read-3"]]);
    expect(groups[0]).toMatchObject({ kind: "exploration", id: "read-1" });
  });

  it("groups adjacent execution calls", () => {
    const groups = groupActivityBlocks([tool("bash-1", "bash"), tool("bash-2", "bash")]);
    expect(groups).toMatchObject([{ kind: "execution", blocks: [{ id: "bash-1" }, { id: "bash-2" }] }]);
  });

  it("groups adjacent file changes separately from validation", () => {
    const groups = groupActivityBlocks([tool("edit-1", "edit"), tool("write-1", "write"), tool("bash-1", "bash"), tool("test-1", "test")]);
    expect(groups).toMatchObject([
      { kind: "changes", blocks: [{ id: "edit-1" }, { id: "write-1" }] },
      { kind: "execution", blocks: [{ id: "bash-1" }, { id: "test-1" }] },
    ]);
  });

  it("does not group exploration across runs or a long gap", () => {
    const groups = groupActivityBlocks([
      tool("read-1", "read", { runId: "run-1", endedAt: "2026-09-08T00:00:00.000Z" }),
      tool("read-2", "read", { runId: "run-2", startedAt: "2026-09-08T00:00:00.100Z" }),
      tool("read-3", "read", { runId: "run-2", startedAt: "2026-09-08T00:00:10.000Z" }),
    ]);
    expect(groups).toHaveLength(3);
  });
});

it("groups ls glob and grep as exploration", () => {
  expect(groupActivityBlocks([tool("ls", "ls"), tool("glob", "glob"), tool("grep", "grep")])).toMatchObject([{ kind: "exploration", blocks: [{ id: "ls" }, { id: "glob" }, { id: "grep" }] }]);
});
