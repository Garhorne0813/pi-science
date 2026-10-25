import type { PiScienceEvent } from "../../client/pi-science-client";
import type { EventFoldState, Thread } from "./types";

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

export function cloneFoldState(state: Thread, event?: PiScienceEvent): EventFoldState {
  const current = state.foldState ?? createFoldState(event);
  return {
    ...current,
    textByKey: Object.fromEntries(Object.entries(current.textByKey).map(([key, value]) => [key, {
      ...value,
      ...(value.segments ? { segments: value.segments.map((segment) => ({ ...segment })) } : {}),
    }])),
    thinkingByKey: Object.fromEntries(Object.entries(current.thinkingByKey ?? {}).map(([key, value]) => [key, {
      ...value,
      ...(value.segments ? { segments: value.segments.map((segment) => ({ ...segment })) } : {}),
    }])),
    seenEventIds: [...current.seenEventIds],
    pendingEvents: [...current.pendingEvents],
    speculativeEventIds: [...(current.speculativeEventIds ?? [])],
    terminalRunIds: [...current.terminalRunIds],
    terminalRunSequences: { ...(current.terminalRunSequences ?? {}) },
    contentStateByOwner: { ...(current.contentStateByOwner ?? {}) },
  };
}

export function withFoldState(thread: Omit<Thread, "foldState">, foldState: EventFoldState): Thread {
  return { ...thread, foldState };
}

export function preserveFoldState(thread: Omit<Thread, "foldState">, source: Thread): Thread {
  return source.foldState ? { ...thread, foldState: source.foldState } : thread;
}

/** Drop all reducer bookkeeping after an authoritative snapshot has been
 * applied. The blocks remain the server projection; no client-side dedupe,
 * speculative delta, suppression, or terminal identity may cross the rebase. */
export function resetThreadProjection(thread: Thread): Thread {
  const blocks = [...thread.blocks];
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: thread.loaded };
}
