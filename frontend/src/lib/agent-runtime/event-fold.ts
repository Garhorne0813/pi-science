/** Thread model and transport event folding (ported from open-science foldEvent).
 *
 *  The turn buffer below is module-level mutable state owned by this module:
 *  `foldEvent` accumulates text deltas across events of the same agent turn.
 *  Every code path that starts or abandons a turn (connect, sendPrompt,
 *  agent_start, stream.gap, session replacement, missing-session recovery)
 *  clears it through `resetTurnBuffer()`. */

import type { ThreadBlock } from "../../types/thread";
import type { TurnArtifactItem } from "../../types/thread";
import type { HistoryMessage, PiScienceEvent, TurnArtifactTurn } from "../client/pi-science-client";

export interface Thread {
  blocks: ThreadBlock[];
  /** Map from block id to index in blocks array */
  index: Record<string, number>;
  loaded: boolean;
}

export function emptyThread(): Thread {
  return { blocks: [], index: {}, loaded: false };
}

let _textBuffer = ""; // Accumulates text deltas
let _currentTurnId = ""; // Unique ID per agent turn, resets on agent_start
/** Index (in the folded block list) of the last agent block inserted or
 *  updated in the current turn. `turn.artifacts` arrives after the turn's
 *  final assistant message, so this is the exact "turn end" position even
 *  when the turn spans several assistant messages (anonymous part ids). */
let _turnLastAgentIndex = -1;

/** Drop the accumulated text of the current turn. Called by every path that
 *  begins a new turn or invalidates the one in flight. */
export function resetTurnBuffer(): void {
  _textBuffer = "";
  _currentTurnId = "";
  _turnLastAgentIndex = -1;
}

