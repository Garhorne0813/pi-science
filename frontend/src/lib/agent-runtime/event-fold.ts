/** Thread model and transport event folding.
 *
 * The presentation protocol is intentionally a pure projection: all state
 * needed to join deltas, reject duplicates, and reconcile sequence gaps lives
 * on the Thread being folded. This keeps two sessions isolated even when an
 * old EventSource callback arrives after the user has switched sessions. */

import type { AgentMessageBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import type { TurnArtifactItem } from "../../types/thread";
import type { HistoryMessage, PiScienceEvent, TurnArtifactTurn } from "../client/pi-science-client";

export interface Thread {
  blocks: ThreadBlock[];
  /** Map from block id to index in blocks array */
  index: Record<string, number>;
  loaded: boolean;
  /** Internal, serializable reducer state. Omitted from an empty thread so
   * existing callers can continue to use `emptyThread()` as a stable value. */
  foldState?: EventFoldState;
}

interface TextSegment {
  eventId: string;
  sequence: number;
  revision: number;
  baseRevision?: number;
  text: string;
  replace?: boolean;
}

interface TextFoldState {
  text: string;
  revision: number;
  blockId: string;
  partId: string;
  /** V2 deltas are kept as a small replayable log while a sequence gap is
   *  open. This lets a late lower revision be inserted before an already
   *  visible speculative delta without appending the text a second time. */
  segments?: TextSegment[];
}

export interface EventFoldState {
  sessionId?: string;
  streamEpoch?: string;
  activeTurnId?: string;
  activeRunId?: string;
  activeItemKey?: string;
  lastAgentBlockId?: string;
  turnOrdinal: number;
  anonymousSerial: number;
  errorSerial: number;
  textByKey: Record<string, TextFoldState>;
  thinkingByKey: Record<string, { text: string; blockId: string }>;
  seenEventIds: string[];
  pendingEvents: PiScienceEvent[];
  /** Events that were projected (or deliberately consumed as stale) before
   *  the contiguous sequence waterline reached them. They remain pending for
   *  reconciliation, but must not be applied again when the gap closes. */
  speculativeEventIds: string[];
  terminalRunIds: string[];
  terminalRunSequences: Record<string, number>;
  reconciliationRequired: boolean;
  lastSequence?: number;
}

export function emptyThread(): Thread {
  return { blocks: [], index: {}, loaded: false };
}

/** Kept for source compatibility with older session actions. Reducer state is
 * now attached to each Thread, so a module-level reset would be incorrect. */
export function resetTurnBuffer(): void { /* state is per Thread */ }

function createFoldState(event?: PiScienceEvent): EventFoldState {
  return {
    ...(typeof event?.sessionId === "string" ? { sessionId: event.sessionId } : {}),
    ...(typeof event?.streamEpoch === "string" ? { streamEpoch: event.streamEpoch } : {}),
    turnOrdinal: 0,
    anonymousSerial: 0,
    errorSerial: 0,
    textByKey: {},
    thinkingByKey: {},
    seenEventIds: [],
    pendingEvents: [],
    speculativeEventIds: [],
    terminalRunIds: [],
    terminalRunSequences: {},
    reconciliationRequired: false,
  };
}

function cloneFoldState(state: Thread, event?: PiScienceEvent): EventFoldState {
  const current = state.foldState ?? createFoldState(event);
  return {
    ...current,
    textByKey: Object.fromEntries(Object.entries(current.textByKey).map(([key, value]) => [key, {
      ...value,
      ...(value.segments ? { segments: value.segments.map((segment) => ({ ...segment })) } : {}),
    }])),
    thinkingByKey: { ...(current.thinkingByKey ?? {}) },
    seenEventIds: [...current.seenEventIds],
    pendingEvents: [...current.pendingEvents],
    speculativeEventIds: [...(current.speculativeEventIds ?? [])],
    terminalRunIds: [...current.terminalRunIds],
    terminalRunSequences: { ...(current.terminalRunSequences ?? {}) },
  };
}

function withFoldState(thread: Omit<Thread, "foldState">, foldState: EventFoldState): Thread {
  return { ...thread, foldState };
}

function preserveFoldState(thread: Omit<Thread, "foldState">, source: Thread): Thread {
  return source.foldState ? { ...thread, foldState: source.foldState } : thread;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventHasIdentity(event: PiScienceEvent): boolean {
  return typeof event.itemId === "string" || typeof event.turnId === "string" || typeof event.runId === "string";
}

function isV2Event(event: PiScienceEvent): boolean {
  return event.schemaVersion === 2 && typeof event.eventId === "string" && typeof event.seq === "number";
}

function eventItemKey(event: PiScienceEvent, state: EventFoldState): string {
  return stringValue(event.itemId) ?? stringValue(event.partId) ?? state.activeItemKey ?? "anonymous";
}

function turnIdentity(event: PiScienceEvent, state: EventFoldState): string {
  return stringValue(event.turnId) ?? state.activeTurnId ?? `legacy-turn-${Math.max(1, state.turnOrdinal)}`;
}

function runIdentity(event: PiScienceEvent, state: EventFoldState): string | undefined {
  return stringValue(event.runId) ?? state.activeRunId;
}

function roleOf(event: PiScienceEvent): "intermediate" | "final" | undefined {
  if (event.presentationRole === "intermediate" || event.presentationRole === "final") return event.presentationRole;
  const phase = event.phase;
  if (phase === "commentary") return "intermediate";
  if (phase === "final_answer") return "final";
  return undefined;
}

function isTerminalRun(state: EventFoldState, runId: string | undefined, sequence?: number): boolean {
  if (!runId || !state.terminalRunIds.includes(runId)) return false;
  const terminalSequence = state.terminalRunSequences[runId];
  // A speculative terminal event can arrive before an earlier missing text
  // event. Sequence-aware checking lets that earlier event repair the visible
  // projection while still rejecting genuinely late events after terminal.
  return terminalSequence === undefined || sequence === undefined || sequence > terminalSequence;
}

function markTerminalRun(state: EventFoldState, runId: string | undefined, sequence?: number): void {
  if (!runId) return;
  if (!state.terminalRunIds.includes(runId)) state.terminalRunIds = [...state.terminalRunIds, runId].slice(-256);
  if (sequence !== undefined && Number.isFinite(sequence)) {
    if (state.terminalRunSequences[runId] === undefined) state.terminalRunSequences[runId] = sequence;
    const activeRunIds = new Set(state.terminalRunIds);
    for (const terminalRunId of Object.keys(state.terminalRunSequences)) {
      if (!activeRunIds.has(terminalRunId)) delete state.terminalRunSequences[terminalRunId];
    }
  }
}

function stampCurrentUser(blocks: ThreadBlock[], turnId: string, runId?: string): void {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "user") continue;
    if (block.turnId && block.turnId !== turnId) break;
    blocks[i] = { ...block, turnId, ...(runId ? { runId } : {}) };
    break;
  }
}

