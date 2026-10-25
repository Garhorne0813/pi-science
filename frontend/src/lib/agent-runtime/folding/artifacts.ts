import type { ThreadBlock } from "../../../types/thread";
import type { TurnArtifactItem } from "../../../types/thread";
import type { TurnArtifactTurn } from "../../client/pi-science-client";
import type { Thread } from "./types";
import { numberValue } from "./identity";
import { preserveFoldState } from "./state";

/** Position right after the `ordinal`-th agent block (1-based), or the end of
 *  the thread when there are fewer agent blocks (e.g. tool-only turns). Used to
 *  anchor turn-artifact strips by turn order when no assistant message id is
 *  available. */
export function afterAgentBlock(blocks: ThreadBlock[], ordinal: number): number {
  let count = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].kind === "agent") {
      count += 1;
      if (count === ordinal) return i + 1;
    }
  }
  return blocks.length;
}

export function isHubTurnId(turnId: string): boolean {
  return /^turn-.+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turnId);
}

/** Position after the last block carrying a stable turn identity. This is the
 * strongest live artifact anchor when an older turn publishes after a newer
 * turn has already started. */
export function afterIdentifiedTurn(blocks: ThreadBlock[], turnId: string): number {
  let last = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind !== "artifact-summary" && "turnId" in block && block.turnId === turnId) last = i;
  }
  return last >= 0 ? last + 1 : -1;
}

/** Position right after the LAST agent block of the `turnIndex`-th turn
 *  (1-based). Turns are delimited by user-message boundaries: turn N is the
 *  span between the N-th user block and the (N+1)-th user block (or thread
 *  end). A turn with no agent block (tool-only) anchors at its own span end.
 *  Falls back to the `turnIndex`-th agent block when user boundaries are
 *  insufficient (paged history missing early user messages), so the strip
 *  never lands between messages of a multi-assistant-message turn. */
export function afterTurnEnd(blocks: ThreadBlock[], turnIndex: number): number {
  const userIndexes: number[] = [];
  blocks.forEach((block, position) => { if (block.kind === "user") userIndexes.push(position); });
  if (userIndexes.length < turnIndex) return afterAgentBlock(blocks, turnIndex);
  const spanStart = userIndexes[turnIndex - 1] + 1;
  const spanEnd = turnIndex < userIndexes.length ? userIndexes[turnIndex] : blocks.length;
  let lastAgent = -1;
  for (let i = spanStart; i < spanEnd; i += 1) {
    if (blocks[i].kind === "agent") lastAgent = i;
  }
  return lastAgent >= 0 ? lastAgent + 1 : spanEnd;
}

/** Position right after the LAST agent block of the turn that ended at
 *  `endedAt` (ISO). The turn's user message is the last user block whose
 *  timestamp is <= endedAt; the turn span runs from there to the next user
 *  block. This is robust against BOTH duplicate ordinals from legacy records
 *  AND turns that produced no artifact record (the ended_at timestamp still
 *  identifies the correct turn). If a paged history has no user boundary,
 *  anchor after the latest timestamped agent block at or before `endedAt`.
 *  Returns -1 when no matching agent block is available. */
export function afterTurnEndedAt(blocks: ThreadBlock[], endedAt: string): number {
  // The turn's user message is the timestamped user block with the LATEST
  // timestamp that is still <= endedAt. Position is not reliable: the JSONL
  // write order can differ from chronological order (a later turn may be
  // written before an earlier one), so pick by time, not by position.
  let lastUser = -1;
  let lastUserTime = "";
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind === "user" && typeof block.timestamp === "string" && block.timestamp <= endedAt && block.timestamp > lastUserTime) {
      lastUser = i;
      lastUserTime = block.timestamp;
    }
  }
  let lastAgent = -1;
  if (lastUser >= 0) {
    let lastContent = lastUser;
    for (let i = lastUser + 1; i < blocks.length; i += 1) {
      if (blocks[i].kind === "user") break;
      if (blocks[i].kind !== "artifact-summary") lastContent = i;
      if (blocks[i].kind === "agent") lastAgent = i;
    }
    // A tool-only turn still has a known user boundary and owns its files.
    if (lastAgent < 0) return lastContent + 1;
  } else {
    // A tail page can omit the turn's opening user message. Use the end time
    // to find the latest agent block that belongs to the turn. Compare times,
    // not positions, because JSONL write order is not always chronological.
    let lastAgentTime = "";
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block.kind === "agent" && typeof block.timestamp === "string" && block.timestamp <= endedAt && block.timestamp >= lastAgentTime) {
        lastAgent = i;
        lastAgentTime = block.timestamp;
      }
    }
  }
  return lastAgent >= 0 ? lastAgent + 1 : -1;
}

