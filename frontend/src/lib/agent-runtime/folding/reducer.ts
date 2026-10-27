/** Resolve content ownership before choosing the versioned or product projection. */
import type { PiScienceEvent } from "../../client/pi-science-client";
import type { Thread } from "./types";
import { activateContentOwner, contentOwnerOf } from "./ownership";
import { foldProductEvent } from "./product-event";
import { foldVersionedEvent } from "./versioned-event";
import { isVersionedEvent } from "./identity";

export function foldEvent(state: Thread, event: PiScienceEvent): Thread {
  // Content keys are raw part/item ids that a later run may reuse verbatim.
  // Fold each event against its own run's (else turn's) bookkeeping so a reused
  // id cannot inherit another run's revision waterline, replayed segments,
  // suppression or materialized block.
  const scoped = activateContentOwner(state, contentOwnerOf(event, state.foldState));
  if (isVersionedEvent(event)) return foldVersionedEvent(scoped, event);
  return foldProductEvent(scoped, event);
}