type NarrationSubsumption = "keep" | "replaced" | "subsumed";

/** Some models re-narrate everything said so far at the start of every
 *  message, which stacks verbatim repeats in the feed. When a fresh
 *  narration contains the previous one, the previous block is dropped (its
 *  content lives on inside the superset, so even a streamed answer that gets
 *  echoed later stays visible through the superset); when the fresh text is
 *  itself contained, it is skipped. Explicit finals are never dropped. */
function narrationSubsumption(previous: AgentMessageBlock, nextText: string): NarrationSubsumption {
  if (previous.presentationRole === "final") return "keep";
  const previousText = previous.parts.map((part) => part.text).join("");
  if (!previousText.trim() || !nextText.trim()) return "keep";
  if (nextText.includes(previousText)) return "replaced";
  if (previousText.includes(nextText)) return "subsumed";
  return "keep";
}

/** Find the latest same-turn narration block and reconcile the incoming text
 *  against it, dropping a subsumed predecessor in place. Returns "subsumed"
 *  when the caller must not create a block for this text. */
function reconcileRepeatedNarration(blocks: ThreadBlock[], index: Record<string, number>, turnId: string, nextText: string, allowDrop = true): NarrationSubsumption {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "agent") continue;
    if (block.turnId && turnId && block.turnId !== turnId) continue;
    if (block.turnId !== turnId) return "keep";
    const verdict = narrationSubsumption(block, nextText);
    if (verdict === "replaced" && !allowDrop) return "keep";
    if (verdict === "replaced") {
      blocks.splice(i, 1);
      for (const id of Object.keys(index)) delete index[id];
      blocks.forEach((entry, position) => { index[entry.id] = position; });
    }
    return verdict;
  }
  return "keep";
}

export function foldEvent(state: Thread, event: PiScienceEvent): Thread {  if (isV2Event(event)) return foldV2Event(state, event);
  return foldLegacyEvent(state, event);
}