/** Position right after the LAST agent block of the user-delimited turn that
 *  contains `assistantMessageId`. The id is a turn anchor, NOT an insertion
 *  position: an intermediate assistant message of a multi-message turn must
 *  still land the strip after the turn's final assistant message (PRD
 *  artifact-card turn-end placement). A tool-only turn (no agent block in the
 *  span) anchors at its own span end. Returns -1 when the anchor block is not
 *  present (paged history has not loaded it yet). */
export function afterAssistantTurnEnd(blocks: ThreadBlock[], assistantMessageId: string, index: Record<string, number>): number {
  const anchor = index[assistantMessageId];
  if (anchor === undefined) return -1;
  let spanStart = 0;
  for (let i = anchor; i >= 0; i -= 1) {
    if (blocks[i]?.kind === "user") {
      spanStart = i + 1;
      break;
    }
  }
  let spanEnd = blocks.length;
  for (let i = anchor + 1; i < blocks.length; i += 1) {
    if (blocks[i].kind === "user") {
      spanEnd = i;
      break;
    }
  }
  let lastAgent = -1;
  for (let i = spanStart; i < spanEnd; i += 1) {
    if (blocks[i].kind === "agent") lastAgent = i;
  }
  return lastAgent >= 0 ? lastAgent + 1 : spanEnd;
}

/** Controls whether position-based compatibility anchors are safe. */
export interface ArtifactAttachOptions {
  windowComplete: boolean;
}

