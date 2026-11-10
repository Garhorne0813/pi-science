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
  startedAt?: string;
  endedAt?: string;
  /** True while the agent is still working inside this turn. */
  active: boolean;
  completed: boolean;
}

export function buildTurnPresentations(blocks: ThreadBlock[], opts: { lastTurnLifecycle?: TurnLifecycle; lastTurnId?: string } = {}): TurnPresentation[] {
  if (!Array.isArray(blocks)) return [];
  const turns: Array<{ key: string; blocks: ThreadBlock[] }> = [];
  const byKey = new Map<string, { key: string; blocks: ThreadBlock[] }>();
  const ownerByTurnId = new Map<string, string>();
  const ownerByRunId = new Map<string, string>();
  let currentKey: string | null = null;
  for (const block of blocks) {
    const identity = "turnId" in block ? block.turnId : undefined;
    const runId = "runId" in block ? block.runId : undefined;
    // Runtime turn IDs can change during one response (for example after a
    // resumed run). A new user message, rather than a new runtime ID, is the
    // boundary of a conversation turn. Artifact summaries may arrive late,
    // so route those back to the group that owns their runtime ID.
    const key: string = block.kind === "user"
      ? `user:${block.id}`
      : runId && ownerByRunId.has(runId)
        ? ownerByRunId.get(runId)!
      : block.kind === "artifact-summary" && identity
        ? ownerByTurnId.get(identity) ?? currentKey ?? `turn:${identity}`
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
    if (runId) ownerByRunId.set(runId, key);
    if (block.kind !== "artifact-summary") currentKey = key;
  }
  // Unmatched legacy/history identities retain the position established by
  // artifact attachment. Only groups with content can own the active state.
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
    const terminal = turn.blocks.find((block) => block.kind === "user" && block.turnStatus) ?? turn.blocks.findLast((block) => "turnStatus" in block && block.turnStatus);
    const status = terminal && "turnStatus" in terminal ? terminal.turnStatus : undefined;
    const persisted: TurnLifecycle = status === "aborted" || status === "declined" ? "aborted" : status === "failed" ? "failed" : "settled";
    // Idle snapshots describe streaming, not the outcome of an earlier run.
    // Only a live lifecycle may override its persisted terminal result.
    const live = turn.key === activeKey && opts.lastTurnLifecycle && isLiveLifecycle(opts.lastTurnLifecycle);
    const lifecycle = live ? opts.lastTurnLifecycle! : status ? persisted : turn.key === activeKey ? opts.lastTurnLifecycle ?? "settled" : "settled";
    return cachedTurnPresentation(turn.blocks, lifecycle);
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

/** Same result as scanning the tail once per candidate, without the O(n²). */
function latestUninvalidatedFinalAgent(blocks: ThreadBlock[]): AgentMessageBlock | null {
  let invalidated = false;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === "agent" && block.presentationRole === "final" && !invalidated) return block;
    if (invalidatesExplicitFinal(block)) invalidated = true;
  }
  return null;
}

interface CachedTurnPresentation {
  blocks: ThreadBlock[];
  lifecycle: TurnLifecycle;
  presentation: TurnPresentation;
}

/** Fold updates rebuild the block array but keep untouched blocks by reference.
 *  Reusing the presentation of a turn whose inputs did not change keeps settled
 *  turns referentially equal across a parent re-render, so `memo` can skip them. */
const presentationCache = new WeakMap<ThreadBlock, CachedTurnPresentation[]>();
const MAX_CACHED_PRESENTATIONS = 4;

function sameBlocks(left: readonly ThreadBlock[], right: readonly ThreadBlock[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function cachedTurnPresentation(blocks: ThreadBlock[], lifecycle: TurnLifecycle): TurnPresentation {
  const anchor = blocks[0];
  if (!anchor) return buildTurnPresentation(blocks, lifecycle);
  const entries = presentationCache.get(anchor);
  if (entries) {
    for (const entry of entries) {
      if (entry.lifecycle === lifecycle && sameBlocks(entry.blocks, blocks)) return entry.presentation;
    }
  }
  const presentation = buildTurnPresentation(blocks, lifecycle);
  const next = entries ? [...entries, { blocks, lifecycle, presentation }] : [{ blocks, lifecycle, presentation }];
  presentationCache.set(anchor, next.slice(-MAX_CACHED_PRESENTATIONS));
  return presentation;
}

function buildTurnPresentation(blocks: ThreadBlock[], lifecycle: TurnLifecycle): TurnPresentation {
  const terminal = blocks.find((block) => block.kind === "user" && block.turnStatus) ?? blocks.findLast((block) => "turnStatus" in block && block.turnStatus);
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
  const finalAgent = latestUninvalidatedFinalAgent(blocks)
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
    ...(terminal && "turnStartedAt" in terminal ? { startedAt: terminal.turnStartedAt, endedAt: terminal.turnEndedAt } : {}),
    active,
    completed: lifecycle === "settled" && (finalAgent !== null || settled),
  };
}

/** A turn whose presentation is still in flight (streaming, waiting, or
 *  recovering) — its activity streams open with a pinned status row. */
export function isLiveLifecycle(lifecycle: TurnLifecycle): boolean {
  return lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting" || lifecycle === "recovering" || lifecycle === "stopping";
}