function foldLegacyEvent(state: Thread, event: PiScienceEvent): Thread {
  const foldState = cloneFoldState(state, event);
  if (foldState.sessionId && event.sessionId && foldState.sessionId !== event.sessionId) return state;
  if (event.sessionId) foldState.sessionId = event.sessionId;
  if (event.streamEpoch) foldState.streamEpoch = String(event.streamEpoch);
  const blocks = [...state.blocks];
  const index = { ...state.index };

  switch (event.type) {
    case "agent_start": {
      foldState.turnOrdinal = Math.max(foldState.turnOrdinal, Number(event.turnOrdinal) || foldState.turnOrdinal + 1);
      foldState.activeTurnId = stringValue(event.turnId) ?? `legacy-turn-${foldState.turnOrdinal}`;
      foldState.activeRunId = stringValue(event.runId);
      foldState.activeItemKey = undefined;
      stampCurrentUser(blocks, foldState.activeTurnId, foldState.activeRunId);
      break;
    }

    case "item.started": {
      if (event.turnId) foldState.activeTurnId = String(event.turnId);
      if (event.runId) foldState.activeRunId = String(event.runId);
      if (event.itemId) foldState.activeItemKey = String(event.itemId);
      break;
    }

    case "item.completed": {
      const itemId = stringValue(event.itemId) ?? stringValue(event.partId);
      const text = itemId ? foldState.textByKey[itemId] : undefined;
      const blockIndex = text ? index[text.blockId] : undefined;
      if (blockIndex !== undefined && (blocks[blockIndex]?.kind === "agent" || blocks[blockIndex]?.kind === "thinking")) {
        blocks[blockIndex] = { ...blocks[blockIndex], partial: false };
      } else if (itemId) {
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          if ((block.kind === "agent" || block.kind === "thinking") && (block.itemId === itemId || block.id === itemId)) {
            blocks[i] = { ...block, partial: false };
          }
        }
      }
      break;
    }

    case "text.updated": {
      const explicit = eventHasIdentity(event);
      const eventPartId = stringValue(event.partId) ?? (explicit ? stringValue(event.itemId) : undefined);
      const key = eventItemKey(event, foldState);
      const previousKey = foldState.activeItemKey;
      if (eventPartId && previousKey && eventPartId !== previousKey && !explicit) {
        const previousText = foldState.textByKey[previousKey];
        const previousIdx = previousText ? index[previousText.blockId] : undefined;
        const previous = previousIdx !== undefined ? blocks[previousIdx] : undefined;
        if (previousIdx !== undefined && previous?.kind === "agent" && previous.partial) {
          blocks[previousIdx] = { ...previous, partial: false };
        }
        foldState.activeItemKey = eventPartId;
      } else if (eventPartId && !foldState.activeItemKey) {
        foldState.activeItemKey = eventPartId;
      }
      const incomingText = (event.text as string) || "";
      const previousText = foldState.textByKey[key];
      let nextText = event.replace === true ? incomingText : (previousText?.text ?? "") + incomingText;
      // Skip initial empty text events that create placeholder agent blocks
      // (DeepSeek sends empty text.updated between tool calls before real text)
      const hasText = nextText.trim().length > 0;
      const turnId = turnIdentity(event, foldState);
      const runId = runIdentity(event, foldState);
      foldState.activeTurnId = turnId;
      if (runId) foldState.activeRunId = runId;
      stampCurrentUser(blocks, turnId, runId);
      const role = roleOf(event);
      const revision = numberValue(event.revision) ?? ((previousText?.revision ?? 0) + 1);
      if (!hasText) {
        foldState.textByKey[key] = {
          text: nextText,
          revision,
          blockId: previousText?.blockId ?? (explicit ? `agent-${turnId}-${stringValue(event.itemId) ?? key}` : key),
          partId: eventPartId ?? key,
        };
        break;
      }
      let blockId = previousText?.blockId ?? (explicit ? `agent-${turnId}-${stringValue(event.itemId) ?? key}` : (eventPartId ?? key));
      const existingIdx = index[blockId];
      if (existingIdx !== undefined) {
        const hasToolsAfter = blocks.slice(existingIdx + 1).some((b) => b.kind === "tool");
        if (hasToolsAfter && !explicit) {
          // Pre-tool text → finalize old block; redirect turn ID to new post-tool block
          const oldBlock = blocks[existingIdx];
          if (oldBlock.kind === "agent") {
            blocks[existingIdx] = { ...oldBlock, partial: false };
          }
          nextText = incomingText;
          blockId = `${blockId}-post`;
          // A legacy runtime can reuse a part id after a tool. Keep the
          // compatibility split deterministic while leaving V2 item ids
          // single-writer and stable.
          let postId = blockId;
          let suffix = 2;
          while (index[postId] !== undefined) postId = `${blockId}-${suffix++}`;
          blockId = postId;
          if (reconcileRepeatedNarration(blocks, index, turnId, nextText) === "subsumed") {
            foldState.textByKey[key] = { text: nextText, revision, blockId: `subsumed-${blockId}`, partId: eventPartId ?? key };
            break;
          }
          foldState.activeItemKey = blockId;
          index[blockId] = blocks.length;
          foldState.lastAgentBlockId = blockId;
          blocks.push({
            kind: "agent",
            id: blockId,
            turnId,
            ...(runId ? { runId } : {}),
            itemId: stringValue(event.itemId) ?? eventPartId,
            parts: [{ id: eventPartId ?? blockId, text: nextText }],
            ...(role ? { presentationRole: role } : {}),
            classificationSource: role ? "explicit" : "legacy_inferred",
            partial: true,
            timestamp: new Date().toISOString(),
          });
        } else {
          blocks[existingIdx] = {
            ...blocks[existingIdx],
            kind: "agent",
            turnId,
            ...(runId ? { runId } : {}),
            itemId: stringValue(event.itemId) ?? eventPartId ?? (blocks[existingIdx].kind === "agent" ? blocks[existingIdx].itemId : undefined),
            parts: [{ id: eventPartId ?? blockId, text: nextText }],
            ...(role ? { presentationRole: role, classificationSource: "explicit" as const } : {}),
            partial: true,
            timestamp: blocks[existingIdx].kind === "agent" ? blocks[existingIdx].timestamp : undefined,
          } as ThreadBlock;
          foldState.lastAgentBlockId = blockId;
        }
      } else {
        // New block for this turn. Some models re-narrate everything said so
        // far at the start of every message; collapse the verbatim repeat
        // instead of stacking another copy in the feed.
        if (reconcileRepeatedNarration(blocks, index, turnId, nextText, role !== "final") === "subsumed") {
          foldState.textByKey[key] = { text: nextText, revision, blockId: `subsumed-${blockId}`, partId: eventPartId ?? key };
          break;
        }
        const block: ThreadBlock = {
          kind: "agent",
          id: blockId,
          turnId,
          ...(runId ? { runId } : {}),
          ...(stringValue(event.itemId) || eventPartId ? { itemId: stringValue(event.itemId) ?? eventPartId } : {}),
          parts: [{ id: eventPartId ?? blockId, text: nextText }],
          ...(role ? { presentationRole: role } : {}),
          classificationSource: role ? "explicit" : "legacy_inferred",
          partial: true,
          timestamp: new Date().toISOString(),
        };
        index[blockId] = blocks.length;
        foldState.lastAgentBlockId = blockId;
        blocks.push(block);
      }
      foldState.textByKey[key] = { text: nextText, revision, blockId, partId: eventPartId ?? key };
      foldState.activeItemKey = key;
      break;
    }

    case "thinking.updated": {
      // The reasoning stream stays out of the text state machine: thinking and
      // narration interleave freely, and neither should finalize the other.
      const incomingText = (event.text as string) || "";
      const eventPartId = stringValue(event.partId) ?? stringValue(event.itemId);
      const key = `thinking:${eventPartId ?? eventItemKey(event, foldState)}`;
      const previous = foldState.thinkingByKey[key];
      const nextText = event.replace === true ? incomingText : (previous?.text ?? "") + incomingText;
      const turnId = turnIdentity(event, foldState);
      const runId = runIdentity(event, foldState);
      const blockId = previous?.blockId ?? `thinking-${turnId}-${eventPartId ?? key}`;
      if (nextText.trim()) {
        const existingIdx = index[blockId];
        if (existingIdx !== undefined && blocks[existingIdx].kind === "thinking") {
          blocks[existingIdx] = {
            ...blocks[existingIdx],
            parts: [{ id: blockId, text: nextText }],
            partial: true,
            turnId,
            ...(runId ? { runId } : {}),
          } as ThreadBlock;
        } else {
          index[blockId] = blocks.length;
          blocks.push({
            kind: "thinking",
            id: blockId,
            turnId,
            ...(runId ? { runId } : {}),
            ...(eventPartId ? { itemId: eventPartId } : {}),
            parts: [{ id: blockId, text: nextText }],
            partial: true,
            timestamp: new Date().toISOString(),
          } as ThreadBlock);
        }
      }
      foldState.thinkingByKey[key] = { text: nextText, blockId };
      break;
    }

    case "tool.updated": {
      const callId = stringValue(event.callId) ?? "unknown-call";
      const operationId = stringValue(event.operationId);
      const attemptId = stringValue(event.attemptId);
      const blockId = eventHasIdentity(event) && (operationId || attemptId)
        ? `tool-${callId}-${operationId ?? attemptId}`
        : `tool-${callId}`;
      const existingIdx = index[blockId];
      const previous = existingIdx !== undefined && blocks[existingIdx].kind === "tool"
        ? blocks[existingIdx]
        : undefined;
      const rawStatus = stringValue(event.status);
      const status: ToolCallBlock["status"] = (rawStatus === "running" || rawStatus === "done" || rawStatus === "error" || rawStatus === "waiting-approval" || rawStatus === "unknown")
        ? rawStatus
        : "unknown";
      const statusHistory = previous?.statusHistory
        ? [...previous.statusHistory, ...(previous.statusHistory.at(-1) === status ? [] : [status])]
        : [status];
      // Runtimes rarely ship wall-clock fields. Arrival times are the honest
      // fallback: first sight starts the clock, a terminal status ends it.
      const nowIso = new Date().toISOString();
      const block: ThreadBlock = {
        kind: "tool",
        id: blockId,
        callId,
        turnId: stringValue(event.turnId) ?? previous?.turnId ?? foldState.activeTurnId,
        runId: stringValue(event.runId) ?? previous?.runId ?? foldState.activeRunId,
        ...(operationId || previous?.operationId ? { operationId: operationId ?? previous?.operationId } : {}),
        ...(attemptId || previous?.attemptId ? { attemptId: attemptId ?? previous?.attemptId } : {}),
        tool: (event.tool as string) || previous?.tool || "unknown",
        status,
        statusHistory,
        title: (event.title as string | undefined) ?? previous?.title,
        input: (event.input as Record<string, unknown> | undefined) ?? previous?.input,
        output: (event.output as string | undefined) ?? previous?.output,
        details: event.details ?? previous?.details,
        presentation: (event.presentation as ToolCallBlock["presentation"] | undefined) ?? previous?.presentation,
        partialOutput: (event.partialOutput as string | undefined) ?? previous?.partialOutput,
        diff: (event.diff as string | undefined) ?? previous?.diff,
        startedAt: (event.startedAt as string | undefined) ?? previous?.startedAt ?? nowIso,
        endedAt: (event.endedAt as string | undefined) ?? previous?.endedAt
          ?? ((status === "done" || status === "error") ? nowIso : undefined),
        childSessionId: (event.childSessionId as string | undefined) ?? previous?.childSessionId,
        interactionResolved: previous?.interactionResolved,
      };
      if (existingIdx !== undefined) {
        blocks[existingIdx] = block;
      } else {
        // Push to end — the agent block moves to end on each text.updated,
        // so tools naturally appear before the current agent text.
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      if (event.turnId) foldState.activeTurnId = String(event.turnId);
      if (event.runId) foldState.activeRunId = String(event.runId);
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
      if (assistantMessageId) {
        // assistantMessageId identifies the TURN, not the insertion point:
        // the strip lands after the turn's final assistant message even when
        // the id points at an intermediate message of a multi-message turn.
        insertAt = afterAssistantTurnEnd(blocks, assistantMessageId, index);
      }
      if (insertAt < 0) insertAt = afterIdentifiedTurn(blocks, turnId);
      if (insertAt < 0 && Number.isInteger(turnOrdinal) && turnOrdinal > 0) {
        // Prefer explicit turn metadata to the current live anchor: a late
        // artifact must not attach to a newer turn that is already streaming.
        insertAt = afterTurnEnd(blocks, turnOrdinal);
      }
      const liveAnchor = foldState.lastAgentBlockId ? index[foldState.lastAgentBlockId] : undefined;
      if (insertAt < 0 && liveAnchor !== undefined) {
        // Live fold: anchor at the END of the current turn (after its last
        // assistant message), not after an intermediate message of a turn
        // that spans several assistant messages.
        insertAt = liveAnchor + 1;
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
      const completedRunId = runIdentity(event, foldState);
      markTerminalRun(foldState, completedRunId, numberValue(event.seq));
      foldState.activeItemKey = undefined;
      foldState.activeRunId = undefined;
      // A run terminal event settles every item in that run. Legacy idle has
      // no run id, so retain its historical last-block behaviour.
      if (completedRunId) {
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          if (block.kind === "agent" && block.partial && block.runId === completedRunId) {
            blocks[i] = { ...block, partial: false };
          }
        }
      } else {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const block = blocks[i];
          if (block.kind === "agent" && block.partial) {
            blocks[i] = { ...block, partial: false };
            break;
          }
        }
      }
      break;
    }

    case "error": {
      const msg = (event.message as string) || "Unknown error";
      if (event.runFailed === true || event.runId) markTerminalRun(foldState, runIdentity(event, foldState), numberValue(event.seq));
      // If we already have a partial agent block without text, replace it with the error
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.kind === "agent" && lastBlock.partial && !lastBlock.parts?.[0]?.text) {
        blocks[blocks.length - 1] = {
          kind: "status-line",
          id: `error-${foldState.errorSerial++}`,
          turnId: stringValue(event.turnId) ?? foldState.activeTurnId,
          runId: stringValue(event.runId) ?? foldState.activeRunId,
          text: msg,
          level: "error",
        } as ThreadBlock;
        index[blocks[blocks.length - 1].id] = blocks.length - 1;
      } else {
        const errBlock: ThreadBlock = {
          kind: "status-line",
          id: `error-${foldState.errorSerial++}`,
          turnId: stringValue(event.turnId) ?? foldState.activeTurnId,
          runId: stringValue(event.runId) ?? foldState.activeRunId,
          text: msg,
          level: "error",
        };
        index[errBlock.id] = blocks.length;
        blocks.push(errBlock);
      }
      break;
    }
  }

  return withFoldState({ blocks, index, loaded: true }, foldState);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function v2Base(event: PiScienceEvent, payload: Record<string, unknown>): PiScienceEvent {
  return {
    ...payload,
    type: event.type,
    sessionId: event.sessionId,
    streamEpoch: event.streamEpoch,
    eventId: event.eventId,
    seq: event.seq,
    schemaVersion: 2,
    turnId: event.turnId,
    runId: event.runId,
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(event.parentItemId ? { parentItemId: event.parentItemId } : {}),
  };
}

