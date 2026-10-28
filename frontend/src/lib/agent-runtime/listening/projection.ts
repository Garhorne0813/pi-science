/** Publish the event fold and withhold applied cursors while a projection gap is unresolved. */
import type { PiScienceEvent } from "../../client/pi-science-client";
import { foldEvent } from "../folding/reducer";
import { applyTransportEvent } from "../transport-status";
import { reconcileAfterGap } from "../recovery/gap";
import { runtimeStore } from "../store-access";

export function applyEventProjection(event: PiScienceEvent): boolean {
  // Every record that reaches this point has consumed a stream position, and
  // the fold's sequence waterline is what tells a lost event apart from one
  // that simply produced no conversation block. So an interaction record —
  // questionnaire, permission, question, malformed interaction — is folded
  // even when its UI state could not be built. Only records carrying no
  // position at all (`connection.*`, `stream.gap`) and the missing-session
  // retry above — which re-attaches a stream whose records are not durable
  // yet — may skip this.
  const current = runtimeStore.getState();
  const newThread = foldEvent(current.thread, event);
  if (newThread.blocks !== current.thread.blocks || newThread.foldState !== current.thread.foldState) {
    runtimeStore.setState({ thread: newThread });
  }
  if (newThread.foldState?.reconciliationRequired && event.type !== "stream.gap") {
    const recoveryState = runtimeStore.getState();
    const recoverySessionId = recoveryState.activeSessionId ?? (event.sessionId ? String(event.sessionId) : null);
    if (recoverySessionId) {
      // A sequence/epoch discontinuity inside a live session is the same
      // class of repair as a server gap: rebase the projection without
      // pretending the backend went away.
      applyTransportEvent({
        transport: "recovering",
        reason: "stream_gap",
        foreground: "connecting",
        keepReady: true,
        sessionId: recoverySessionId,
        // The event identity is what makes a recurrence attributable: a
        // sequence hole, a stale delta and an epoch change all land here.
        detail: `projection discontinuity (${event.type} seq=${String(event.seq ?? "-")} part=${String(event.partId ?? "-")} rev=${String(event.revision ?? "-")} base=${String(event.baseRevision ?? "-")})`,
      });
      void reconcileAfterGap(recoverySessionId, recoveryState.cwd, { resetTransport: true, reconnectTransport: true });
    }
    // Do not advance the applied SSE cursor while the authoritative rebase
    // is in flight. The single-flight recovery owns the next reconnect.
    return false;
  }
  if (
    event.schemaVersion === 3
    && newThread.foldState?.pendingEvents.some((pending) => pending.eventId === event.eventId)
  ) return false;
  return true;
}