/** Attach persisted artifact summaries to their turn ends. */
export function attachTurnArtifacts(thread: Thread, turns: TurnArtifactTurn[], opts: ArtifactAttachOptions): Thread {
  const windowComplete = opts.windowComplete;
  if (!turns || turns.length === 0) return thread;
  let blocks = [...thread.blocks];
  let index = { ...thread.index };
  let changed = false;
  let insertedBefore = blocks.filter((b) => b.kind === "artifact-summary").length;
  const usedOrdinals = new Set<number>();
  let ordinalBroken = false;
  let recordIndex = 0;
  for (const turn of turns) {
    const items = Array.isArray(turn.artifacts) ? turn.artifacts as TurnArtifactItem[] : [];
    if (!turn.turn_id || items.length === 0) continue;
    recordIndex += 1;
    const blockId = `turn-artifacts-${turn.turn_id}`;
    const assistantMessageId = turn.assistant_message_id ?? null;
    const ordinal = Number(turn.turn_ordinal);
    let insertAt = -1;
    if (assistantMessageId) {
      // Same placement semantics as the live fold (FR-05): the persisted id
      // anchors the containing turn; the strip goes after that turn's LAST
      // assistant message, not right after an intermediate id.
      insertAt = afterAssistantTurnEnd(blocks, assistantMessageId, index);
    }
    if (insertAt < 0) insertAt = afterIdentifiedTurn(blocks, turn.turn_id);
    if (insertAt < 0 && typeof turn.ended_at === "string" && turn.ended_at) {
      // Primary fallback: anchor by the turn's end time. Independent of
      // ordinals, so legacy duplicate ordinals and record-less turns both
      // resolve to the correct turn (the last timestamped user block before
      // endedAt starts the span; the strip lands after that turn's LAST
      // agent block).
      insertAt = afterTurnEndedAt(blocks, turn.ended_at);
    }
    if (insertAt < 0 && (!windowComplete || isHubTurnId(turn.turn_id))) {
      // Partial history window: this record's turn has not loaded yet (its
      // user message and agent blocks live in an older page). Every
      // remaining anchor would guess from the window start and land the
      // strip on a newer turn, so defer placement; a later attach (after
      // the older page is prepended) anchors it correctly.
      continue;
    }
    if (insertAt < 0 && !ordinalBroken && Number.isInteger(ordinal) && ordinal > 0 && !usedOrdinals.has(ordinal)) {
      // Anchor to the END of the ordinal-th turn (user-message delimited) so
      // multi-assistant-message turns get their strip after the last message;
      // falls back to the n-th agent block when user boundaries are missing.
      usedOrdinals.add(ordinal);
      insertAt = afterTurnEnd(blocks, ordinal);
    } else if (insertAt < 0) {
      // A repeated ordinal (stale records from a runtime rebuild that reset
      // the counter) breaks the whole sequence: from here on, every record
      // uses its record position (the M-th record anchors the M-th turn) so
      // mixed data like [1,1,2] still lands each strip in its own turn.
      ordinalBroken = true;
      insertAt = afterTurnEnd(blocks, recordIndex);
    }
    if (insertAt < 0) {
      // Anchor by turn order: the next ordinal strip goes right after the
      // matching agent block, falling back to the end for tool-only turns.
      insertAt = afterAgentBlock(blocks, insertedBefore + 1);
    }
    if (insertAt < 0) insertAt = blocks.length;
    const persistedBlock: ThreadBlock = {
      kind: "artifact-summary",
      id: blockId,
      turnId: turn.turn_id,
      assistantMessageId,
      ...(turn.ended_at ? { endedAt: turn.ended_at } : {}),
      ...(Number.isInteger(ordinal) && ordinal > 0 ? { turnOrdinal: ordinal } : {}),
      artifacts: items,
    };
    const existingIdx = index[blockId];
    const existingBlock = existingIdx === undefined ? undefined : blocks[existingIdx];
    const versionedExisting = existingBlock?.kind === "artifact-summary"
      && (numberValue(existingBlock.revision) !== undefined || numberValue(existingBlock.sequence) !== undefined)
      ? existingBlock
      : undefined;
    // Persisted records currently carry no projection revision. They may have
    // better turn-anchor metadata than a live summary (for example after an
    // older history page loads), but must not roll versioned live content back
    // to a stale REST/cache snapshot or discard its reconciliation metadata.
    const block: ThreadBlock = versionedExisting ? {
      ...versionedExisting,
      ...(turn.ended_at ? { endedAt: turn.ended_at } : {}),
      assistantMessageId: assistantMessageId ?? versionedExisting.assistantMessageId ?? null,
      ...(Number.isInteger(ordinal) && ordinal > 0
        ? { turnOrdinal: ordinal }
        : versionedExisting.turnOrdinal !== undefined
          ? { turnOrdinal: versionedExisting.turnOrdinal }
          : {}),
    } : persistedBlock;
    if (existingIdx !== undefined) {
      if (existingIdx === insertAt) {
        // Already at the right place: refresh the block content in place.
        blocks[existingIdx] = block;
        changed = true;
        continue;
      }
      // Reposition: remove from the old slot, then re-insert at the target.
      blocks.splice(existingIdx, 1);
      const nextIndex: Record<string, number> = {};
      for (const key of Object.keys(index)) {
        if (key === blockId) continue;
        if (index[key] > existingIdx) nextIndex[key] = index[key] - 1;
        else nextIndex[key] = index[key];
      }
      index = nextIndex;
      if (insertAt > existingIdx) insertAt -= 1;
    }
    blocks.splice(insertAt, 0, block);
    insertedBefore += 1;
    index = { ...index };
    for (const key of Object.keys(index)) {
      if (index[key] >= insertAt) index[key] += 1;
    }
    index[blockId] = insertAt;
    changed = true;
  }
  if (!changed) return thread;
  return preserveFoldState({ blocks, index, loaded: thread.loaded }, thread);
}
