/** Rebuild continuous history windows while preserving live content and timing. */
import type { ThinkingBlock, ThreadBlock, ToolCallBlock } from "../../../types/thread";
import type { HistoryMessage } from "../../client/pi-science-client";
import type { Thread } from "./types";
import { preserveFoldState, resetThreadProjection } from "./state";
import { threadFromMessages } from "./history-conversion";

/** Prepend an older history page while keeping any live tail already visible. */
export function prependHistoryMessages(current: Thread, messages: HistoryMessage[]): Thread {
  const older = threadFromMessages(messages).blocks;
  if (older.length === 0) return current;
  const existingIds = new Set(current.blocks.map((block) => block.id));
  const currentBlocks = [...current.blocks];
  const existingToolCalls = new Map<string, number>();
  currentBlocks.forEach((block, position) => {
    if (block.kind === "tool") existingToolCalls.set(block.callId, position);
  });
  const uniqueOlder = older.filter((block) => {
    if (block.kind === "tool") {
      const existing = existingToolCalls.get(block.callId);
      if (existing !== undefined) {
        const currentBlock = currentBlocks[existing];
        if (currentBlock?.kind === "tool") currentBlocks[existing] = mergeToolHistoryBlock(currentBlock, block);
        return false;
      }
    }
    if (existingIds.has(block.id)) return false;
    return true;
  });
  const blocks = [...uniqueOlder, ...currentBlocks];
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return preserveFoldState({ blocks, index, loaded: true }, current);
}

/** Keep the newer result/status while enriching it with invocation metadata
 * from an older page. History pagination commonly splits an assistant
 * toolCall from its later toolResult, so call-id deduplication must merge
 * fields rather than discard the call half. */
function mergeToolHistoryBlock(current: ToolCallBlock, older: ToolCallBlock): ToolCallBlock {
  const statusHistory = [...(older.statusHistory ?? [older.status]), ...(current.statusHistory ?? [current.status])]
    .filter((status, index, values) => index === 0 || status !== values[index - 1]);
  return {
    ...older,
    ...current,
    tool: current.tool === "unknown" ? older.tool : current.tool,
    input: current.input ?? older.input,
    output: current.output ?? older.output,
    partialOutput: current.partialOutput ?? older.partialOutput,
    details: current.details ?? older.details,
    presentation: current.presentation ?? older.presentation,
    title: current.title ?? older.title,
    diff: current.diff ?? older.diff,
    startedAt: older.startedAt ?? current.startedAt,
    endedAt: current.endedAt ?? older.endedAt,
    turnId: current.turnId ?? older.turnId,
    runId: current.runId ?? older.runId,
    itemId: current.itemId ?? older.itemId,
    parentItemId: current.parentItemId ?? older.parentItemId,
    statusHistory,
  };
}

/** Preserve UI-observed step timing across authoritative rebuilds. History
 *  rows carry no wall-clock fields, so step durations would silently vanish
 *  on every settle-time resync without this carry-over. Only missing fields
 *  are filled: explicit runtime timestamps stay authoritative. */
function carryStepTiming(current: Thread, authoritative: Thread, preserveProjection = true): Thread {
  if (authoritative.blocks.length === 0) return authoritative;
  const timingByCallId = new Map<string, { startedAt?: string; endedAt?: string }>();
  for (const block of current.blocks) {
    if (block.kind !== "tool" || (!block.startedAt && !block.endedAt)) continue;
    timingByCallId.set(block.callId, { startedAt: block.startedAt, endedAt: block.endedAt });
  }
  const thinkingTiming = thinkingTimingByPhase(current.blocks);
  if (timingByCallId.size === 0 && thinkingTiming.size === 0) return authoritative;
  let changed = false;
  const blocks = authoritative.blocks.map((block) => {
    if (block.kind === "tool") {
      const timing = timingByCallId.get(block.callId);
      if (!timing || (block.startedAt && block.endedAt)) return block;
      changed = true;
      return { ...block, ...(block.startedAt ? {} : { startedAt: timing.startedAt }), ...(block.endedAt ? {} : { endedAt: timing.endedAt }) };
    }
    if (block.kind !== "thinking") return block;
    const key = thinkingPhaseKey(block);
    const timing = key === undefined ? undefined : thinkingTiming.get(key);
    if (!timing || (block.startedAt && block.endedAt)) return block;
    changed = true;
    return { ...block, ...(block.startedAt ? {} : { startedAt: timing.startedAt }), ...(block.endedAt ? {} : { endedAt: timing.endedAt }) };
  });
  if (!changed) return authoritative;
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  const rebuilt = { blocks, index, loaded: authoritative.loaded };
  return preserveProjection ? preserveFoldState(rebuilt, current) : rebuilt;
}

