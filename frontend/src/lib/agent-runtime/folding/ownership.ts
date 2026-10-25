/** Run/turn-scoped reducer bookkeeping prevents reused item IDs from crossing owners. */
import type { ThreadBlock } from "../../../types/thread";
import type { PiScienceEvent } from "../../client/pi-science-client";
import type { ContentState, EventFoldState, TextFoldState, Thread } from "./types";
import { cloneFoldState } from "./state";
import { stringValue } from "./identity";

/** Owned content scopes are retained for the live session only; older runs are
 *  kept for delayed/gap reconciliation but must not accumulate forever. */
const MAX_CONTENT_STATE_OWNERS = 128;

/** The ownership boundary a content event belongs to: its own run id, else its
 *  own turn id, else the run/turn the fold is currently inside. The fallbacks
 *  mirror the identities the reducer stamps on blocks (`runIdentity` /
 *  `turnIdentity`), so a scope and the blocks materialized inside it always
 *  agree — resolving "no identity" to a nameless scope instead would make the
 *  next envelope-less record (session stats) look like a different owner and
 *  rebuild the row it belongs to. */
export function contentOwnerOf(event: PiScienceEvent, state?: EventFoldState): string {
  const runId = stringValue(event.runId) ?? state?.activeRunId;
  if (runId) return `run:${runId}`;
  // A brand-new thread has no turn yet, and the fold about to run will name
  // this event's turn `turn-1`: resolve the same name here.
  const turnOrdinal = state?.turnOrdinal ?? 0;
  const turnId = stringValue(event.turnId) ?? state?.activeTurnId ?? `turn-${Math.max(1, turnOrdinal)}`;
  return `turn:${turnId}`;
}

function blockRunId(block: ThreadBlock): string | undefined {
  return "runId" in block ? stringValue(block.runId) : undefined;
}

function blockTurnId(block: ThreadBlock): string | undefined {
  return "turnId" in block ? stringValue(block.turnId) : undefined;
}

/** The boundary a materialized block answers to, in `contentOwnerOf`'s
 *  vocabulary. A block without identity is unowned and never contradicts one. */
function blockOwnerOf(block: ThreadBlock): string | undefined {
  const runId = blockRunId(block);
  if (runId) return `run:${runId}`;
  const turnId = blockTurnId(block);
  return turnId ? `turn:${turnId}` : undefined;
}

/** Whether an existing block may receive content from this owner. Only the
 *  same owner — or a block carrying no identity at all — may be extended: a
 *  part id reused by a later run gets its own block, so the earlier run's text
 *  is neither extended nor overwritten. */
function blockAcceptsOwner(block: ThreadBlock, owner: string | undefined): boolean {
  const blockOwner = blockOwnerOf(block);
  if (!blockOwner || !owner) return true;
  return blockOwner === owner;
}

/** Give the owner its own materialized block when the id it would target was
 *  materialized by another run or turn. The allocated id stays readable (never
 *  namespaced with the owner), so presentation identity is unchanged. */
export function ownerScopedBlockId(
  blocks: ThreadBlock[],
  index: Record<string, number>,
  blockId: string,
  owner: string | undefined,
): string {
  const position = index[blockId];
  if (position === undefined) return blockId;
  const existing = blocks[position];
  if (!existing || blockAcceptsOwner(existing, owner)) return blockId;
  let candidate = `${blockId}-r2`;
  let serial = 2;
  while (index[candidate] !== undefined) candidate = `${blockId}-r${++serial}`;
  return candidate;
}

/** Cached bookkeeping can outlive the block it materialized. Restore only the
 *  entries whose block still answers to this boundary.
 *
 *  Only a block carrying the SAME kind of id as the boundary proves a foreign
 *  owner; a run-scoped entry holding a merely turn-identified block was
 *  materialized before the run id was known, and dropping it would discard the
 *  revision and segment log of content that is still streaming. */
function ownedContentEntries(state: Thread, owner: string, entries: Record<string, TextFoldState>): Record<string, TextFoldState> {
  const runScoped = owner.startsWith("run:");
  const ownerId = owner.slice(runScoped ? "run:".length : "turn:".length);
  const scoped: Record<string, TextFoldState> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const position = state.index[entry.blockId];
    const block = position === undefined ? undefined : state.blocks[position];
    const blockId = block ? (runScoped ? blockRunId(block) : blockTurnId(block)) : undefined;
    if (blockId !== undefined && blockId !== ownerId) continue;
    scoped[key] = entry;
  }
  return scoped;
}

/** Bounded owner cache. Insertion order is the recency order: an owner that is
 *  activated again keeps its original slot, so the oldest boundary is evicted
 *  first. */
function boundedContentOwners(states: Record<string, ContentState>): Record<string, ContentState> {
  const entries = Object.entries(states);
  if (entries.length <= MAX_CONTENT_STATE_OWNERS) return states;
  return Object.fromEntries(entries.slice(-MAX_CONTENT_STATE_OWNERS));
}

/** Swap the fold's content view to `owner`'s bookkeeping, stashing the view
 *  that was active. Everything else in the fold state (sequence waterline,
 *  pending events, terminal runs, block materialization) stays shared: only
 *  the raw-key content maps are owner-scoped. */
export function activateContentOwner(state: Thread, ownerKey: string): Thread {
  if (state.foldState?.contentStateOwner === ownerKey) return state;
  const next = cloneFoldState(state);
  const byOwner = { ...(next.contentStateByOwner ?? {}) };
  if (next.contentStateOwner) {
    // The working maps are the newest copy of the outgoing boundary's view.
    byOwner[next.contentStateOwner] = { textByKey: next.textByKey, thinkingByKey: next.thinkingByKey };
  }
  const restored = byOwner[ownerKey];
  next.textByKey = restored ? ownedContentEntries(state, ownerKey, restored.textByKey) : {};
  next.thinkingByKey = restored ? ownedContentEntries(state, ownerKey, restored.thinkingByKey) : {};
  next.contentStateOwner = ownerKey;
  byOwner[ownerKey] = { textByKey: next.textByKey, thinkingByKey: next.thinkingByKey };
  next.contentStateByOwner = boundedContentOwners(byOwner);
  return { ...state, foldState: next };
}
