import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { selectDisplayedActivity } from "./activity-display-policy";

const tool = (name: string, id = name, status: ToolCallBlock["status"] = "done", extra: Partial<ToolCallBlock> = {}): ToolCallBlock =>
  ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, ...extra });

function transitions(blocks: ToolCallBlock[]): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= blocks.length; i += 1) {
    const key = selectDisplayedActivity(blocks.slice(0, i))?.mergeKey;
    if (key && keys.at(-1) !== key) keys.push(key);
  }
  return keys;
}

describe("Narrative Progress reducer", () => {
  it("folds a coding edit/test loop into one implementation epoch", () => {
    const blocks = [
      ...Array.from({ length: 4 }, (_, i) => tool("read", `read-${i}`)),
      tool("grep", "grep-1"),
      tool("edit", "edit-1"),
      tool("bash", "test-1", "error", { input: { description: "Run conversation tests" } }),
      tool("read", "corrective-read"),
      tool("edit", "edit-2"),
      tool("bash", "typecheck", "done", { input: { description: "Check TypeScript types" } }),
    ];
    expect(transitions(blocks)).toEqual(["explore:code", "implementation:code"]);
    expect(selectDisplayedActivity(blocks)).toMatchObject({ state: "implementation", domain: "code" });
  });

  it("keeps successful verification inside an implementation epoch", () => {
    const blocks = [tool("read"), tool("edit"), tool("bash", "test", "done", { input: { description: "Run tests" } }), tool("read", "corrective"), tool("edit", "edit-2")];
    expect(transitions(blocks)).toEqual(["explore:code", "implementation:code"]);
  });

  it("keeps a short inspect burst inside the implementation epoch", () => {
    const blocks = [
      tool("edit", "edit", "done", { endedAt: "2026-08-30T00:00:00.000Z" }),
      tool("read", "r1", "done", { startedAt: "2026-08-30T00:00:00.100Z" }),
      tool("grep", "r2", "done", { startedAt: "2026-08-30T00:00:00.400Z" }),
      tool("find", "r3", "done", { startedAt: "2026-08-30T00:00:00.800Z" }),
    ];
    expect(selectDisplayedActivity(blocks)).toMatchObject({ state: "implementation", domain: "code" });
  });

  it("allows a sustained inspect burst to leave a finished implementation epoch", () => {
    const blocks = [
      tool("edit", "edit", "done", { endedAt: "2026-08-30T00:00:00.000Z" }),
      tool("read", "r1", "done", { startedAt: "2026-08-30T00:00:00.100Z" }),
      tool("grep", "r2", "done", { startedAt: "2026-08-30T00:00:01.000Z" }),
      tool("find", "r3", "done", { startedAt: "2026-08-30T00:00:02.000Z" }),
    ];
    expect(selectDisplayedActivity(blocks)).toMatchObject({ state: "explore", domain: "code" });
  });

  it("keeps research support reads quiet and then moves to analysis", () => {
    const blocks = [tool("web_search", "s1"), tool("web_fetch", "f1"), tool("read", "r1"), tool("python", "p1", "running", { input: { description: "Analyze key findings" } })];
    expect(transitions(blocks)).toEqual(["research:research", "analyze:generic"]);
  });

  it("supports notebook read/edit/run without generic fallbacks", () => {
    const blocks = [tool("notebook_read", "r1"), tool("notebook_edit", "e1"), tool("notebook_run", "n1"), tool("notebook_read", "r2"), tool("notebook_edit", "e2"), tool("notebook_run", "n2")];
    expect(transitions(blocks)).toEqual(["explore:science", "implementation:science"]);
  });

  it("uses a generation epoch for image output", () => {
    expect(selectDisplayedActivity([tool("image_gen", "image", "running")])).toMatchObject({ state: "generate", domain: "document" });
  });

  it("uses standalone verify when no mutation epoch exists", () => {
    expect(selectDisplayedActivity([tool("bash", "b", "running", { input: { description: "Run tests" } })])).toMatchObject({ state: "verify", domain: "code" });
  });

  it("does not change Current Activity for opaque or unknown tools without semantics", () => {
    expect(selectDisplayedActivity([tool("bash", "b", "running", { input: { command: "git status" } })])).toBeNull();
    expect(selectDisplayedActivity([tool("future_extension", "x", "running")])).toBeNull();
    expect(selectDisplayedActivity([tool("read"), tool("future_extension", "x", "running")])?.state).toBe("explore");
  });

  it("keeps the current narrative when a tool fails and later work continues", () => {
    expect(selectDisplayedActivity([tool("edit", "e"), tool("bash", "b", "error"), tool("read", "r", "running")])?.state).toBe("implementation");
  });

  it("surfaces interactions and recovery as forced states", () => {
    expect(selectDisplayedActivity([tool("read"), tool("ask_user_question", "a", "waiting-approval")])).toMatchObject({ state: "interaction", forced: true });
    expect(selectDisplayedActivity([tool("runtime_recovery", "rr", "running")])).toMatchObject({ state: "recover", forced: true });
  });



  it("ignores todo and answered interactions", () => {
    expect(selectDisplayedActivity([tool("todo", "t1"), tool("todo", "t2")])).toBeNull();
    expect(selectDisplayedActivity([tool("read"), tool("ask_user_question", "a", "done")])?.state).toBe("explore");
  });
});