export function foldEvent(state: Thread, event: PiScienceEvent): Thread {
  const blocks = [...state.blocks];
  const index = { ...state.index };

  switch (event.type) {
    case "text.updated": {
      const eventPartId = typeof event.partId === "string" && event.partId
        ? event.partId
        : null;
      if (eventPartId && _currentTurnId && eventPartId !== _currentTurnId) {
        const previousIdx = index[_currentTurnId];
        const previous = previousIdx !== undefined ? blocks[previousIdx] : undefined;
        if (previous?.kind === "agent" && previous.partial) {
          blocks[previousIdx] = { ...previous, partial: false };
        }
        _textBuffer = "";
        _currentTurnId = eventPartId;
      } else if (eventPartId && !_currentTurnId) {
        _currentTurnId = eventPartId;
      }
      const incomingText = (event.text as string) || "";
      _textBuffer = event.replace === true ? incomingText : _textBuffer + incomingText;
      // Skip initial empty text events that create placeholder agent blocks
      // (DeepSeek sends empty text.updated between tool calls before real text)
      const hasText = _textBuffer.trim().length > 0;
      if (!hasText) break;  // Don't create/update agent block for empty text
      const turnId = _currentTurnId || `agent-${Date.now()}`;
      if (!_currentTurnId) _currentTurnId = turnId;
      const blockId = turnId;
      const existingIdx = index[blockId];
      if (existingIdx !== undefined) {
        const hasToolsAfter = blocks.slice(existingIdx + 1).some((b) => b.kind === "tool");
        if (hasToolsAfter) {
          // Pre-tool text → finalize old block; redirect turn ID to new post-tool block
          const oldBlock = blocks[existingIdx];
          if (oldBlock.kind === "agent") {
            blocks[existingIdx] = { ...oldBlock, partial: false };
          }
          _textBuffer = (event.text as string) || "";
          // Update turn ID so subsequent events find this post-tool block
          _currentTurnId = turnId + "-post";
          index[turnId + "-post"] = blocks.length;
          _turnLastAgentIndex = blocks.length;
          blocks.push({
            kind: "agent",
            id: turnId + "-post",
            parts: [{ id: turnId + "-post", text: _textBuffer }],
            partial: true,
            timestamp: new Date().toISOString(),
          } as ThreadBlock);
        } else {
          blocks[existingIdx] = {
            ...blocks[existingIdx],
            kind: "agent",
            parts: [{ id: turnId, text: _textBuffer }],
            partial: true,
            timestamp: blocks[existingIdx].kind === "agent" ? blocks[existingIdx].timestamp : undefined,
          } as ThreadBlock;
          _turnLastAgentIndex = existingIdx;
        }
      } else {
        // New block for this turn
        const block: ThreadBlock = {
          kind: "agent",
          id: blockId,
          parts: [{ id: turnId, text: _textBuffer }],
          partial: true,
          timestamp: new Date().toISOString(),
        };
        index[blockId] = blocks.length;
        _turnLastAgentIndex = blocks.length;
        blocks.push(block);
      }
      break;
    }

    case "tool.updated": {
      const callId = event.callId as string;
      const blockId = `tool-${callId}`;
      const existingIdx = index[blockId];
      const previous = existingIdx !== undefined && blocks[existingIdx].kind === "tool"
        ? blocks[existingIdx]
        : undefined;
      const block: ThreadBlock = {
        kind: "tool",
        id: blockId,
        callId,
        tool: (event.tool as string) || previous?.tool || "unknown",
        status: event.status as ThreadBlock extends { status: infer S } ? S : never,
        title: (event.title as string | undefined) ?? previous?.title,
        input: (event.input as Record<string, unknown> | undefined) ?? previous?.input,
        output: (event.output as string | undefined) ?? previous?.output,
        partialOutput: (event.partialOutput as string | undefined) ?? previous?.partialOutput,
        diff: (event.diff as string | undefined) ?? previous?.diff,
        startedAt: (event.startedAt as string | undefined) ?? previous?.startedAt,
        endedAt: (event.endedAt as string | undefined) ?? previous?.endedAt,
        childSessionId: (event.childSessionId as string | undefined) ?? previous?.childSessionId,
      };
      if (existingIdx !== undefined) {
        blocks[existingIdx] = block;
      } else {
        // Push to end — the agent block moves to end on each text.updated,
        // so tools naturally appear before the current agent text.
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      break;
    }

    case "artifact.published": {
      // Folded into the per-turn artifact summary (`turn.artifacts`); a
      // standalone status line would duplicate the strip. Publication state
      // is still tracked via `publishedArtifactPaths` for prose references.
      break;
    }

    case "turn.artifacts": {
      const turnId = String(event.turnId || "");
      const items = Array.isArray(event.artifacts) ? event.artifacts as TurnArtifactItem[] : [];
      if (!turnId || items.length === 0) break;
      const blockId = `turn-artifacts-${turnId}`;
      const turnOrdinal = Number(event.turnOrdinal);
      const block: ThreadBlock = {
        kind: "artifact-summary",
        id: blockId,
        turnId,
        assistantMessageId: event.assistantMessageId ? String(event.assistantMessageId) : null,
        ...(Number.isInteger(turnOrdinal) && turnOrdinal > 0 ? { turnOrdinal } : {}),
        artifacts: items,
      };
      const existing = index[blockId];
      if (existing !== undefined) {
        blocks[existing] = block;
        break;
      }
      let insertAt = -1;
      const assistantMessageId = block.assistantMessageId;
      if (assistantMessageId && index[assistantMessageId] !== undefined) {
        insertAt = index[assistantMessageId] + 1;
      }
      if (insertAt < 0 && _turnLastAgentIndex >= 0) {
        // Live fold: anchor at the END of the current turn (after its last
        // assistant message), not after an intermediate message of a turn
        // that spans several assistant messages.
        insertAt = _turnLastAgentIndex + 1;
      }
      if (insertAt < 0 && Number.isInteger(turnOrdinal) && turnOrdinal > 0) {
        // Anchor to the n-th agent block when the turn ordinal is known. This
        // is reliable even when earlier turns produced no record (a pure
        // record-ordinal fallback would misplace strips in that case).
        insertAt = afterAgentBlock(blocks, turnOrdinal);
      }
      if (insertAt < 0) {
        // Pi's agent_settled does not carry a message id, so summaries are
        // anchored by turn order: the n-th strip goes right after the n-th
        // agent block (live agent blocks are keyed by text.updated partId).
        const insertedBefore = blocks.filter((b) => b.kind === "artifact-summary").length;
        insertAt = afterAgentBlock(blocks, insertedBefore + 1);
      }
      if (insertAt < 0) insertAt = blocks.length;
      blocks.splice(insertAt, 0, block);
      for (const key of Object.keys(index)) {
        if (index[key] >= insertAt) index[key] += 1;
      }
      index[blockId] = insertAt;
      break;
    }

    case "compaction.updated": {
      const status = String(event.status || "running");
      const blockId = "compaction-status";
      const block: ThreadBlock = {
        kind: "status-line",
        id: blockId,
        text: status === "end"
          ? "Conversation context compacted"
          : status === "error"
            ? `Context compaction failed${event.message ? `: ${String(event.message)}` : ""}`
            : `Compacting conversation context${event.message ? `: ${String(event.message)}` : "…"}`,
        level: status === "error" ? "error" : status === "end" ? "done" : "info",
      };
      const existing = index[blockId];
      if (existing === undefined) {
        index[blockId] = blocks.length;
        blocks.push(block);
      } else {
        blocks[existing] = block;
      }
      break;
    }

    case "status.updated": {
      const blockId = `runtime-status-${String(event.status || "status")}`;
      const block: ThreadBlock = {
        kind: "status-line",
        id: blockId,
        text: String(event.message || event.status || "Runtime status updated"),
        level: "info",
      };
      const existing = index[blockId];
      if (existing === undefined) {
        index[blockId] = blocks.length;
        blocks.push(block);
      } else {
        blocks[existing] = block;
      }
      break;
    }

    case "session.idle": {
      _textBuffer = "";
      _currentTurnId = "";  // Reset for next turn
      // Mark last agent block as not partial
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.kind === "agent" && block.partial) {
          blocks[i] = { ...block, partial: false };
          break;
        }
      }
      break;
    }

    case "error": {
      const msg = (event.message as string) || "Unknown error";
      // If we already have a partial agent block without text, replace it with the error
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.kind === "agent" && lastBlock.partial && !lastBlock.parts?.[0]?.text) {
        blocks[blocks.length - 1] = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: msg,
          level: "error",
        } as ThreadBlock;
        index[blocks[blocks.length - 1].id] = blocks.length - 1;
      } else {
        const errBlock: ThreadBlock = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: msg,
          level: "error",
        };
        index[errBlock.id] = blocks.length;
        blocks.push(errBlock);
      }
      break;
    }
  }

  return { blocks, index, loaded: true };
}

