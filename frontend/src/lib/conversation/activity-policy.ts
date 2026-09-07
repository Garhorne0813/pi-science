import type { ToolCallBlock, ToolPresentationPolicy } from "../../types/thread";

const PLAN_CONTROL_TOOLS = new Set(["todo", "plan_update", "task_state", "internal_checkpoint"]);
const INTERACTION_TOOLS = new Set(["ask_user_question", "permission_request", "request_permission", "confirmation", "authenticate"]);
const SYSTEM_TOOLS = new Set(["context_compaction", "runtime_recovery", "reconnect"]);

export function activityPolicy(block: ToolCallBlock): ToolPresentationPolicy {
  const tool = block.tool.trim().toLowerCase();
  if (PLAN_CONTROL_TOOLS.has(tool)) return policy("plan-control", false, false, false);
  // An answered approval prompt may only retire the prompt itself. Pure
  // interaction tools never execute, so their stale prompt disappears; an
  // execution tool carries the mark only until its real status lands, and
  // running/done/error stay visible as ordinary execution records.
  const interactionTool = INTERACTION_TOOLS.has(tool);
  if (block.interactionResolved && (interactionTool || block.status === "waiting-approval")) {
    return policy("plan-control", false, false, false);
  }
  if (interactionTool || block.status === "waiting-approval") return policy("interaction", true, false, false);
  if (SYSTEM_TOOLS.has(tool)) {
    const recoveryVisible = (tool === "runtime_recovery" || tool === "reconnect") && block.status === "running";
    return policy("system", recoveryVisible || block.status === "error", block.status === "error", false);
  }
  return policy("execution", true, true, true);
}

export function isVisibleActivity(block: ToolCallBlock): boolean {
  const presentation = activityPolicy(block);
  return presentation.visibleInCurrentActivity || presentation.visibleInExecutionTrace;
}

export function executionActivities(blocks: ToolCallBlock[]): ToolCallBlock[] { return blocks.filter((block) => activityPolicy(block).visibleInExecutionTrace); }
export function executionOperationCount(blocks: ToolCallBlock[]): number { return blocks.filter((block) => activityPolicy(block).countsAsOperation).length; }

function policy(plane: ToolPresentationPolicy["plane"], visibleInCurrentActivity: boolean, visibleInExecutionTrace: boolean, countsAsOperation: boolean): ToolPresentationPolicy {
  return { plane, visibleInCurrentActivity, visibleInExecutionTrace, countsAsOperation };
}
