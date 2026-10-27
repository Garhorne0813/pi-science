/** Own the single subscription binding and preserve stream effect ordering. */
import type { PiScienceClient } from "../../client/pi-science-client";
import { runtimeStore } from "../store-access";
import { listenerBinding } from "./binding";
import { disarmTurnWatchdog, noteTurnEvent } from "./watchdog";
import { resetOptimisticRetry, handleMissingSessionEvent } from "./missing-session";
import { resetRunsSignal, signalRunsForCurrentWorkspace, isExecutionBoundary, isRecoveryAttach } from "./runs-signal";
import { handleTransportEvent } from "./transport";
import { applyInteractionEvent } from "./interactions";
import { applyLifecycleEvent } from "./lifecycle";
import { applyEventProjection } from "./projection";

/** One subscription dispatches effects in the same order as the stream. */
export function registerEventListener(client: PiScienceClient): void {
  if (listenerBinding.client === client && listenerBinding.unsubscribe) return;
  disarmTurnWatchdog();
  resetOptimisticRetry();
  resetRunsSignal();
  listenerBinding.unsubscribe?.();
  listenerBinding.client = client;
  listenerBinding.unsubscribe = client.onEvent((event) => {
    const state = runtimeStore.getState();
    if (event.sessionId && state.activeSessionId && event.sessionId !== state.activeSessionId) return;
    if (event.type === "approval.mode.changed") {
      window.dispatchEvent(new CustomEvent("pi-science-approval-mode-changed", { detail: { ...event, cwd: state.cwd } }));
      return;
    }
    // Transport chatter must not reset the watchdog's silence clock.
    if (!event.type.startsWith("connection.")) noteTurnEvent();
    if (isExecutionBoundary(event) || isRecoveryAttach(event) || event.type === "stream.gap") signalRunsForCurrentWorkspace();

    const transport = handleTransportEvent(client, event, state);
    if (transport) return transport === "deferred" ? false : undefined;
    if (handleMissingSessionEvent(client, event, state)) return;
    applyInteractionEvent(event);
    // Lifecycle guards deliberately use the snapshot captured before effects.
    applyLifecycleEvent(event, state);
    return applyEventProjection(event);
  });
}