export function threadFromMessages(messages: HistoryMessage[]): Thread {
  const blocks = convertHistoryToBlocks(messages);
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

/** Prepend an older history page while keeping any live tail already visible. */
export function prependHistoryMessages(current: Thread, messages: HistoryMessage[]): Thread {
  const older = threadFromMessages(messages).blocks;
  if (older.length === 0) return current;
  const existingIds = new Set(current.blocks.map((block) => block.id));
  const existingToolCalls = new Set(
    current.blocks
      .filter((block): block is Extract<ThreadBlock, { kind: "tool" }> => block.kind === "tool")
      .map((block) => block.callId),
  );
  const uniqueOlder = older.filter((block) => {
    if (existingIds.has(block.id)) return false;
    if (block.kind === "tool" && existingToolCalls.has(block.callId)) return false;
    return true;
  });
  const blocks = [...uniqueOlder, ...current.blocks];
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

export function mergeHistoryWithLive(history: Thread, live: Thread): Thread {
  if (live.blocks.length === 0) return history;
  const ids = new Set(history.blocks.map((block) => block.id));
  const toolCallIds = new Set(
    history.blocks
      .filter((block): block is Extract<ThreadBlock, { kind: "tool" }> => block.kind === "tool")
      .map((block) => block.callId),
  );
  const blocks = [...history.blocks];
  for (const block of live.blocks) {
    if (ids.has(block.id)) continue;
    if (block.kind === "tool" && toolCallIds.has(block.callId)) continue;
    blocks.push(block);
    ids.add(block.id);
    if (block.kind === "tool") toolCallIds.add(block.callId);
  }
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

export function convertHistoryToBlocks(messages: HistoryMessage[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  const toolNames = new Map<string, string>();

  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) blocks.push({ kind: "user", id: msg.id, text, timestamp: msg.timestamp });
    } else if (role === "assistant") {
      for (const content of msg.content) {
        if (content.type !== "toolCall") continue;
        const callId = String(content.id || "");
        if (callId) {
          toolNames.set(callId, String(content.name || content.tool || "unknown"));
        }
      }
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) {
        blocks.push({ kind: "agent", id: msg.id, parts: [{ id: msg.id, text }], timestamp: msg.timestamp });
      }
    } else if (role === "toolResult") {
      const callId = msg.toolCallId || msg.id;
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      blocks.push({
        kind: "tool",
        id: `tool-${callId}`,
        callId,
        tool: msg.toolName || toolNames.get(callId) || "unknown",
        status: msg.isError ? "error" as const : "done" as const,
        output: text || undefined,
        details: msg.details,
      });
    }
  }
  return blocks;
}