/** Reasoning timing keyed by the phase itself. The persisted message record
 *  carries no turn/item identity and a history rebuild materializes the row
 *  from a message id, so neither the row id nor its turn can join the live
 *  phase to its restored copy — the reasoning text is the same string in both
 *  projections, so that is what identifies the phase. Two phases whose text is
 *  byte-identical are indistinguishable by design; the later one wins. */
function thinkingTimingByPhase(blocks: ThreadBlock[]): Map<string, { startedAt?: string; endedAt?: string }> {
  const timing = new Map<string, { startedAt?: string; endedAt?: string }>();
  for (const block of blocks) {
    if (block.kind !== "thinking" || (!block.startedAt && !block.endedAt)) continue;
    const key = thinkingPhaseKey(block);
    if (key) timing.set(key, { startedAt: block.startedAt, endedAt: block.endedAt });
  }
  return timing;
}

function thinkingPhaseKey(block: ThinkingBlock): string | undefined {
  const text = block.parts.map((part) => part.text).join("");
  // The whole text, not a prefix: two phases that merely share an opening
  // would otherwise collide and inherit each other's duration.
  return text || undefined;
}

export function replaceHistoryTail(current: Thread, messages: HistoryMessage[]): Thread {
  const authoritative = carryStepTiming(current, threadFromMessages(messages));
  if (authoritative.blocks.length === 0) return current;
  const authoritativeIds = new Set(authoritative.blocks.map((block) => block.id));
  const firstOverlap = current.blocks.findIndex((block) => authoritativeIds.has(block.id));
  if (firstOverlap < 0) return preserveFoldState({ blocks: authoritative.blocks, index: authoritative.index, loaded: authoritative.loaded }, current);
  const blocks = [...current.blocks.slice(0, firstOverlap), ...authoritative.blocks];
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return preserveFoldState({ blocks, index, loaded: true }, current);
}

export interface HistoryWindowMerge {
  thread: Thread;
  /** True when the merged window still starts with the previously loaded
   *  older prefix. The caller must then keep its older pagination boundary
   *  (cursor/hasMore): the fresh latest-page metadata only describes the
   *  tail page, not the whole merged window. */
  retainedOlderPrefix: boolean;
}

/** Rebuild the loaded window around a fresh latest-page snapshot while
 *  reporting which pagination boundary describes the result.
 *
 *  Keep older prefix blocks only outside turns covered by the snapshot. A
 *  complete settled snapshot replaces the window, including anonymous extras.
 *  With `keepLiveExtras` the merge also preserves live blocks the snapshot does not cover yet (streaming
 *  text, just-finished tools) — used by mid-stream recovery paths. Without
 *  it the settled snapshot is authoritative and live extras are dropped. */
