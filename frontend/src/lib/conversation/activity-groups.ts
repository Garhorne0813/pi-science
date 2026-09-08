import type { AgentMessageBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import { activityPolicy } from "./activity-policy";

export type ActivityEntry = AgentMessageBlock | ToolCallBlock;

export interface ActivityGroup {
  id: string;
  kind: "single" | "exploration";
  blocks: ActivityEntry[];
}

const EXPLORATION_TOOLS = new Set([
  "read", "grep", "glob", "find", "search", "list", "ls", "web_search", "web_fetch",
]);
const MAX_EXPLORATION_GROUP_SIZE = 20;
const MAX_EXPLORATION_GAP_MS = 2_000;

/**
 * Group only contiguous, structurally compatible exploration operations.
 * Invisible plan/system entries and every public agent message are boundaries;
 * therefore filtering the final trace cannot accidentally join operations
 * that were separated in the event stream.
 */
export function groupActivityBlocks(blocks: ThreadBlock[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let exploration: ActivityGroup | null = null;

  const flush = () => {
    if (exploration) groups.push(exploration);
    exploration = null;
  };
  const single = (block: ActivityEntry) => {
    flush();
    groups.push({ id: block.id, kind: "single", blocks: [block] });
  };

  for (const block of blocks) {
    if (block.kind === "agent") {
      if (block.parts.some((part) => part.text.trim())) single(block);
      else flush();
      continue;
    }
    if (block.kind !== "tool") {
      flush();
      continue;
    }
    if (!activityPolicy(block).visibleInExecutionTrace) {
      flush();
      continue;
    }
    if (!isExplorationTool(block)) {
      single(block);
      continue;
    }
    const previous = exploration?.blocks.at(-1);
    if (!previous || previous.kind !== "tool" || !compatibleExploration(previous, block) || exploration.blocks.length >= MAX_EXPLORATION_GROUP_SIZE) {
      flush();
      exploration = { id: block.itemId ?? block.id, kind: "exploration", blocks: [block] };
    } else {
      exploration.blocks.push(block);
    }
  }
  flush();
  return groups;
}

function isExplorationTool(block: ToolCallBlock): boolean {
  return EXPLORATION_TOOLS.has(block.tool.trim().toLowerCase());
}

function compatibleExploration(previous: ToolCallBlock, next: ToolCallBlock): boolean {
  if ((previous.runId ?? "") !== (next.runId ?? "")) return false;
  if ((previous.parentItemId ?? "") !== (next.parentItemId ?? "")) return false;
  const previousTime = Date.parse(previous.endedAt ?? previous.startedAt ?? "");
  const nextTime = Date.parse(next.startedAt ?? next.endedAt ?? "");
  if (Number.isFinite(previousTime) && Number.isFinite(nextTime) && Math.abs(nextTime - previousTime) > MAX_EXPLORATION_GAP_MS) return false;
  return true;
}