function adaptV2Event(event: PiScienceEvent): PiScienceEvent[] {
  const payload = recordValue(event.payload);
  const base = v2Base(event, payload);
  const phase = payload.phase;
  const role = phase === "commentary" ? "intermediate" : phase === "final_answer" ? "final" : undefined;

  switch (event.type) {
    case "run.started":
      return [{ ...base, type: "agent_start", turnOrdinal: payload.turnOrdinal }];
    case "item.started":
      return [{ ...base, type: "item.started" }];
    case "text.updated": {
      const text = typeof payload.text === "string"
        ? payload.text
        : typeof event.text === "string" ? event.text : "";
      const partId = stringValue(payload.partId) ?? stringValue(event.partId) ?? stringValue(event.itemId);
      const textPhase = stringValue(payload.phase) ?? stringValue(event.phase);
      const textRole = textPhase === "commentary" ? "intermediate" : textPhase === "final_answer" ? "final" : undefined;
      const revision = numberValue(payload.revision) ?? numberValue(event.revision);
      const baseRevision = numberValue(payload.baseRevision) ?? numberValue(event.baseRevision);
      return [{
        ...base,
        type: "text.updated",
        ...(partId ? { partId } : {}),
        text,
        ...(textPhase ? { phase: textPhase } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(payload.replace === true || event.replace === true ? { replace: true } : {}),
        ...(textRole ? { presentationRole: textRole } : {}),
      }];
    }
    case "thinking.updated": {
      // Same wire shape as text.updated; the reasoning stream just targets
      // thinking blocks instead of narration.
      const text = typeof payload.text === "string"
        ? payload.text
        : typeof event.text === "string" ? event.text : "";
      const partId = stringValue(payload.partId) ?? stringValue(event.partId) ?? stringValue(event.itemId);
      const revision = numberValue(payload.revision) ?? numberValue(event.revision);
      const baseRevision = numberValue(payload.baseRevision) ?? numberValue(event.baseRevision);
      return [{
        ...base,
        type: "thinking.updated",
        ...(partId ? { partId } : {}),
        text,
        ...(revision !== undefined ? { revision } : {}),
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(payload.replace === true || event.replace === true ? { replace: true } : {}),
      }];
    }
    case "item.text.delta":
      return [{
        ...base,
        type: "text.updated",
        partId: stringValue(payload.partId) ?? stringValue(event.partId) ?? stringValue(event.itemId),
        text: typeof payload.text === "string" ? payload.text : typeof event.text === "string" ? event.text : "",
        phase: stringValue(payload.phase) ?? phase,
        revision: numberValue(payload.revision) ?? numberValue(event.revision),
        baseRevision: numberValue(payload.baseRevision) ?? numberValue(event.baseRevision),
        ...(role ? { presentationRole: role } : {}),
      }];
    case "item.snapshot": {
      const parts = Array.isArray(payload.parts) ? payload.parts : [];
      const text = parts
        .map((part) => recordValue(part).text)
        .filter((part): part is string => typeof part === "string")
        .join("");
      return [{
        ...base,
        type: "text.updated",
        partId: stringValue(event.itemId) ?? stringValue(recordValue(parts[0]).partId),
        text,
        replace: true,
        phase,
        revision: payload.revision,
        ...(role ? { presentationRole: role } : {}),
      }];
    }
    case "item.completed":
      return [{ ...base, type: "item.completed", revision: payload.revision }];
    case "tool.updated":
      return [{ ...base, type: "tool.updated" }];
    case "run.completed":
      return [{ ...base, type: "session.idle", runCompleted: true }];
    case "run.failed": {
      const issues = Array.isArray(payload.issues) ? payload.issues : [];
      const message = stringValue(payload.message) ?? (issues.length > 0 ? `Run failed (${issues.length} issue${issues.length === 1 ? "" : "s"})` : "Run failed");
      return [{ ...base, type: "error", message, runFailed: true }];
    }
    case "run.cancelled":
      return [{ ...base, type: "session.idle", cancelled: true }];
    case "artifact.updated":
      return [{ ...base, type: "turn.artifacts", artifacts: payload.artifacts ?? payload.items ?? [] }];
    case "plan.updated":
      return [{ ...base, type: "status.updated", status: "plan", message: stringValue(payload.summary) ?? stringValue(payload.message) ?? "Plan updated" }];
    default:
      // A V2 producer may carry a legacy event name while progressively
      // adding the envelope. Preserve it as an extension point.
      return [{ ...base, type: event.type }];
  }
}

function markSeen(foldState: EventFoldState, eventId: string): void {
  if (!foldState.seenEventIds.includes(eventId)) foldState.seenEventIds = [...foldState.seenEventIds, eventId].slice(-4096);
}

function skipV2InOrder(state: Thread, event: PiScienceEvent, foldState: EventFoldState, reconciliationRequired = false): Thread {
  if (reconciliationRequired) foldState.reconciliationRequired = true;
  foldState.lastSequence = Number(event.seq);
  markSeen(foldState, String(event.eventId));
  return withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState);
}

