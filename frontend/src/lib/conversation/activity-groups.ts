import type { AgentMessageBlock, ThinkingBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import { activityPolicy } from "./activity-policy";

export type ActivityEntry = AgentMessageBlock | ThinkingBlock | ToolCallBlock;

export interface ActivityGroup {
  id: string;
  kind: "single" | "exploration" | "changes" | "execution";
  blocks: ActivityEntry[];
}

const EXPLORATION_TOOLS = new Set([
  "read", "grep", "glob", "find", "search", "list", "ls", "web_search", "web_fetch",
]);
const CHANGE_TOOLS = new Set([
  "edit", "edit_file", "edit-file", "write", "write_file", "write-file", "apply_patch", "patch",
]);
const EXECUTION_TOOLS = new Set([
  "bash", "shell", "test", "python", "kernel", "execute", "run", "subagent", "subagent_control",
]);
const MAX_ACTIVITY_GROUP_SIZE = 20;
const MAX_ACTIVITY_GAP_MS = 2_000;

/**
 * Group only contiguous, structurally compatible exploration operations.
 * Invisible plan/system entries and every public agent message are boundaries;
 * therefore filtering the final trace cannot accidentally join operations
 * that were separated in the event stream.
 */
export function groupActivityBlocks(blocks: ThreadBlock[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let groupedIndex: number | null = null;
  const single = (block: ActivityEntry) => {
    groupedIndex = null;
    groups.push({ id: block.id, kind: "single", blocks: [block] });
  };

  for (const block of blocks) {
    if (block.kind === "agent") {
      if (block.parts.some((part) => part.text.trim())) single(block);
      else groupedIndex = null;
      continue;
    }
    if (block.kind === "thinking") {
      if (block.parts.some((part) => part.text.trim())) single(block);
      else groupedIndex = null;
      continue;
    }
    if (block.kind !== "tool") {
      groupedIndex = null;
      continue;
    }
    if (!activityPolicy(block).visibleInExecutionTrace) {
      groupedIndex = null;
      continue;
    }
    const kind = activityGroupKind(block);
    if (!kind) {
      single(block);
      continue;
    }
    const current = groupedIndex === null ? null : groups[groupedIndex];
    const previous = current?.blocks.at(-1);
    if (!current || current.kind !== kind || !previous || previous.kind !== "tool" || !compatibleActivity(previous, block) || current.blocks.length >= MAX_ACTIVITY_GROUP_SIZE) {
      groups.push({ id: block.itemId ?? block.id, kind, blocks: [block] });
      groupedIndex = groups.length - 1;
    } else {
      current.blocks.push(block);
    }
  }
  return groups;
}

function activityGroupKind(block: ToolCallBlock): Exclude<ActivityGroup["kind"], "single"> | null {
  const tool = block.tool.trim().toLowerCase();
  if (EXPLORATION_TOOLS.has(tool)) return "exploration";
  if (CHANGE_TOOLS.has(tool)) return "changes";
  if (EXECUTION_TOOLS.has(tool)) return "execution";
  return null;
}

function compatibleActivity(previous: ToolCallBlock, next: ToolCallBlock): boolean {
  if ((previous.runId ?? "") !== (next.runId ?? "")) return false;
  if ((previous.parentItemId ?? "") !== (next.parentItemId ?? "")) return false;
  // Batched assistant messages can invoke several tools at one timestamp and
  // receive their results much later. Compare invocation times when both are
  // available so result duration does not split one coherent batch.
  const compareStarts = Boolean(previous.startedAt && next.startedAt);
  const previousTime = Date.parse((compareStarts ? previous.startedAt : previous.endedAt ?? previous.startedAt) ?? "");
  const nextTime = Date.parse((next.startedAt ?? next.endedAt) ?? "");
  if (Number.isFinite(previousTime) && Number.isFinite(nextTime) && Math.abs(nextTime - previousTime) > MAX_ACTIVITY_GAP_MS) return false;
  return true;
}
