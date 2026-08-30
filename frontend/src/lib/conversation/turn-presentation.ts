import type { AgentMessageBlock, ThreadBlock, ToolCallBlock, TurnArtifactSummaryBlock, UserMessageBlock } from "../../types/thread";
import { activityPolicy } from "./activity-policy";
import { finalAgentInTurn, intermediateAgentsInTurn } from "./turn-analysis";

export interface TurnPresentation {
  id: string;
  user: UserMessageBlock | null;
  blocks: ThreadBlock[];
  executionTools: ToolCallBlock[];
  planControlTools: ToolCallBlock[];
  interactionTools: ToolCallBlock[];
  systemBlocks: ThreadBlock[];
  intermediateAgents: AgentMessageBlock[];
  finalAgent: AgentMessageBlock | null;
  artifacts: TurnArtifactSummaryBlock[];
  completed: boolean;
}

export function buildTurnPresentations(blocks: ThreadBlock[]): TurnPresentation[] {
  if (!Array.isArray(blocks)) return [];
  const turns: ThreadBlock[][] = [];
  let current: ThreadBlock[] = [];
  const flush = () => {
    if (current.length > 0) turns.push(current);
    current = [];
  };
  for (const block of blocks) {
    if (block.kind === "user") flush();
    current.push(block);
  }
  flush();
  return turns.map(buildTurnPresentation);
}

export function turnBlockIds(turn: TurnPresentation): string[] {
  return turn.blocks.map((block) => block.id);
}

function buildTurnPresentation(blocks: ThreadBlock[]): TurnPresentation {
  const user = blocks[0]?.kind === "user" ? blocks[0] : null;
  const tools = blocks.filter((block): block is ToolCallBlock => block.kind === "tool");
  const executionTools = tools.filter((block) => activityPolicy(block).plane === "execution");
  const planControlTools = tools.filter((block) => activityPolicy(block).plane === "plan-control");
  const interactionTools = tools.filter((block) => activityPolicy(block).plane === "interaction");
  const artifacts = blocks.filter((block): block is TurnArtifactSummaryBlock => block.kind === "artifact-summary");
  const finalAgent = finalAgentInTurn(blocks);
  const systemBlocks = blocks.filter((block) => block.kind !== "user" && block.kind !== "agent" && block.kind !== "artifact-summary" && (block.kind !== "tool" || activityPolicy(block).plane === "system"));
  const completed = finalAgent ? finalAgent.partial !== true : executionTools.length > 0 && executionTools.every((block) => block.status === "done" || block.status === "error");
  return {
    id: user?.id ?? blocks[0]?.id ?? "turn",
    user,
    blocks,
    executionTools,
    planControlTools,
    interactionTools,
    systemBlocks,
    intermediateAgents: intermediateAgentsInTurn(blocks),
    finalAgent,
    artifacts,
    completed,
  };
}