function isV2TextEvent(event: PiScienceEvent): boolean {
  return event.type === "item.text.delta" || event.type === "item.snapshot" || event.type === "text.updated";
}

function staleTextDelta(foldState: EventFoldState, event: PiScienceEvent): boolean {
  if (!isV2TextEvent(event)) return false;
  const payload = recordValue(event.payload);
  const itemId = stringValue(event.itemId);
  const partId = stringValue(payload.partId) ?? stringValue(event.partId) ?? itemId;
  const current = (itemId ? foldState.textByKey[itemId] : undefined)
    ?? (partId ? foldState.textByKey[partId] : undefined);
  if (!current) return false;
  const baseRevision = numberValue(payload.baseRevision) ?? numberValue(event.baseRevision);
  const revision = numberValue(payload.revision) ?? numberValue(event.revision);
  // A future speculative segment means this event is probably the missing
  // lower revision. Allow it through so the canonical text can be rebuilt in
  // revision order instead of treating it as stale.
  if (revision !== undefined && current.segments?.some((segment) => segment.revision > revision)) return false;
  // Likewise, a delta whose base is ahead of the current projection is a
  // useful best-effort future segment while the base event is still missing.
  if (baseRevision !== undefined && baseRevision > current.revision) return false;
  if (baseRevision !== undefined && baseRevision !== current.revision) return true;
  return revision !== undefined && revision <= current.revision;
}

