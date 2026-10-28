/** Sequence waterlines, speculative replay and revision-aware content assembly. */
import type { PiScienceEvent } from "../../client/pi-science-client";
import type { EventFoldState, TextSegment, Thread } from "./types";
import { activateContentOwner, contentOwnerOf } from "./ownership";
import { cloneFoldState, withFoldState } from "./state";
import { eventTextKey, isTerminalRun, numberValue, recordValue, stringValue } from "./identity";
import { foldProductEvent } from "./product-event";

function projectEventBody(event: PiScienceEvent): PiScienceEvent[] {
  const payload = recordValue(event.payload);
  const body = { ...event, ...payload, type: event.type };
  if (event.type === "message.snapshot") {
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    return [{ ...body, type: "message.delta", replace: true,
      partId: stringValue(payload.partId) ?? stringValue(event.itemId),
      text: parts.map((part) => recordValue(part).text).filter((part) => typeof part === "string").join("") }];
  }
  return [body];
}

function markSeen(foldState: EventFoldState, eventId: string): void {
  if (!foldState.seenEventIds.includes(eventId)) foldState.seenEventIds = [...foldState.seenEventIds, eventId].slice(-4096);
}

function skipVersionedInOrder(state: Thread, event: PiScienceEvent, foldState: EventFoldState, reconciliationRequired = false): Thread {
  if (reconciliationRequired) foldState.reconciliationRequired = true;
  foldState.lastSequence = Number(event.seq);
  markSeen(foldState, String(event.eventId));
  return withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState);
}

function isVersionedContentEvent(event: PiScienceEvent): boolean {
  return event.type === "message.delta" || event.type === "message.snapshot" || event.type === "message.reasoning.delta";
}

function isContinuationChunk(event: PiScienceEvent): boolean {
  if (!isVersionedContentEvent(event)) return false;
  const payload = recordValue(event.payload);
  const chunkIndex = numberValue(payload.chunkIndex) ?? numberValue(event.chunkIndex);
  const chunkCount = numberValue(payload.chunkCount) ?? numberValue(event.chunkCount);
  return chunkIndex !== undefined && chunkIndex > 0 && chunkCount !== undefined && chunkIndex < chunkCount;
}

function staleContentDelta(foldState: EventFoldState, event: PiScienceEvent): boolean {
  if (!isVersionedContentEvent(event)) return false;
  const payload = recordValue(event.payload);
  const itemId = stringValue(event.itemId);
  const partId = stringValue(payload.partId) ?? stringValue(event.partId) ?? itemId;
  const current = partId ? (event.type === "message.reasoning.delta" ? foldState.thinkingByKey[`thinking:${partId}`] : foldState.textByKey[partId]) : undefined;
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
  // A server-side oversized replacement is split into ordered wire chunks.
  // Continuation chunks intentionally retain the logical revision/base pair;
  // their event IDs and sequence numbers provide the ordering, so they must
  // not be mistaken for stale duplicate deltas.
  if (isContinuationChunk(event) && revision === current.revision) return false;
  if (baseRevision !== undefined && baseRevision !== current.revision) return true;
  return revision !== undefined && revision <= current.revision;
}