/** Position right after the `ordinal`-th agent block (1-based), or the end of
 *  the thread when there are fewer agent blocks (e.g. tool-only turns). Used to
 *  anchor turn-artifact strips by turn order when no assistant message id is
 *  available. */
function afterAgentBlock(blocks: ThreadBlock[], ordinal: number): number {
  let count = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].kind === "agent") {
      count += 1;
      if (count === ordinal) return i + 1;
    }
  }
  return blocks.length;
}

/** Position right after the LAST agent block of the `turnIndex`-th turn
 *  (1-based). Turns are delimited by user-message boundaries: turn N is the
 *  span between the N-th user block and the (N+1)-th user block (or thread
 *  end). A turn with no agent block (tool-only) anchors at its own span end.
 *  Falls back to the `turnIndex`-th agent block when user boundaries are
 *  insufficient (paged history missing early user messages), so the strip
 *  never lands between messages of a multi-assistant-message turn. */
function afterTurnEnd(blocks: ThreadBlock[], turnIndex: number): number {
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
 *  identifies the correct turn). Returns -1 when the thread carries no
 *  timestamped user block (paged history) or the turn has no agent block. */
function afterTurnEndedAt(blocks: ThreadBlock[], endedAt: string): number {
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
  if (lastUser < 0) return -1;
  let lastAgent = -1;
  for (let i = lastUser + 1; i < blocks.length; i += 1) {
    if (blocks[i].kind === "user") break;
    if (blocks[i].kind === "agent") lastAgent = i;
  }
  return lastAgent >= 0 ? lastAgent + 1 : -1;
}

/** Attach persisted per-turn artifact summaries to a history-built thread.
 *  Idempotent per turn id: when the strip is already present it is updated in
 *  place when its position is correct, otherwise it is repositioned to the
 *  right place (SSE replay may have inserted it at a fallback position before
 *  the full history arrived).
 *
 *  Anchoring order: exact assistant message id → ended_at timestamp (end of
 *  the turn that finished at that time, delimited by timestamped user
 *  messages) → turn_ordinal (end of the n-th turn) → record order fallback
 *  → end of thread. Turns spanning several assistant messages anchor after
 *  the LAST one (Pi emits anonymous part ids without a message id); when
 *  user boundaries are unavailable (paged history) it falls back to the n-th
 *  agent block approximation.
 *
 *  Legacy-data compatibility: records persisted before turn ordinals were
 *  derived from the persisted log (runtime rebuilds used to reset the
 *  counter) can carry duplicate ordinals (e.g. two records with
 *  turn_ordinal=1). The ended_at anchor is independent of ordinals, so mixed
 *  sequences such as [1,1,2] with an intervening record-less turn still land
 *  every strip in its own turn; ordinals are only consulted when no
 *  timestamped user boundary exists. When an ordinal repeats, every LATER
 *  record falls back to its record position (the M-th record anchors the
 *  M-th turn). */
export function attachTurnArtifacts(thread: Thread, turns: TurnArtifactTurn[]): Thread {
  if (!turns || turns.length === 0) return thread;
  let blocks = thread.blocks;
  let index = thread.index;
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
    if (assistantMessageId && index[assistantMessageId] !== undefined) insertAt = index[assistantMessageId] + 1;
    if (insertAt < 0 && typeof turn.ended_at === "string" && turn.ended_at) {
      // Primary fallback: anchor by the turn's end time. Independent of
      // ordinals, so legacy duplicate ordinals and record-less turns both
      // resolve to the correct turn (the last timestamped user block before
      // endedAt starts the span; the strip lands after that turn's LAST
      // agent block).
      insertAt = afterTurnEndedAt(blocks, turn.ended_at);
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
    const block: ThreadBlock = {
      kind: "artifact-summary",
      id: blockId,
      turnId: turn.turn_id,
      assistantMessageId,
      ...(Number.isInteger(ordinal) && ordinal > 0 ? { turnOrdinal: ordinal } : {}),
      artifacts: items,
    };
    const existingIdx = index[blockId];
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
  return { blocks, index, loaded: thread.loaded };
}
