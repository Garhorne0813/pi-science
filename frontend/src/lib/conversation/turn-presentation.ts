import type { AgentMessageBlock, ThreadBlock, ToolCallBlock, TurnArtifactSummaryBlock, UserMessageBlock } from "../../types/thread";
import { activityPolicy, isVisibleActivity } from "./activity-policy";
import { finalAgentInCompletedTurn, intermediateAgentsInTurn, provisionalAgentInActiveTurn } from "./turn-analysis";

export type TurnLifecycle = "queued" | "active" | "waiting" | "recovering" | "settled" | "aborted" | "failed";

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
  /** Active turn: newest agent text that no tool has superseded yet. The
   *  conversation renders this block while its text is still streaming. */
  provisionalAgent: AgentMessageBlock | null;
  /** Confirmed answer. Always null while the turn is still active. */
  finalAgent: AgentMessageBlock | null;
  artifacts: TurnArtifactSummaryBlock[];
  /** Explicit terminal state prevents abort/failure text from becoming final. */
  lifecycle: TurnLifecycle;
  /** True while the agent is still working inside this turn. */
  active: boolean;
  completed: boolean;
}

export function buildTurnPresentations(blocks: ThreadBlock[], opts: { lastTurnLifecycle?: TurnLifecycle } = {}): TurnPresentation[] {
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
  return turns.map((span, index) => {
    const isLast = index === turns.length - 1;
    const lifecycle = isLast ? opts.lastTurnLifecycle ?? "settled" : "settled";
    return buildTurnPresentation(span, lifecycle);
  });
}

export function turnBlockIds(turn: TurnPresentation): string[] {
  return turn.blocks.map((block) => block.id);
}

function buildTurnPresentation(blocks: ThreadBlock[], lifecycle: TurnLifecycle): TurnPresentation {
  const active = lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering";
  const user = blocks[0]?.kind === "user" ? blocks[0] : null;
  const tools = blocks.filter((block): block is ToolCallBlock => block.kind === "tool");
  const executionTools = tools.filter((block) => activityPolicy(block).plane === "execution");
  const planControlTools = tools.filter((block) => activityPolicy(block).plane === "plan-control");
  const interactionTools = tools.filter((block) => activityPolicy(block).plane === "interaction");
  const activityTools = tools.filter(isVisibleActivity);
  const artifacts = blocks.filter((block): block is TurnArtifactSummaryBlock => block.kind === "artifact-summary");
  const finalAgent = blocks.findLast((block): block is AgentMessageBlock => block.kind === "agent" && block.presentationRole === "final")
    ?? (lifecycle === "settled" ? finalAgentInCompletedTurn(blocks) : null);
  const provisionalAgent = active && !finalAgent ? provisionalAgentInActiveTurn(blocks) : null;
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
    lifecycle,
    active,
    completed: lifecycle === "settled" && (finalAgent !== null || settled),
  };
}
