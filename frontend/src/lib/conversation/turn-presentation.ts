import type { AgentMessageBlock, ThinkingBlock, ThreadBlock, ToolCallBlock, TurnArtifactSummaryBlock, UserMessageBlock } from "../../types/thread";
import { activityPolicy, isVisibleActivity, toolEffect } from "./activity-policy";
import { finalAgentInCompletedTurn, intermediateAgentsInTurn, provisionalAgentInActiveTurn } from "./turn-analysis";

export type TurnLifecycle = "queued" | "active" | "waiting" | "recovering" | "stopping" | "settled" | "aborted" | "failed";

export interface TurnPresentation {
  id: string;
  turnId?: string;
  runId?: string;
  user: UserMessageBlock | null;
  blocks: ThreadBlock[];
  executionTools: ToolCallBlock[];
  planControlTools: ToolCallBlock[];
  interactionTools: ToolCallBlock[];
  /** Execution + interaction + failing system tools: what AgentActivity shows. */
  activityTools: ToolCallBlock[];
  /** Ordered process history, separate from the current/final answer. */
  activityBlocks: (AgentMessageBlock | ThinkingBlock | ToolCallBlock)[];
  systemBlocks: ThreadBlock[];
  intermediateAgents: AgentMessageBlock[];
  /** Active turn: newest streaming agent text that no tool has superseded yet. */
  provisionalAgent: AgentMessageBlock | null;
  /** Answer explicitly marked final, or selected after a settled lifecycle. */
  finalAgent: AgentMessageBlock | null;
  artifacts: TurnArtifactSummaryBlock[];
  /** Explicit terminal state prevents abort/failure text from becoming final. */
  lifecycle: TurnLifecycle;
  /** True while the agent is still working inside this turn. */
  active: boolean;
  completed: boolean;
}

export function buildTurnPresentations(blocks: ThreadBlock[], opts: { lastTurnLifecycle?: TurnLifecycle; lastTurnId?: string } = {}): TurnPresentation[] {
  if (!Array.isArray(blocks)) return [];
  const turns: Array<{ key: string; blocks: ThreadBlock[] }> = [];
  const byKey = new Map<string, { key: string; blocks: ThreadBlock[] }>();
  const ownerByTurnId = new Map<string, string>();
  let currentKey: string | null = null;
  for (const block of blocks) {
    const identity = "turnId" in block ? block.turnId : undefined;
    // Runtime turn IDs can change during one response (for example after a
    // resumed run). A new user message, rather than a new runtime ID, is the
    // boundary of a conversation turn. Artifact summaries may arrive late,
    // so route those back to the group that owns their runtime ID.
    const key: string = block.kind === "user"
      ? `user:${block.id}`
      : block.kind === "artifact-summary" && identity
        ? ownerByTurnId.get(identity) ?? `turn:${identity}`
        : currentKey && byKey.get(currentKey)?.blocks.some((entry) => entry.kind === "user")
          ? currentKey
          : identity ? `turn:${identity}` : currentKey ?? `orphan:${block.id}`;
    let turn = byKey.get(key);
    if (!turn) {
      turn = { key, blocks: [] };
      byKey.set(key, turn);
      turns.push(turn);
    }
    turn.blocks.push(block);
    if (identity && block.kind !== "artifact-summary") ownerByTurnId.set(identity, key);
    if (block.kind !== "artifact-summary") currentKey = key;
  }
  // A strip whose published turn id is opaque (it does not match the session
  // turn identity) forms its own group, and it can be the last one in the
  // block array. Falling back to `lastKey` would then hand the active
  // designation to that strip, marking the still-running turn as settled and
  // flipping its label between the live text and "Completed" on every render.
  // Only a group with real turn content may stand in for the active turn.
  let lastContentKey: string | null = null;
  for (const turn of turns) {
    if (turn.blocks.some((block) => block.kind !== "artifact-summary")) lastContentKey = turn.key;
  }
  const identified = opts.lastTurnId ? ownerByTurnId.get(opts.lastTurnId) ?? `turn:${opts.lastTurnId}` : null;
  // The active designation must land on a group that exists. History restore
  // can rebuild the running turn under a different key (its blocks then carry
  // a user-message id rather than the stream turn id); without this, no group
  // matches and every one of them renders as settled — the live turn shows
  // "Completed" until the next stream event re-keys it.
  const activeKey = identified && turns.some((turn) => turn.key === identified) ? identified : lastContentKey;
  return turns.map((turn) => {
    const lifecycle = turn.key === activeKey ? opts.lastTurnLifecycle ?? "settled" : "settled";
    return buildTurnPresentation(turn.blocks, lifecycle);
  });
}