function staleSpeculativeText(foldState: EventFoldState, event: PiScienceEvent): boolean {
  if (!isV2TextEvent(event)) return false;
  const payload = recordValue(event.payload);
  const itemId = stringValue(event.itemId);
  const partId = stringValue(payload.partId) ?? stringValue(event.partId) ?? itemId;
  const current = (itemId ? foldState.textByKey[itemId] : undefined)
    ?? (partId ? foldState.textByKey[partId] : undefined);
  const revision = numberValue(payload.revision) ?? numberValue(event.revision);
  if (!current || revision === undefined) return false;
  return revision <= current.revision
    && !current.segments?.some((segment) => segment.revision > revision);
}

function compareTextSegments(left: TextSegment, right: TextSegment): number {
  return left.revision - right.revision
    || left.sequence - right.sequence
    || left.eventId.localeCompare(right.eventId);
}

function composeTextSegments(segments: TextSegment[]): { text: string; revision: number } {
  let text = "";
  let revision = 0;
  for (const segment of segments) {
    if (segment.replace) {
      if (segment.revision >= revision) {
        text = segment.text;
        revision = segment.revision;
      }
      continue;
    }
    text += segment.text;
    revision = Math.max(revision, segment.revision);
  }
  return { text, revision };
}

function applyV2Text(state: Thread, event: PiScienceEvent, adapted: PiScienceEvent): Thread {
  const initialFoldState = cloneFoldState(state, event);
  const key = eventItemKey(adapted, initialFoldState);
  const previous = initialFoldState.textByKey[key];
  const segments = previous?.segments
    ? [...previous.segments]
    : previous
      ? [{
        eventId: `baseline:${key}`,
        sequence: Number.MIN_SAFE_INTEGER,
        revision: previous.revision,
        text: previous.text,
        replace: true,
      }]
      : [];
  const eventId = String(event.eventId);
  if (!segments.some((segment) => segment.eventId === eventId)) {
    segments.push({
      eventId,
      sequence: Number(event.seq),
      revision: numberValue(adapted.revision) ?? Number(event.seq),
      ...(numberValue(adapted.baseRevision) !== undefined ? { baseRevision: numberValue(adapted.baseRevision) } : {}),
      text: typeof adapted.text === "string" ? adapted.text : "",
      ...(adapted.replace === true ? { replace: true } : {}),
    });
  }
  segments.sort(compareTextSegments);
  const composed = composeTextSegments(segments);
  const rendered = foldLegacyEvent(state, {
    ...adapted,
    text: composed.text,
    replace: true,
    revision: composed.revision,
  });
  const foldState = cloneFoldState(rendered, event);
  const current = foldState.textByKey[key];
  if (current) {
    foldState.textByKey[key] = {
      ...current,
      text: composed.text,
      revision: composed.revision,
      segments,
    };
  }
  return withFoldState({ blocks: rendered.blocks, index: rendered.index, loaded: true }, foldState);
}

function applyV2AdaptedEvent(state: Thread, event: PiScienceEvent, adapted: PiScienceEvent): Thread {
  return isV2TextEvent(event) && adapted.type === "text.updated"
    ? applyV2Text(state, event, adapted)
    : foldLegacyEvent(state, adapted);
}

function applyV2InOrder(state: Thread, event: PiScienceEvent): Thread {
  const initialFoldState = cloneFoldState(state, event);
  const sequence = numberValue(event.seq);
  if (isTerminalRun(initialFoldState, stringValue(event.runId), sequence) && event.type !== "artifact.updated") {
    return skipV2InOrder(state, event, initialFoldState);
  }
  if (staleTextDelta(initialFoldState, event)) {
    return skipV2InOrder(state, event, initialFoldState, true);
  }
  let next = state;
  for (const adapted of adaptV2Event(event)) next = applyV2AdaptedEvent(next, event, adapted);
  const foldState = cloneFoldState(next, event);
  foldState.lastSequence = Number(event.seq);
  markSeen(foldState, String(event.eventId));
  return withFoldState({ blocks: next.blocks, index: next.index, loaded: true }, foldState);
}

function applyV2Speculative(state: Thread, event: PiScienceEvent): Thread {
  const initialFoldState = cloneFoldState(state, event);
  const sequence = numberValue(event.seq);
  const terminal = isTerminalRun(initialFoldState, stringValue(event.runId), sequence);
  const stale = staleTextDelta(initialFoldState, event);
  let next = state;
  // Sequence gaps make the normal base-revision check provisional too: a
  // newer text delta with an old base can still be the only visible evidence
  // of progress until its missing predecessor is replayed. Only suppress a
  // speculative delta when it is unambiguously an older duplicate.
  if ((!terminal || event.type === "artifact.updated") && !(stale && staleSpeculativeText(initialFoldState, event))) {
    for (const adapted of adaptV2Event(event)) next = applyV2AdaptedEvent(next, event, adapted);
  }
  const foldState = cloneFoldState(next, event);
  foldState.reconciliationRequired = true;
  const eventId = String(event.eventId);
  if (!foldState.speculativeEventIds.includes(eventId)) {
    foldState.speculativeEventIds = [...foldState.speculativeEventIds, eventId].slice(-4096);
  }
  markSeen(foldState, eventId);
  // Deliberately leave lastSequence at the contiguous waterline. The pending
  // event is only consumed once every earlier sequence has been observed.
  return withFoldState({ blocks: next.blocks, index: next.index, loaded: true }, foldState);
}

