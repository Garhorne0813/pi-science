import type { Thread } from "./event-fold";
import { attachTurnArtifacts } from "./event-fold";
import { getClient } from "../client/pi-science-client";

/** Fetch persisted turn-artifact summaries and attach them to a history-built
 *  thread. Failures degrade to the unchanged thread (the conversation itself
 *  is authoritative). */
export async function attachPersistedTurnArtifacts(thread: Thread, sessionId: string, cwd: string): Promise<Thread> {
  if (!sessionId) return thread;
  try {
    const { turns } = await getClient().getTurnArtifacts(sessionId, cwd);
    return attachTurnArtifacts(thread, turns);
  } catch {
    return thread;
  }
}
