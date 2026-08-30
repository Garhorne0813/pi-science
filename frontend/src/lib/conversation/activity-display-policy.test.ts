import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { selectDisplayedActivity } from "./activity-display-policy";

const tool = (name: string, id = name, status: ToolCallBlock["status"] = "done", extra: Partial<ToolCallBlock> = {}): ToolCallBlock =>
  ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, ...extra });

/** Visible transition count: replay the prefix fold and count label changes. */
function transitions(blocks: ToolCallBlock[]): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= blocks.length; i += 1) {
    const state = selectDisplayedActivity(blocks.slice(0, i));
    const key = state?.mergeKey ?? null;
    if (keys[keys.length - 1] !== key) keys.push(key ?? "none");
  }
  return keys.filter((key) => key !== "none");
}

describe("selectDisplayedActivity", () => {
  it("merges read/search bursts into one inspect phase", () => {
    const blocks = [tool("read"), tool("read", "r2"), tool("grep", "g1"), tool("find", "f1"), tool("read", "r3", "running")];
    expect(selectDisplayedActivity(blocks)?.mergeKey).toBe("inspect");
    expect(transitions(blocks)).toEqual(["inspect"]);
  });

  it("switches only on significant phase changes", () => {
    const blocks = [
      ...Array.from({ length: 8 }, (_, i) => tool("read", `read-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => tool("grep", `grep-${i}`)),
      tool("todo", "todo-1"),
      ...Array.from({ length: 3 }, (_, i) => tool("edit", `edit-${i}`)),
      ...Array.from({ length: 3 }, (_, i) => tool("bash", `test-${i}`, "done", { input: { description: `运行测试 ${i}` } })),
      tool("todo", "todo-2"),
    ];
    expect(transitions(blocks)).toEqual(["inspect", "edit", "verify"]);
  });

  it("never lets micro ops override a significant phase", () => {
    const blocks = [tool("bash", "b", "running", { input: { command: "pnpm build" } }), tool("read", "r", "running")];
    expect(selectDisplayedActivity(blocks)?.mergeKey).toBe("verify");
  });

  it("infers bash phases from descriptions deterministically", () => {
    expect(selectDisplayedActivity([tool("bash", "b", "running", { input: { command: "pnpm vitest run", description: "Run tests" } })])?.phase).toBe("verify");
    expect(selectDisplayedActivity([tool("bash", "b", "running", { input: { command: "python simulate.py" } })])?.phase).toBe("compute");
    expect(selectDisplayedActivity([tool("bash", "b", "running", { input: { command: "git push" } })])?.phase).toBe("execute");
  });

  it("keeps research burst in one phase", () => {
    const blocks = [tool("web_search", "s1"), tool("read", "open", "done", { input: { path: "cache" } }), tool("web_search", "s2", "running")];
    // read is micro: cannot override research
    expect(selectDisplayedActivity(blocks)?.mergeKey).toBe("research");
  });

  it("surfaces waiting interactions and errors immediately as forced states", () => {
    const waiting = selectDisplayedActivity([tool("read"), tool("ask_user_question", "a", "waiting-approval")]);
    expect(waiting).toMatchObject({ phase: "wait", forced: true });
    const failed = selectDisplayedActivity([tool("read"), tool("bash", "b", "error")]);
    expect(failed).toMatchObject({ phase: "error", forced: true });
  });

  it("drops a stale error when later work continues", () => {
    expect(selectDisplayedActivity([tool("bash", "b", "error"), tool("read", "r", "running")])?.mergeKey).toBe("inspect");
  });

  it("ignores answered interactions", () => {
    expect(selectDisplayedActivity([tool("read", "r", "done"), tool("ask_user_question", "a", "done")])?.mergeKey).toBe("inspect");
  });

  it("returns null for todo-only blocks", () => {
    expect(selectDisplayedActivity([tool("todo", "t1"), tool("todo", "t2")])).toBeNull();
  });
});