function queueV2Pending(foldState: EventFoldState, event: PiScienceEvent): void {
  const pending = [...foldState.pendingEvents, event]
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .slice(-2000);
  const pendingIds = new Set(pending.map((candidate) => String(candidate.eventId)));
  foldState.pendingEvents = pending;
  foldState.speculativeEventIds = foldState.speculativeEventIds.filter((eventId) => pendingIds.has(eventId));
}

function consumeSpeculativePending(state: Thread, event: PiScienceEvent): Thread {
  const foldState = cloneFoldState(state, event);
  const eventId = String(event.eventId);
  foldState.pendingEvents = foldState.pendingEvents.filter((pending) => pending.eventId !== event.eventId);
  foldState.speculativeEventIds = foldState.speculativeEventIds.filter((pendingId) => pendingId !== eventId);
  foldState.lastSequence = Number(event.seq);
  markSeen(foldState, eventId);
  return withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState);
}

function drainV2Pending(state: Thread): Thread {
  let next = state;
  while (next.foldState?.lastSequence !== undefined) {
    const expected = next.foldState.lastSequence + 1;
    const pending = next.foldState.pendingEvents.find((candidate) => Number(candidate.seq) === expected);
    if (!pending) break;
    if (next.foldState.speculativeEventIds.includes(String(pending.eventId))) {
      next = consumeSpeculativePending(next, pending);
      continue;
    }
    const pendingState = cloneFoldState(next, pending);
    pendingState.pendingEvents = next.foldState.pendingEvents.filter((candidate) => candidate.eventId !== pending.eventId);
    next = applyV2InOrder(withFoldState({ blocks: next.blocks, index: next.index, loaded: true }, pendingState), pending);
  }
  return next;
}

function foldV2Event(state: Thread, event: PiScienceEvent): Thread {
  const foldState = cloneFoldState(state, event);
  const sessionId = stringValue(event.sessionId);
  const streamEpoch = stringValue(event.streamEpoch);
  if (foldState.sessionId && sessionId && foldState.sessionId !== sessionId) return state;
  if (foldState.streamEpoch && streamEpoch && foldState.streamEpoch !== streamEpoch) return state;
  if (sessionId) foldState.sessionId = sessionId;
  if (streamEpoch) foldState.streamEpoch = streamEpoch;

  const eventId = String(event.eventId);
  const sequence = Number(event.seq);
  if (foldState.seenEventIds.includes(eventId)) return state;

  const lastSequence = foldState.lastSequence;
  if (lastSequence !== undefined && sequence <= lastSequence) {
    markSeen(foldState, eventId);
    return withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState);
  }
  if (lastSequence !== undefined && sequence > lastSequence + 1) {
    if (!foldState.pendingEvents.some((pending) => pending.eventId === eventId)) queueV2Pending(foldState, event);
    return applyV2Speculative(withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState), event);
  }

  return drainV2Pending(applyV2InOrder(withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState), event));
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
  return preserveFoldState({ blocks, index, loaded: true }, current);
}

/** Preserve UI-observed tool timing across authoritative rebuilds. History
 *  rows carry no wall-clock fields, so step durations would silently vanish
 *  on every settle-time resync without this carry-over. Only missing fields
 *  are filled: explicit runtime timestamps stay authoritative. */
function carryToolTiming(current: Thread, authoritative: Thread): Thread {
  if (authoritative.blocks.length === 0) return authoritative;
  const timingByCallId = new Map<string, { startedAt?: string; endedAt?: string }>();
  for (const block of current.blocks) {
    if (block.kind !== "tool" || (!block.startedAt && !block.endedAt)) continue;
    timingByCallId.set(block.callId, { startedAt: block.startedAt, endedAt: block.endedAt });
  }
  if (timingByCallId.size === 0) return authoritative;
  let changed = false;
  const blocks = authoritative.blocks.map((block) => {
    if (block.kind !== "tool") return block;
    const timing = timingByCallId.get(block.callId);
    if (!timing || (block.startedAt && block.endedAt)) return block;
    changed = true;
    return { ...block, ...(block.startedAt ? {} : { startedAt: timing.startedAt }), ...(block.endedAt ? {} : { endedAt: timing.endedAt }) };
  });
  if (!changed) return authoritative;
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return preserveFoldState({ blocks, index, loaded: authoritative.loaded }, current);
}