export function mergeHistoryWindow(current: Thread, messages: HistoryMessage[], opts: { keepLiveExtras: boolean; resetProjection?: boolean; windowComplete?: boolean }): HistoryWindowMerge {
  const authoritative = carryStepTiming(current, threadFromMessages(messages), !opts.resetProjection);
  if (authoritative.blocks.length === 0) {
    // An empty page is never authoritative over a thread that still holds
    // conversation content. A fetch can race the session's first flush, and
    // replacing the thread would blank the optimistic prompt and everything
    // already streamed until some later refresh happens to include it.
    // Callers that intentionally clear a conversation blank the thread
    // themselves (session switch, workspace landing), so an empty snapshot may
    // only reset an already empty thread.
    const clearable = current.blocks.length === 0;
    return {
      thread: opts.resetProjection && clearable ? resetThreadProjection(authoritative) : current,
      retainedOlderPrefix: true,
    };
  }
  // A complete snapshot has no older page to preserve. In particular, live
  // anonymous reasoning before the first shared tool is not older history.
  if (opts.windowComplete && !opts.keepLiveExtras) {
    const replacement = authoritative;
    return {
      thread: opts.resetProjection ? resetThreadProjection(replacement) : preserveFoldState(replacement, current),
      retainedOlderPrefix: false,
    };
  }
  const authoritativeIds = new Set(authoritative.blocks.map((block) => block.id));
  const firstOverlap = current.blocks.findIndex((block) => authoritativeIds.has(block.id));
  if (firstOverlap < 0) {
    // No shared lineage: the snapshot replaces the window wholesale and the
    // old boundary is meaningless — the caller must re-derive it.
    const replacement = opts.keepLiveExtras
      ? mergeHistoryWithLive(authoritative, current)
      : opts.resetProjection
        ? resetThreadProjection(authoritative)
        : preserveFoldState({ blocks: authoritative.blocks, index: authoritative.index, loaded: authoritative.loaded }, current);
    return { thread: replacement, retainedOlderPrefix: false };
  }
  // Only a snapshot that includes a turn's user boundary can replace that
  // turn's live prefix. A page starting mid-turn must keep its earlier content.
  const firstUser = authoritative.blocks.findIndex((block) => block.kind === "user");
  const coveredTurnOwners = new Map<string, string>();
  if (firstUser >= 0) {
    for (const block of current.blocks) {
      const position = authoritative.index[block.id];
      if (position !== undefined && position >= firstUser && "turnId" in block && block.turnId) {
        const owner = authoritative.blocks.slice(0, position + 1).findLast((candidate) => candidate.kind === "user");
        if (owner) coveredTurnOwners.set(block.turnId, owner.id);
      }
    }
  }
  const prefix: ThreadBlock[] = [];
  const coveredLive: ThreadBlock[] = [];
  for (const block of current.blocks.slice(0, firstOverlap)) {
    if (block.kind !== "user" && "turnId" in block && block.turnId && coveredTurnOwners.has(block.turnId)) {
      coveredLive.push(block);
    } else {
      prefix.push(block);
    }
  }
  const tail = opts.keepLiveExtras
    ? mergeHistoryWithLive(authoritative, { blocks: current.blocks.slice(firstOverlap), index: {}, loaded: true })
    : authoritative;
  const tailBlocks = [...tail.blocks];
  if (opts.keepLiveExtras) {
    // Preserve in-flight extras within their proven owner, not after a newer
    // user turn in a multi-turn snapshot.
    for (const block of coveredLive) {
      const ownerId = coveredTurnOwners.get("turnId" in block ? block.turnId ?? "" : "");
      const ownerIndex = tailBlocks.findIndex((candidate) => candidate.id === ownerId);
      const nextUser = tailBlocks.findIndex((candidate, position) => position > ownerIndex && candidate.kind === "user");
      tailBlocks.splice(nextUser < 0 ? tailBlocks.length : nextUser, 0, block);
    }
  }
  const blocks = [...prefix, ...tailBlocks];
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  const merged = { blocks, index, loaded: true };
  return { thread: opts.resetProjection ? resetThreadProjection(merged) : preserveFoldState(merged, current), retainedOlderPrefix: !opts.windowComplete && (prefix.length > 0 || (firstOverlap === 0 && authoritative.index[current.blocks[0].id] === 0)) };
}

export function mergeHistoryWithLive(history: Thread, live: Thread): Thread {
  if (live.blocks.length === 0) return history;
  const ids = new Set(history.blocks.map((block) => block.id));
  const toolCallIds = new Set(
    history.blocks
      .filter((block): block is Extract<ThreadBlock, { kind: "tool" }> => block.kind === "tool")
      .map((block) => block.callId),
  );
  const durableUsersByClientId = new Map<string, Extract<ThreadBlock, { kind: "user" }>[]>();
  for (const block of history.blocks) {
    if (block.kind !== "user" || !block.client_message_id) continue;
    const matches = durableUsersByClientId.get(block.client_message_id) ?? [];
    matches.push(block);
    durableUsersByClientId.set(block.client_message_id, matches);
  }
  const blocks = [...history.blocks];
  for (const block of live.blocks) {
    if (ids.has(block.id)) continue;
    if (block.kind === "tool" && toolCallIds.has(block.callId)) continue;
    if (block.kind === "user") {
      if (block.client_message_id) {
        // Only an exact request identity proves that this durable row is the
        // optimistic send. If history has duplicate IDs, preserve the live
        // block so the ambiguous state remains visible for recovery.
        if (durableUsersByClientId.get(block.client_message_id)?.length === 1) continue;
      } else if (
        block.optimisticFirstInSession
        && !history.blocks.some((candidate) => candidate.kind === "user" && candidate.client_message_id)
        && history.blocks[0]?.kind === "user"
        && history.blocks[0].text === block.text
      ) {
        // Compatibility for pre-protocol first messages in a session known to
        // have been created by this client. Old sessions with uncertain order
        // keep both rows instead of guessing from text, time, or an anchor.
        continue;
      }
    }
    blocks.push(block);
    ids.add(block.id);
    if (block.kind === "tool") toolCallIds.add(block.callId);
  }
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return preserveFoldState({ blocks, index, loaded: true }, live.foldState ? live : history);
}
