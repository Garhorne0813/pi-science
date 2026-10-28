import type { PiScienceClient, PiScienceEvent } from "../../client/pi-science-client";
import { isMissingSessionError } from "../errors";
import { recoverMissingSession } from "../recovery/missing-session";
import { optimisticSessionIds } from "../sessions";
import { runtimeStore } from "../store-access";
import type { RuntimeState } from "../types";

/** Bounded optimistic-session reconnect: a freshly created session may briefly
 *  be invisible to the disk-based existence check (JSONL flushes after the
 *  session event), so the first terminal not-found error retries the attach.
 *  A session that never materializes must not reconnect forever: after the
 *  cap, fall through to the normal missing-session recovery. */
const OPTIMISTIC_RETRY_MAX = 2;

const OPTIMISTIC_RETRY_DELAY_MS = 750;

const optimisticRetries = new Map<string, number>();

let optimisticRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearOptimisticRetry(): void {
  if (optimisticRetryTimer) { clearTimeout(optimisticRetryTimer); optimisticRetryTimer = null; }
}

export function resetOptimisticRetry(): void {
  clearOptimisticRetry();
  optimisticRetries.clear();
}

export function handleMissingSessionEvent(client: PiScienceClient, event: PiScienceEvent, state: RuntimeState): boolean {
  if (
    event.type === "error"
    && event.terminal === true
    && isMissingSessionError(event.message)
  ) {
    const missingSessionId = String(event.sessionId || state.activeSessionId || "");
    // A just-created session can briefly be invisible to the disk-based
    // existence check: Harness persists the durable session before projecting
    // the session event, so the first SSE connect may see a terminal
    // "session not found" while the record is still being flushed. For an
    // optimistic (locally created, not yet listed from disk) session, retry
    // the attach instead of treating the turn as dead — recovering would
    // blank the conversation the user just started.
    if (missingSessionId && optimisticSessionIds.has(missingSessionId)) {
      const attempts = optimisticRetries.get(missingSessionId) ?? 0;
      if (attempts < OPTIMISTIC_RETRY_MAX) {
        optimisticRetries.set(missingSessionId, attempts + 1);
        runtimeStore.setState({ status: "connecting" });
        clearOptimisticRetry();
        optimisticRetryTimer = setTimeout(() => {
          optimisticRetryTimer = null;
          const latest = runtimeStore.getState();
          if (latest.activeSessionId === missingSessionId && latest.cwd === state.cwd) {
            client.connect(missingSessionId, state.cwd);
          }
        }, OPTIMISTIC_RETRY_DELAY_MS);
        return true;
      }
      // The session never materialized on disk within the retry window: stop
      // treating it as optimistic so the normal missing-session recovery runs
      // (it clears the active session instead of reconnecting forever).
      optimisticSessionIds.delete(missingSessionId);
      optimisticRetries.delete(missingSessionId);
    }
    recoverMissingSession(missingSessionId, state.cwd, client);
    return true;
  }

  return false;
}
