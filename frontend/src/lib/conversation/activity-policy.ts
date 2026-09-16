import type { ToolCallBlock, ToolPresentationPolicy } from "../../types/thread";

export type ToolEffect = "observe" | "mutate" | "execute" | "control" | "interaction" | "system";

const PLAN_CONTROL_TOOLS = new Set(["todo", "plan_update", "task_state", "internal_checkpoint"]);
const INTERACTION_TOOLS = new Set(["ask_user_question", "permission_request", "request_permission", "confirmation", "authenticate"]);
const SYSTEM_TOOLS = new Set(["context_compaction", "runtime_recovery", "reconnect"]);
const OBSERVE_TOOLS = new Set([
  "read",
  "read_file",
  "view_image",
  "grep",
  "rg",
  "search",
  "search_files",
  "find",
  "glob",
  "ls",
  "list",
  "list_files",
  "web_search",
  "search_web",
  "tavily_search",
  "web_fetch",
  "fetch",
  "notebook_read",
]);
const MUTATE_TOOLS = new Set([
  "edit",
  "write",
  "write_file",
  "apply_patch",
  "patch",
  "delete",
  "delete_file",
  "move",
  "rename",
  "notebook_edit",
  "image_gen",
  "image_generation",
  "generate_image",
  "create_image",
  "render_image",
]);

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

/** Classifies what a tool can do to the state described by an explicit final
 * candidate. Presentation metadata wins when available; otherwise only known
 * read-only tool names are treated as observation. Unknown tools are execute
 * by default so a possibly stale final is never preserved optimistically. */
export function toolEffect(block: ToolCallBlock): ToolEffect {
  const plane = activityPolicy(block).plane;
  if (plane === "plan-control") return "control";
  if (plane === "interaction") return "interaction";
  if (plane === "system") return "system";

  switch (block.presentation?.kind) {
    case "read":
    case "search":
    case "fetch":
      return "observe";
    case "edit":
    case "artifact":
      return "mutate";
    case "interaction":
      return "interaction";
    case "system":
      return "system";
    case "execute":
    case "compute":
    case "verify":
    case "other":
      return "execute";
    default:
      break;
  }

  const tool = block.tool.trim().toLowerCase();
  if (OBSERVE_TOOLS.has(tool)) return "observe";
  if (MUTATE_TOOLS.has(tool)) return "mutate";
  return "execute";
}

export function isVisibleActivity(block: ToolCallBlock): boolean {
  const presentation = activityPolicy(block);
  return presentation.visibleInCurrentActivity || presentation.visibleInExecutionTrace;
}

export function executionActivities(blocks: ToolCallBlock[]): ToolCallBlock[] { return blocks.filter((block) => activityPolicy(block).visibleInExecutionTrace); }
export function executionOperationCount(blocks: ToolCallBlock[]): number {
  const callIds = new Set<string>();
  for (const block of blocks) {
    if (activityPolicy(block).countsAsOperation) callIds.add(block.callId);
  }
  return callIds.size;
}

function policy(plane: ToolPresentationPolicy["plane"], visibleInCurrentActivity: boolean, visibleInExecutionTrace: boolean, countsAsOperation: boolean): ToolPresentationPolicy {
  return { plane, visibleInCurrentActivity, visibleInExecutionTrace, countsAsOperation };
}