function staleSpeculativeContent(foldState: EventFoldState, event: PiScienceEvent): boolean {
  if (!isVersionedContentEvent(event)) return false;
  const payload = recordValue(event.payload);
  const itemId = stringValue(event.itemId);
  const partId = stringValue(payload.partId) ?? stringValue(event.partId) ?? itemId;
  const current = partId ? (event.type === "message.reasoning.delta" ? foldState.thinkingByKey[`thinking:${partId}`] : foldState.textByKey[partId]) : undefined;
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

function applyVersionedContent(state: Thread, event: PiScienceEvent, adapted: PiScienceEvent): Thread {
  const initialFoldState = cloneFoldState(state, event);
  const thinking = adapted.type === "message.reasoning.delta";
  const contentKey = eventTextKey(adapted, initialFoldState);
  const key = thinking ? `thinking:${contentKey}` : contentKey;
  const previous = thinking ? initialFoldState.thinkingByKey[key] : initialFoldState.textByKey[key];
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
  const rendered = foldProductEvent(state, {
    ...adapted,
    text: composed.text,
    replace: true,
    revision: composed.revision,
  });
  const foldState = cloneFoldState(rendered, event);
  const current = thinking ? foldState.thinkingByKey[key] : foldState.textByKey[key];
  if (current) {
    const next = {
      ...current,
      text: composed.text,
      revision: composed.revision,
      segments,
    };
    if (thinking) foldState.thinkingByKey[key] = next;
    else foldState.textByKey[key] = next;
  }
  return withFoldState({ blocks: rendered.blocks, index: rendered.index, loaded: true }, foldState);
}

function applyVersionedAdaptedEvent(state: Thread, event: PiScienceEvent, adapted: PiScienceEvent): Thread {
  return isVersionedContentEvent(event) && (adapted.type === "message.delta" || adapted.type === "message.reasoning.delta")
    ? applyVersionedContent(state, event, adapted)
    : foldProductEvent(state, adapted);
}

function applyVersionedInOrder(state: Thread, event: PiScienceEvent): Thread {
  const initialFoldState = cloneFoldState(state, event);
  const sequence = numberValue(event.seq);
  if (isTerminalRun(initialFoldState, stringValue(event.runId), sequence) && event.type !== "artifact.updated") {
    return skipVersionedInOrder(state, event, initialFoldState);
  }
  if (staleContentDelta(initialFoldState, event)) {
    return skipVersionedInOrder(state, event, initialFoldState, true);
  }
  let next = state;
  for (const adapted of projectEventBody(event)) next = applyVersionedAdaptedEvent(next, event, adapted);
  const foldState = cloneFoldState(next, event);
  foldState.lastSequence = Number(event.seq);
  markSeen(foldState, String(event.eventId));
  return withFoldState({ blocks: next.blocks, index: next.index, loaded: true }, foldState);
}

function applyVersionedSpeculative(state: Thread, event: PiScienceEvent): Thread {
  const initialFoldState = cloneFoldState(state, event);
  const sequence = numberValue(event.seq);
  const terminal = isTerminalRun(initialFoldState, stringValue(event.runId), sequence);
  const stale = staleContentDelta(initialFoldState, event);
  let next = state;
  // Sequence gaps make the normal base-revision check provisional too: a
  // newer text delta with an old base can still be the only visible evidence
  // of progress until its missing predecessor is replayed. Only suppress a
  // speculative delta when it is unambiguously an older duplicate.
  if ((!terminal || event.type === "artifact.updated") && !(stale && staleSpeculativeContent(initialFoldState, event))) {
    for (const adapted of projectEventBody(event)) next = applyVersionedAdaptedEvent(next, event, adapted);
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

function queueVersionedPending(foldState: EventFoldState, event: PiScienceEvent): void {
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

function drainVersionedPending(state: Thread): Thread {
  let next = state;
  while (next.foldState?.lastSequence !== undefined) {
    const expected = next.foldState.lastSequence + 1;
    const pending = next.foldState.pendingEvents.find((candidate) => Number(candidate.seq) === expected);
    if (!pending) break;
    if (next.foldState.speculativeEventIds.includes(String(pending.eventId))) {
      next = consumeSpeculativePending(next, pending);
      continue;
    }
    // A replayed event can belong to an earlier run than the one that queued
    // it, so it is folded against its own boundary. The boundary it leaves
    // active is re-resolved by the next event.
    const owned = activateContentOwner(next, contentOwnerOf(pending, next.foldState));
    const pendingState = cloneFoldState(owned, pending);
    pendingState.pendingEvents = (owned.foldState?.pendingEvents ?? []).filter((candidate) => candidate.eventId !== pending.eventId);
    next = applyVersionedInOrder(withFoldState({ blocks: owned.blocks, index: owned.index, loaded: true }, pendingState), pending);
  }
  return next;
}

export function foldVersionedEvent(state: Thread, event: PiScienceEvent): Thread {
  const foldState = cloneFoldState(state, event);
  const sessionId = stringValue(event.sessionId);
  const streamEpoch = stringValue(event.streamEpoch);
  if (foldState.sessionId && sessionId && foldState.sessionId !== sessionId) return state;
  if (foldState.streamEpoch && streamEpoch && foldState.streamEpoch !== streamEpoch) {
    // An epoch change is a recovery boundary, not an ordinary stale event.
    // Keep the visible blocks until REST supplies the authoritative snapshot,
    // but clear every identity/materialization that could leak across it.
    if (foldState.recoveryEpoch && foldState.recoveryEpoch !== streamEpoch) return state;
    foldState.recoveryEpoch = streamEpoch;
    foldState.streamEpoch = streamEpoch;
    foldState.activeTurnId = undefined;
    foldState.activeRunId = undefined;
    foldState.activeItemKey = undefined;
    foldState.lastAgentBlockId = undefined;
    foldState.textByKey = {};
    foldState.thinkingByKey = {};
    // Owner-scoped bookkeeping must not survive the boundary either: keeping
    // it would trade cross-run leakage for cross-epoch leakage.
    foldState.contentStateByOwner = undefined;
    foldState.contentStateOwner = undefined;
    foldState.seenEventIds = [];
    foldState.speculativeEventIds = [];
    foldState.terminalRunIds = [];
    foldState.terminalRunSequences = {};
    foldState.lastSequence = undefined;
    foldState.reconciliationRequired = true;
    foldState.pendingEvents = foldState.pendingEvents.some((pending) => pending.eventId === event.eventId)
      ? foldState.pendingEvents
      : [event];
    return withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState);
  }
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
    if (!foldState.pendingEvents.some((pending) => pending.eventId === eventId)) queueVersionedPending(foldState, event);
    return applyVersionedSpeculative(withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState), event);
  }

  return drainVersionedPending(applyVersionedInOrder(withFoldState({ blocks: state.blocks, index: state.index, loaded: true }, foldState), event));
}
