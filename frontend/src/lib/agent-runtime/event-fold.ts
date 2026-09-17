import type { PiScienceEvent } from "../client/pi-science-client";
import { foldEvent as foldCoreEvent } from "./event-fold-core";
import type { EventFoldState, Thread } from "./event-fold-core";

export * from "./event-fold-core";

type ContentState = {
  textByKey: EventFoldState["textByKey"];
  thinkingByKey: EventFoldState["thinkingByKey"];
};

type OwnedFoldState = EventFoldState & {
  /**
   * Content-part ids are producer-local identities and can be reused by a
   * later run. Keep each owner's revision/materialization state isolated while
   * exposing only the active owner's raw-key maps to the core reducer. Raw
   * itemId/partId values therefore remain unchanged in presentation blocks.
   */
  contentStateByOwner?: Record<string, ContentState>;
  /** Owner of the public textByKey/thinkingByKey view. Kept explicitly because
   * session.idle clears activeRunId before the next run arrives. */
  contentStateOwner?: string;
};

const MAX_CONTENT_STATE_OWNERS = 128;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ownerKey(event: PiScienceEvent, state?: EventFoldState): string | undefined {
  const runId = stringValue(event.runId) ?? state?.activeRunId;
  if (runId) return `run:${runId}`;
  const turnId = stringValue(event.turnId) ?? state?.activeTurnId;
  return turnId ? `turn:${turnId}` : undefined;
}

function blockMatchesOwner(thread: Thread, blockId: string, owner: string): boolean {
  const position = thread.index[blockId];
  if (position === undefined) return true; // suppressed narration intentionally has no materialized block
  const block = thread.blocks[position];
  if (!block || !("turnId" in block)) return true;
  if (owner.startsWith("run:")) {
    const runId = owner.slice(4);
    if ("runId" in block && block.runId) return block.runId === runId;
    return true;
  }
  const turnId = owner.slice(5);
  return !block.turnId || block.turnId === turnId;
}

function ownedEntries<T extends { blockId: string }>(thread: Thread, owner: string, entries: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => blockMatchesOwner(thread, value.blockId, owner)));
}

function cloneContentState(thread: Thread, owner: string, content: ContentState | undefined): ContentState {
  if (!content) return { textByKey: {}, thinkingByKey: {} };
  return {
    textByKey: ownedEntries(thread, owner, content.textByKey),
    thinkingByKey: ownedEntries(thread, owner, content.thinkingByKey),
  };
}

function boundedOwners(states: Record<string, ContentState>): Record<string, ContentState> {
  const entries = Object.entries(states);
  return entries.length <= MAX_CONTENT_STATE_OWNERS
    ? states
    : Object.fromEntries(entries.slice(-MAX_CONTENT_STATE_OWNERS));
}

function stripOwnerCache(state: OwnedFoldState): EventFoldState {
  const { contentStateByOwner: _states, contentStateOwner: _owner, ...rest } = state;
  return rest;
}

/**
 * Scope the core fold's content/revision maps to the event owner.
 *
 * The core intentionally keeps raw part keys because they are also used to
 * build stable UI ids. This adapter changes only reducer bookkeeping: every
 * run (or turn when no run id exists) gets an independent raw-key map. That
 * prevents an exact `anonymous-N[:part]` reuse from inheriting revisions or a
 * previous blockId, which is what could re-attribute an earlier final answer
 * to a later turn.
 */
export function foldEvent(state: Thread, event: PiScienceEvent): Thread {
  const previous = state.foldState as OwnedFoldState | undefined;
  if (!previous) return finalizeOwnedState(foldCoreEvent(state, event), event, undefined, {});

  const epochChanged = Boolean(previous.streamEpoch && event.streamEpoch && previous.streamEpoch !== event.streamEpoch);
  if (epochChanged) {
    const prepared = { ...state, foldState: stripOwnerCache(previous) };
    return foldCoreEvent(prepared, event);
  }

  const owner = ownerKey(event, previous);
  if (!owner) return foldCoreEvent(state, event);

  const byOwner: Record<string, ContentState> = { ...(previous.contentStateByOwner ?? {}) };
  if (previous.contentStateOwner) {
    byOwner[previous.contentStateOwner] = {
      textByKey: previous.textByKey,
      thinkingByKey: previous.thinkingByKey,
    };
  }

  const selected = cloneContentState(state, owner, byOwner[owner]);
  const preparedState: OwnedFoldState = {
    ...previous,
    textByKey: selected.textByKey,
    thinkingByKey: selected.thinkingByKey,
    contentStateByOwner: boundedOwners(byOwner),
    contentStateOwner: owner,
  };
  const folded = foldCoreEvent({ ...state, foldState: preparedState }, event);
  return finalizeOwnedState(folded, event, owner, byOwner);
}

function finalizeOwnedState(
  thread: Thread,
  event: PiScienceEvent,
  owner: string | undefined,
  previousOwners: Record<string, ContentState>,
): Thread {
  if (!thread.foldState) return thread;
  const foldState = thread.foldState as OwnedFoldState;
  const resolvedOwner = owner ?? ownerKey(event, foldState);
  if (!resolvedOwner) return thread;
  const byOwner = boundedOwners({
    ...previousOwners,
    ...(foldState.contentStateByOwner ?? {}),
    [resolvedOwner]: {
      textByKey: foldState.textByKey,
      thinkingByKey: foldState.thinkingByKey,
    },
  });
  const nextFoldState: OwnedFoldState = {
    ...foldState,
    contentStateByOwner: byOwner,
    contentStateOwner: resolvedOwner,
  };
  return { ...thread, foldState: nextFoldState };
}
