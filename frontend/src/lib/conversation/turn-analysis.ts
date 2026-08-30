import type { AgentMessageBlock, ThreadBlock } from "../../types/thread";
import { activityPolicy } from "./activity-policy";

export function finalAgentInTurn(blocks: ThreadBlock[]): AgentMessageBlock | null {
  const finalAgent = blocks.findLast((block, index): block is AgentMessageBlock => block.kind === "agent" && !blocks.slice(index + 1).some(isVisibleActivityTool));
  return finalAgent ?? null;
}

export function intermediateAgentsInTurn(blocks: ThreadBlock[]): AgentMessageBlock[] {
  const finalAgent = finalAgentInTurn(blocks);
  return blocks.filter((block): block is AgentMessageBlock => block.kind === "agent" && block !== finalAgent);
}

function isVisibleActivityTool(block: ThreadBlock): boolean {
  return block.kind === "tool" && activityPolicy(block).visibleInCurrentActivity;
}
