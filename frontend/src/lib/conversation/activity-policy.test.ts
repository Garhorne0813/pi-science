import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { activityPolicy, toolEffect } from "./activity-policy";

const block = (tool: string, status: ToolCallBlock["status"] = "done"): ToolCallBlock => ({ kind: "tool", id: tool, callId: tool, tool, status });

describe("activityPolicy", () => {
  it("excludes todo from execution activity", () => { expect(activityPolicy(block("todo"))).toEqual({ plane: "plan-control", visibleInCurrentActivity: false, visibleInExecutionTrace: false, countsAsOperation: false }); });
  it("counts execution tools", () => { expect(activityPolicy(block("read"))).toEqual({ plane: "execution", visibleInCurrentActivity: true, visibleInExecutionTrace: true, countsAsOperation: true }); });
  it("keeps approval out of the execution trace", () => { expect(activityPolicy(block("bash", "waiting-approval"))).toEqual({ plane: "interaction", visibleInCurrentActivity: true, visibleInExecutionTrace: false, countsAsOperation: false }); });
  it("hides a resolved interaction from Activity", () => { expect(activityPolicy({ ...block("ask_user_question", "waiting-approval"), interactionResolved: true })).toEqual({ plane: "plan-control", visibleInCurrentActivity: false, visibleInExecutionTrace: false, countsAsOperation: false }); });
  it("keeps an approved execution visible once it runs", () => {
    const resolved = { ...block("bash", "running"), interactionResolved: true };
    expect(activityPolicy(resolved)).toEqual({ plane: "execution", visibleInCurrentActivity: true, visibleInExecutionTrace: true, countsAsOperation: true });
  });
  it("keeps approved execution output and errors in the trace", () => {
    for (const status of ["done", "error"] as const) {
      const resolved = { ...block("bash", status), interactionResolved: true };
      expect(activityPolicy(resolved)).toEqual({ plane: "execution", visibleInCurrentActivity: true, visibleInExecutionTrace: true, countsAsOperation: true });
    }
  });
  it("still retires the stale prompt of an approved execution before it runs", () => {
    const resolved = { ...block("bash", "waiting-approval"), interactionResolved: true };
    expect(activityPolicy(resolved)).toEqual({ plane: "plan-control", visibleInCurrentActivity: false, visibleInExecutionTrace: false, countsAsOperation: false });
  });
  it("hides a resolved interaction even after the runtime finalizes it", () => {
    const resolved = { ...block("ask_user_question", "done"), interactionResolved: true };
    expect(activityPolicy(resolved)).toEqual({ plane: "plan-control", visibleInCurrentActivity: false, visibleInExecutionTrace: false, countsAsOperation: false });
  });
});

describe("toolEffect", () => {
  it("treats known read-only tools as observation", () => {
    for (const tool of ["read", "read_file", "view_image", "grep", "glob", "web_fetch", "notebook_read"]) {
      expect(toolEffect(block(tool))).toBe("observe");
    }
  });

  it("treats known writers and generators as mutation", () => {
    for (const tool of ["write", "edit", "apply_patch", "delete", "rename", "notebook_edit", "image_gen"]) {
      expect(toolEffect(block(tool))).toBe("mutate");
    }
  });

  it("keeps control, interaction, and system semantics independent from execution", () => {
    expect(toolEffect(block("todo"))).toBe("control");
    expect(toolEffect(block("ask_user_question", "waiting-approval"))).toBe("interaction");
    expect(toolEffect(block("runtime_recovery"))).toBe("system");
  });

  it("defaults opaque and unknown tools to execute", () => {
    expect(toolEffect(block("bash"))).toBe("execute");
    expect(toolEffect(block("custom_tool"))).toBe("execute");
  });

  it("prefers explicit tool presentation metadata", () => {
    const observed = { ...block("custom_reader"), presentation: { version: 1 as const, kind: "read" as const, title: "Inspect", importance: "micro" as const, domain: "generic" as const } };
    const mutated = { ...block("custom_writer"), presentation: { version: 1 as const, kind: "edit" as const, title: "Update", importance: "stage" as const, domain: "generic" as const } };
    expect(toolEffect(observed)).toBe("observe");
    expect(toolEffect(mutated)).toBe("mutate");
  });
});
