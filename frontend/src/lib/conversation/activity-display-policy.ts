/** Activity Display Policy: decides which execution events are allowed to
 *  change the Current Activity line. Raw tool events keep flowing into the
 *  Execution Trace; here they collapse into stable execution phases. Only a
 *  phase change (or a forced wait/error) is a user-visible transition. */

import type { ToolCallBlock } from "../../types/thread";
import { activityPolicy } from "./activity-policy";

export type ActivityPhase = "inspect" | "research" | "edit" | "execute" | "verify" | "compute" | "wait" | "error" | "other";

export const MIN_ACTIVITY_VISIBLE_MS = 800;
export const ACTIVITY_SWITCH_DEBOUNCE_MS = 250;

export interface PresentedActivity {
  phase: ActivityPhase;
  mergeKey: string;
  source: ToolCallBlock;
  /** Read/search/list style support actions: never override a significant phase. */
  micro: boolean;
  /** Waiting and error states switch immediately. */
  forced: boolean;
}

const MICRO_TOOLS = new Set(["read", "read_file", "grep", "rg", "search_files", "find", "ls", "list_files"]);
const OPAQUE_TOOLS = new Set(["bash", "python", "run_code", "execute"]);
const TOOL_PHASES: Record<string, ActivityPhase> = {
  read: "inspect", read_file: "inspect", grep: "inspect", rg: "inspect", search_files: "inspect", find: "inspect", ls: "inspect", list_files: "inspect",
  web_search: "research", search_web: "research", tavily_search: "research",
  edit: "edit", write: "edit", write_file: "edit", apply_patch: "edit",
  bash: "execute", python: "execute", run_code: "execute", execute: "execute",
  notebook: "compute", run_cell: "compute", execute_code: "compute",
};

export function selectDisplayedActivity(blocks: ToolCallBlock[]): PresentedActivity | null {
  let state: PresentedActivity | null = null;
  for (const block of blocks) {
    const next = presentedActivity(block);
    if (!next) continue;
    if (state && state.mergeKey !== next.mergeKey && next.micro && !state.micro && state.phase !== "error" && state.phase !== "wait") continue;
    state = next;
  }
  return state;
}

function presentedActivity(block: ToolCallBlock): PresentedActivity | null {
  const plane = activityPolicy(block).plane;
  if (plane === "plan-control") return null;
  if (plane === "interaction") {
    if (block.status !== "waiting-approval" && block.status !== "running") return null;
    return { phase: "wait", mergeKey: `wait:${block.callId}`, source: block, micro: false, forced: true };
  }
  if (plane !== "execution" && plane !== "system") return null;
  if (block.status === "error") return { phase: "error", mergeKey: `error:${block.callId}`, source: block, micro: false, forced: true };
  if (plane === "system") return null;
  const tool = block.tool.trim().toLowerCase();
  const micro = MICRO_TOOLS.has(tool);
  const phase = OPAQUE_TOOLS.has(tool) ? inferOpaquePhase(block) : TOOL_PHASES[tool] ?? (micro ? "inspect" : "other");
  return { phase, mergeKey: phase, source: block, micro, forced: false };
}

/** Deterministic keyword pass over title/description/command. No LLM call. */
function inferOpaquePhase(block: ToolCallBlock): ActivityPhase {
  const input = block.input ?? {};
  const text = `${block.title ?? ""} ${stringField(input.description)} ${stringField(input.command)} ${stringField(input.code)}`.toLowerCase();
  if (/\b(tests?|vitest|pytest|jest|typecheck|lint|build|compile|check)\b|测试|验证/.test(text)) return "verify";
  if (/analy[sz]e?|simulat|compute|forecast|regression|分析|计算/.test(text)) return "compute";
  return "execute";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
