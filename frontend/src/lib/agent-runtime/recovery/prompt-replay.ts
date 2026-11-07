/** Replays a prompt whose HTTP delivery never landed — in practice a refresh
 *  during the lazy session-create round trip, which used to leave an empty
 *  session and lose the message entirely. */
import { pendingPromptRequests, updateLocalPromptRequest } from "../../client/prompt-request-cache";
import type { GetState } from "../actions/types";

// A prompt older than this is a draft the user has long moved past; replaying
// it on the next visit would be a surprise, not a recovery.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Per page load. StrictMode mounts the landing effect twice, and a second
// replay in the same page would waste a create round trip on an ID the first
// one already owns. The reused clientMessageId keeps even a cross-reload
// replay idempotent on the server.
const inFlight = new Set<string>();

export async function replayPendingPrompts(cwd: string, get: GetState): Promise<string | null> {
  const state = get();
  // Only a blank landing replays. A session route already has its own
  // reconciliation path (`restorePendingPromptRequests`).
  if (state.cwd !== cwd || state.activeSessionId) return null;
  const [record] = pendingPromptRequests(cwd)
    .filter((item) => item.text.trim().length > 0 && Date.now() - item.createdAt < MAX_AGE_MS)
    .sort((left, right) => right.createdAt - left.createdAt);
  if (!record || inFlight.has(record.clientMessageId)) return null;
  inFlight.add(record.clientMessageId);
  try {
    // The create round trip may have finished before the reload without the
    // prompt POST landing; adopt that session instead of creating a second one.
    if (record.sessionId) {
      await get().connect(cwd, record.sessionId);
      if (get().cwd !== cwd || get().working) return null;
    }
    const sessionId = await get().sendPrompt(record.text, record.clientMessageId, { replay: true });
    if (sessionId) updateLocalPromptRequest(record.clientMessageId, { sessionId });
    return sessionId;
  } catch {
    // Keep the record: the next landing retries it, and the reused
    // clientMessageId keeps that retry from dispatching a second turn.
    return null;
  } finally {
    inFlight.delete(record.clientMessageId);
  }
}

/** Test hook: the single-flight guard is process-wide on purpose. */
export function resetPendingPromptReplayForTest(): void {
  inFlight.clear();
}
