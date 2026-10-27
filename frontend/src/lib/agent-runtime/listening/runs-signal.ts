import type { PiScienceEvent } from "../../client/pi-science-client";
import { queryClient } from "../../client/query-client";
import { runsKey } from "../../runs";
import { runtimeStore } from "../store-access";

const RUNS_SIGNAL_DEBOUNCE_MS = 150;

let runsSignalTimer: ReturnType<typeof setTimeout> | null = null;

/** Executions stay a REST surface, so this stream can only invalidate them.
 *  Coalesce the burst a parallel tool fan-out produces into one refetch. */
export function signalRunsForCurrentWorkspace(): void {
  runsSignalTimer ??= setTimeout(() => {
    runsSignalTimer = null;
    void queryClient.invalidateQueries({ queryKey: runsKey(runtimeStore.getState().cwd) });
  }, RUNS_SIGNAL_DEBOUNCE_MS);
}

/** SSE v3 names operation/tool boundaries explicitly. Output deltas never
 *  invalidate runs, even when a replayed tool.updated carries old metadata. */
export function isExecutionBoundary(event: PiScienceEvent): boolean {
  switch (event.type) {
    case "operation.started":
    case "operation.settled":
    case "tool.started":
    case "tool.completed":
      return true;
    default:
      return false;
  }
}

/** A stream that resumed after being hidden or dropped missed whatever ran in
 *  the meantime; the re-attach is the only signal for those executions. */
export function isRecoveryAttach(event: PiScienceEvent): boolean {
  return event.type === "connection.open" && event.reason !== "initial_attach";
}

export function resetRunsSignal(): void {
  if (runsSignalTimer !== null) clearTimeout(runsSignalTimer);
  runsSignalTimer = null;
}