export function replaceHistoryTail(current: Thread, messages: HistoryMessage[]): Thread {
  const authoritative = carryToolTiming(current, threadFromMessages(messages));
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
 *  A prefix of the previous window whose block ids overlap the snapshot is
 *  same-lineage history and stays in place. With `keepLiveExtras` the merge
 *  also preserves live blocks the snapshot does not cover yet (streaming
 *  text, just-finished tools) — used by mid-stream recovery paths. Without
 *  it the settled snapshot is authoritative and live extras are dropped. */
export function mergeHistoryWindow(current: Thread, messages: HistoryMessage[], opts: { keepLiveExtras: boolean }): HistoryWindowMerge {
  const authoritative = carryToolTiming(current, threadFromMessages(messages));
  if (authoritative.blocks.length === 0) return { thread: current, retainedOlderPrefix: true };
  const authoritativeIds = new Set(authoritative.blocks.map((block) => block.id));
  const firstOverlap = current.blocks.findIndex((block) => authoritativeIds.has(block.id));
  if (firstOverlap < 0) {
    // No shared lineage: the snapshot replaces the window wholesale and the
    // old boundary is meaningless — the caller must re-derive it.
    const replacement = opts.keepLiveExtras ? mergeHistoryWithLive(authoritative, current) : preserveFoldState({ blocks: authoritative.blocks, index: authoritative.index, loaded: authoritative.loaded }, current);
    return { thread: replacement, retainedOlderPrefix: false };
  }
  const tail = opts.keepLiveExtras
    ? mergeHistoryWithLive(authoritative, { blocks: current.blocks.slice(firstOverlap), index: {}, loaded: true })
    : authoritative;
  const blocks = [...current.blocks.slice(0, firstOverlap), ...tail.blocks];
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { thread: preserveFoldState({ blocks, index, loaded: true }, current), retainedOlderPrefix: true };
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
  return preserveFoldState({ blocks, index, loaded: true }, live.foldState ? live : history);
}

export function convertHistoryToBlocks(messages: HistoryMessage[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  const toolNames = new Map<string, string>();
  const toolPresentations = new Map<string, ToolCallBlock["presentation"]>();
  // The assistant message that carries a toolCall is the call's start wall
  // clock; the toolResult message is its end. Together they reconstruct the
  // per-step and whole-process durations that live events provide.
  const toolCallStarts = new Map<string, string>();

  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      const images = msg.content.flatMap((content: any) => {
        if (content.type !== "image" && content.type !== "input_image") return [];
        const source = content.source && typeof content.source === "object" ? content.source : content;
        const data = typeof source.data === "string" ? source.data : "";
        const mimeType = typeof source.media_type === "string" ? source.media_type : typeof content.mimeType === "string" ? content.mimeType : typeof content.mime === "string" ? content.mime : "image/png";
        return data ? [{ data, mimeType }] : [];
      });
      if (text || images.length > 0) blocks.push({
        kind: "user",
        id: msg.id,
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(msg.turnId ? { turnId: msg.turnId } : {}),
        ...(msg.runId ? { runId: msg.runId } : {}),
        ...(msg.itemId ? { itemId: msg.itemId } : {}),
        timestamp: msg.timestamp,
      });
    } else if (role === "assistant") {
      for (const content of msg.content) {
        if (content.type !== "toolCall") continue;
        const callId = String(content.id || "");
        if (callId) {
          toolNames.set(callId, String(content.name || content.tool || "unknown"));
          if (content.presentation && typeof content.presentation === "object") toolPresentations.set(callId, content.presentation as ToolCallBlock["presentation"]);
          if (msg.timestamp) toolCallStarts.set(callId, msg.timestamp);
        }
      }
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      // Reasoning precedes the answer in the content array; rebuild it as its
      // own block so restored turns show the same thinking rows as live ones.
      const thinking = msg.content
        .filter((c: any) => c.type === "thinking")
        .map((c: any) => (typeof c.thinking === "string" ? c.thinking : ""))
        .filter(Boolean)
        .join("\n");
      if (thinking) {
        blocks.push({
          kind: "thinking",
          id: `${msg.id}-thinking`,
          ...(msg.turnId ? { turnId: msg.turnId } : {}),
          ...(msg.runId ? { runId: msg.runId } : {}),
          ...(msg.itemId ? { itemId: msg.itemId } : {}),
          parts: [{ id: `${msg.id}-thinking-0`, text: thinking }],
          timestamp: msg.timestamp,
        });
      }
      if (text) {
        // Collapse models that repeat their previous narration in every
        // message: the union stays, the verbatim repeat goes.
        let subsumed: NarrationSubsumption = "keep";
        if (msg.presentationRole !== "final") {
          for (let i = blocks.length - 1; i >= 0; i -= 1) {
            const block = blocks[i];
            if (block.kind === "user") break;
            if (block.kind !== "agent") continue;
            if (block.turnId && msg.turnId && block.turnId !== msg.turnId) continue;
            if (block.turnId !== msg.turnId) break;
            subsumed = narrationSubsumption(block, text);
            if (subsumed === "replaced") blocks.splice(i, 1);
            break;
          }
        }
        if (subsumed !== "subsumed") {
          blocks.push({
            kind: "agent",
            id: msg.id,
            parts: [{ id: msg.itemId ?? msg.id, text }],
            ...(msg.turnId ? { turnId: msg.turnId } : {}),
            ...(msg.runId ? { runId: msg.runId } : {}),
            ...(msg.itemId ? { itemId: msg.itemId } : {}),
            ...(msg.parentItemId ? { parentItemId: msg.parentItemId } : {}),
            ...(msg.presentationRole ? { presentationRole: msg.presentationRole } : {}),
            ...(msg.classificationSource ? { classificationSource: msg.classificationSource } : {}),
            ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
            ...(msg.sequence !== undefined ? { sequence: msg.sequence } : {}),
            timestamp: msg.timestamp,
          });
        }
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
        ...(msg.turnId ? { turnId: msg.turnId } : {}),
        ...(msg.runId ? { runId: msg.runId } : {}),
        ...(msg.itemId ? { itemId: msg.itemId } : {}),
        tool: msg.toolName || toolNames.get(callId) || "unknown",
        status: msg.isError ? "error" as const : "done" as const,
        output: text || undefined,
        details: msg.details,
        presentation: msg.presentation ?? toolPresentations.get(callId),
        ...(toolCallStarts.get(callId) ? { startedAt: toolCallStarts.get(callId) } : {}),
        ...(msg.timestamp ? { endedAt: msg.timestamp } : {}),
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

/** Position after the last block carrying a stable turn identity. This is the
 * strongest live artifact anchor when an older turn publishes after a newer
 * turn has already started. */
function afterIdentifiedTurn(blocks: ThreadBlock[], turnId: string): number {
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
 *  identifies the correct turn). If a paged history has no user boundary,
 *  anchor after the latest timestamped agent block at or before `endedAt`.
 *  Returns -1 when no matching agent block is available. */
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
  let lastAgent = -1;
  if (lastUser >= 0) {
    for (let i = lastUser + 1; i < blocks.length; i += 1) {
      if (blocks[i].kind === "user") break;
      if (blocks[i].kind === "agent") lastAgent = i;
    }
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
function afterAssistantTurnEnd(blocks: ThreadBlock[], assistantMessageId: string, index: Record<string, number>): number {
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
    if (insertAt < 0 && !windowComplete) {
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
  return preserveFoldState({ blocks, index, loaded: thread.loaded }, thread);
}
