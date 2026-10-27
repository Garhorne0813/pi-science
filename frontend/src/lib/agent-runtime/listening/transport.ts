/** Handle transport/replacement boundaries before projection consumes stream positions. */
import type { PiScienceClient, PiScienceEvent } from "../../client/pi-science-client";
import { appendRuntimeError } from "../errors";
import { resetTurnBuffer } from "../folding/state";
import { bumpConversationGeneration, generations, turnState } from "../generations";
import { applyTransportEvent, RECONNECT_REASONS, type ReconnectReason } from "../transport-status";
import { consumeSuppressedConnectionRecovery } from "../recovery/runtime-state";
import { reconcileAfterConnectionLoss } from "../recovery/connection";
import { reconcileAfterGap } from "../recovery/gap";
import { applySessionReplacements } from "../session-replacement";
import type { RuntimeState } from "../types";

const RECONNECT_REASON_SET = new Set<string>(RECONNECT_REASONS);

/** Attribution travels with the transport event; an event emitted before the
 *  reason field existed carries none, so the caller supplies its own. */
function reconnectReason(event: PiScienceEvent, fallback: ReconnectReason): ReconnectReason {
  return typeof event.reason === "string" && RECONNECT_REASON_SET.has(event.reason)
    ? event.reason as ReconnectReason
    : fallback;
}

export function handleTransportEvent(client: PiScienceClient, event: PiScienceEvent, state: RuntimeState): "handled" | "deferred" | undefined {
  if (event.type === "session.replaced") {
    const replacementSessionId = String(event.replacementSessionId || "");
    if (!replacementSessionId) return "handled";
    const previousActiveId = state.activeSessionId;
    const nextActiveId = applySessionReplacements([{
      cwd: state.cwd,
      oldId: String(event.sessionId || state.activeSessionId || ""),
      newId: replacementSessionId,
    }]);
    // Adopting a replacement re-attaches the stream and clears the thread, so
    // this record cannot leave a hole behind. A record that changed nothing
    // still consumed a position and must reach the fold below.
    if (nextActiveId !== previousActiveId) return "handled";
  }

  if (event.type === "stream.gap") {
    bumpConversationGeneration();
    resetTurnBuffer();
    turnState.errored = false;
    // A gap is a projection repair, not a lost backend: a session the user
    // is already working in stays ready while the rebase runs. Only a
    // session that never reached ready keeps showing the attach phase.
    applyTransportEvent({
      transport: "recovering",
      reason: "stream_gap",
      foreground: "connecting",
      keepReady: true,
      sessionId: state.activeSessionId,
      detail: "server declared a stream gap",
    });
    // Recover the authoritative snapshot from REST (messages + state). We do
    // NOT clear `working` here: if the backend is still mid-turn, Send must
    // stay disabled until the authoritative state read reports idle.
    if (state.activeSessionId) {
      const sessionId = state.activeSessionId;
      const cwd = state.cwd;
      void reconcileAfterGap(sessionId, cwd, { resetTransport: true, reconnectTransport: true });
    }
    return "deferred";
  }

  if (event.type === "connection.connecting" || event.type === "connection.reconnecting") {
    const reconnecting = event.type === "connection.reconnecting";
    // Same-session stream repair is background work. It updates transport
    // diagnostics and must not demote a ready conversation to `connecting`;
    // a foreground attach already set `connecting` before connecting.
    applyTransportEvent({
      transport: reconnecting ? "reconnecting" : "connecting",
      reason: reconnectReason(event, reconnecting ? "transport_error" : "initial_attach"),
      foreground: "connecting",
      keepReady: true,
      sessionId: state.activeSessionId,
      detail: String(event.message ?? ""),
    });
    if (reconnecting && state.activeSessionId) {
      void reconcileAfterConnectionLoss(
        client,
        state.activeSessionId,
        state.cwd,
        generations.connection,
        generations.activity,
      );
    }
    return "handled";
  }
  if (event.type === "connection.open") {
    applyTransportEvent({
      transport: "open",
      reason: reconnectReason(event, "initial_attach"),
      foreground: "ready",
      sessionId: state.activeSessionId,
    });
    return "handled";
  }
  if (event.type === "connection.error") {
    appendRuntimeError(
      new Error(String(event.message || "Conversation stream closed")),
      state.activeSessionId,
      state.cwd,
    );
    // A transport error is not proof that the session is unusable. The
    // authoritative recovery below decides: it keeps the foreground ready
    // when it recovers and promotes to `error` only when it gives up.
    applyTransportEvent({
      transport: "error",
      reason: reconnectReason(event, "transport_error"),
      sessionId: state.activeSessionId,
      detail: String(event.message ?? ""),
    });
    if (state.activeSessionId) {
      void reconcileAfterConnectionLoss(
        client,
        state.activeSessionId,
        state.cwd,
        generations.connection,
        generations.activity,
      );
    }
    return "handled";
  }
  if (event.type === "connection.closed") {
    applyTransportEvent({
      transport: "closed",
      reason: reconnectReason(event, "manual"),
      foreground: "offline",
      sessionId: state.activeSessionId,
    });
    if (state.activeSessionId && !consumeSuppressedConnectionRecovery(client, state.activeSessionId, state.cwd)) {
      void reconcileAfterConnectionLoss(
        client,
        state.activeSessionId,
        state.cwd,
        generations.connection,
        generations.activity,
      );
    }
    return "handled";
  }

}
