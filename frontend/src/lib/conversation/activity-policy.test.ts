import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { activityPolicy } from "./activity-policy";

const block = (tool: string, status: ToolCallBlock["status"] = "done"): ToolCallBlock => ({ kind: "tool", id: tool, callId: tool, tool, status });

describe("activityPolicy", () => {
  it("excludes todo from execution activity", () => { expect(activityPolicy(block("todo"))).toEqual({ plane: "plan-control", visibleInCurrentActivity: false, visibleInExecutionTrace: false, countsAsOperation: false }); });
  it("counts execution tools", () => { expect(activityPolicy(block("read"))).toEqual({ plane: "execution", visibleInCurrentActivity: true, visibleInExecutionTrace: true, countsAsOperation: true }); });
  it("keeps approval out of the execution trace", () => { expect(activityPolicy(block("bash", "waiting-approval"))).toEqual({ plane: "interaction", visibleInCurrentActivity: true, visibleInExecutionTrace: false, countsAsOperation: false }); });
  it("hides a resolved interaction from Activity", () => { expect(activityPolicy({ ...block("ask_user_question", "waiting-approval"), interactionResolved: true })).toEqual({ plane: "plan-control", visibleInCurrentActivity: false, visibleInExecutionTrace: false, countsAsOperation: false }); });
});