export function turnBlockIds(turn: TurnPresentation): string[] {
  return turn.blocks.map((block) => block.id);
}

function invalidatesExplicitFinal(block: ThreadBlock): boolean {
  if (block.kind !== "tool") return false;
  if (block.status === "error") return true;
  const effect = toolEffect(block);
  return effect === "mutate" || effect === "execute" || effect === "interaction";
}

function buildTurnPresentation(blocks: ThreadBlock[], lifecycle: TurnLifecycle): TurnPresentation {
  const active = lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering" || lifecycle === "stopping";
  const user = blocks.find((block): block is UserMessageBlock => block.kind === "user") ?? null;
  const tools = blocks.filter((block): block is ToolCallBlock => block.kind === "tool");
  const executionTools = tools.filter((block) => activityPolicy(block).plane === "execution");
  const planControlTools = tools.filter((block) => activityPolicy(block).plane === "plan-control");
  const interactionTools = tools.filter((block) => activityPolicy(block).plane === "interaction");
  const activityTools = tools.filter(isVisibleActivity);
  const artifacts = blocks.filter((block): block is TurnArtifactSummaryBlock => block.kind === "artifact-summary");
  const identityBlock = blocks.find((block) => "turnId" in block && typeof block.turnId === "string");
  // `presentationRole=final` is a final candidate. Successful read-only
  // observation can verify that candidate without replacing it. Mutating,
  // opaque execution, interaction, or failed tools can change or invalidate
  // the state it describes, so they require a newer final answer. Legacy
  // unclassified messages retain the stricter structural fallback below.
  const finalAgent = blocks.findLast((block, index): block is AgentMessageBlock => block.kind === "agent"
    && block.presentationRole === "final"
    && !blocks.slice(index + 1).some(invalidatesExplicitFinal))
    ?? (lifecycle === "settled" ? finalAgentInCompletedTurn(blocks) : null);
  const hasTerminalError = lifecycle === "failed" && blocks.some((block) => block.kind === "status-line" && block.level === "error");
  const provisionalAgent = !finalAgent && (active || hasTerminalError) ? provisionalAgentInActiveTurn(blocks) : null;
  const visibleAgent = finalAgent ?? provisionalAgent;
  const activityToolIds = new Set(activityTools.map((block) => block.id));
  const activityBlocks = blocks.filter((block): block is AgentMessageBlock | ThinkingBlock | ToolCallBlock =>
    (block.kind === "tool" && activityToolIds.has(block.id))
    || (block.kind === "thinking")
    || (block.kind === "agent" && block.id !== visibleAgent?.id));
  const systemBlocks = blocks.filter((block) => block.kind !== "user" && block.kind !== "agent" && block.kind !== "artifact-summary" && (block.kind !== "tool" || activityPolicy(block).plane === "system"));
  const settled = activityTools.length > 0 && activityTools.every((block) => block.status === "done" || block.status === "error");
  return {
    id: user?.id ?? blocks[0]?.id ?? "turn",
    ...(identityBlock && "turnId" in identityBlock && identityBlock.turnId ? { turnId: identityBlock.turnId } : {}),
    ...(identityBlock && "runId" in identityBlock && identityBlock.runId ? { runId: identityBlock.runId } : {}),
    user,
    blocks,
    executionTools,
    planControlTools,
    interactionTools,
    activityTools,
    activityBlocks,
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

/** A turn whose presentation is still in flight (streaming, waiting, or
 *  recovering) — its activity streams open with a pinned status row. */
export function isLiveLifecycle(lifecycle: TurnLifecycle): boolean {
  return lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering" || lifecycle === "stopping";
}
