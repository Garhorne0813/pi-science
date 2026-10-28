import type { ThreadBlock } from "../../../types/thread";
import type { PiScienceEvent } from "../../client/pi-science-client";

export interface Thread {
  blocks: ThreadBlock[];
  /** Map from block id to index in blocks array */
  index: Record<string, number>;
  loaded: boolean;
  /** Internal, serializable reducer state. Omitted from an empty thread so
   * existing callers can continue to use `emptyThread()` as a stable value. */
  foldState?: EventFoldState;
}

export interface TextSegment {
  eventId: string;
  sequence: number;
  revision: number;
  baseRevision?: number;
  text: string;
  replace?: boolean;
}

export interface TextFoldState {
  text: string;
  revision: number;
  /** Logical target block id. A repeated narration may be intentionally
   * suppressed from Thread.blocks while retaining this stable identity. */
  blockId: string;
  partId: string;
  /** True while the logical text item is omitted from Thread.blocks because
   * its narration is already represented by a neighboring same-turn block. */
  suppressed?: boolean;
  /** Versioned deltas are kept as a small replayable log while a sequence gap is
   *  open. This lets a late lower revision be inserted before an already
   *  visible speculative delta without appending the text a second time. */
  segments?: TextSegment[];
}

/** One ownership boundary's content bookkeeping. `textByKey`/`thinkingByKey`
 *  of the fold state are the ACTIVE owner's view; the others wait here. */
export interface ContentState {
  textByKey: Record<string, TextFoldState>;
  thinkingByKey: Record<string, TextFoldState>;
}

export interface EventFoldState {
  sessionId?: string;
  streamEpoch?: string;
  /** Epoch that first forced authoritative recovery. While recovery is in
   * flight, older epochs are ignored instead of being folded into the stale
   * projection. */
  recoveryEpoch?: string;
  activeTurnId?: string;
  activeRunId?: string;
  activeItemKey?: string;
  lastAgentBlockId?: string;
  turnOrdinal: number;
  anonymousSerial: number;
  errorSerial: number;
  textByKey: Record<string, TextFoldState>;
  thinkingByKey: Record<string, TextFoldState>;
  /** Content keys are raw part/item ids, and a later run may legitimately
   *  reuse the exact same id. Revision waterlines, replayed segments and
   *  suppression therefore belong to an ownership boundary (run, else turn),
   *  not to the id alone. */
  contentStateByOwner?: Record<string, ContentState>;
  /** Boundary whose view `textByKey`/`thinkingByKey` currently hold. */
  contentStateOwner?: string;
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

/** One copy-on-write event transaction shared by the event-family reducers. */
export interface FoldDraft {
  foldState: EventFoldState;
  blocks: ThreadBlock[];
  index: Record<string, number>;
}
