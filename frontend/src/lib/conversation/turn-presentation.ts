import type { AgentMessageBlock, ThreadBlock, ToolCallBlock, TurnArtifactSummaryBlock, UserMessageBlock } from "../../types/thread";
import { activityPolicy, isVisibleActivity } from "./activity-policy";
import { finalAgentInCompletedTurn, intermediateAgentsInTurn, provisionalAgentInActiveTurn } from "./turn-analysis";

export interface TurnPresentation {
  id: string;
  user: UserMessageBlock | null;
  blocks: ThreadBlock[];
  executionTools: ToolCallBlock[];
  planControlTools: ToolCallBlock[];
  interactionTools: ToolCallBlock[];
  /** Execution + interaction + failing system tools: what AgentActivity shows. */
  activityTools: ToolCallBlock[];
  systemBlocks: ThreadBlock[];
  intermediateAgents: AgentMessageBlock[];
  /** Active turn: newest agent text that no tool has superseded yet. Hidden
   *  from the transcript until the turn lifecycle confirms it as the answer. */
  provisionalAgent: AgentMessageBlock | null;
  /** Confirmed answer. Always null while the turn is still active. */
  finalAgent: AgentMessageBlock | null;
  artifacts: TurnArtifactSummaryBlock[];
  /** True while the agent is still working inside this turn. */
  active: boolean;
  completed: boolean;
}

export function buildTurnPresentations(blocks: ThreadBlock[], opts: { lastTurnActive?: boolean } = {}): TurnPresentation[] {
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
  return turns.map((span, index) => buildTurnPresentation(span, index === turns.length - 1 && opts.lastTurnActive === true));
}

export function turnBlockIds(turn: TurnPresentation): string[] {
  return turn.blocks.map((block) => block.id);
}

function buildTurnPresentation(blocks: ThreadBlock[], active: boolean): TurnPresentation {
  const user = blocks[0]?.kind === "user" ? blocks[0] : null;
  const tools = blocks.filter((block): block is ToolCallBlock => block.kind === "tool");
  const executionTools = tools.filter((block) => activityPolicy(block).plane === "execution");
  const planControlTools = tools.filter((block) => activityPolicy(block).plane === "plan-control");
  const interactionTools = tools.filter((block) => activityPolicy(block).plane === "interaction");
  const activityTools = tools.filter(isVisibleActivity);
  const artifacts = blocks.filter((block): block is TurnArtifactSummaryBlock => block.kind === "artifact-summary");
  const finalAgent = active ? null : finalAgentInCompletedTurn(blocks);
  const provisionalAgent = active ? provisionalAgentInActiveTurn(blocks) : null;
  const systemBlocks = blocks.filter((block) => block.kind !== "user" && block.kind !== "agent" && block.kind !== "artifact-summary" && (block.kind !== "tool" || activityPolicy(block).plane === "system"));
  const settled = activityTools.length > 0 && activityTools.every((block) => block.status === "done" || block.status === "error");
  return {
    id: user?.id ?? blocks[0]?.id ?? "turn",
    user,
    blocks,
    executionTools,
    planControlTools,
    interactionTools,
    activityTools,
    systemBlocks,
    intermediateAgents: intermediateAgentsInTurn(blocks),
    provisionalAgent,
    finalAgent,
    artifacts,
    active,
    completed: !active && (finalAgent !== null || settled),
  };
}
