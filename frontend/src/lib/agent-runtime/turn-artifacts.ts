import type { Thread } from "./event-fold";
import { attachTurnArtifacts } from "./event-fold";
import { getClient } from "../client/pi-science-client";
import { queryClient } from "../client/query-client";

const TURN_ARTIFACTS_STALE_MS = 3_000;

/** The same session can be restored twice during a refresh: first from the
 * local message snapshot and then from the authoritative server history. */
export const turnArtifactsKey = (cwd: string, sessionId: string) => [
  "session-turn-artifacts",
  cwd,
  sessionId,
] as const;

/** Fetch persisted turn-artifact summaries and attach them to a history-built
 *  thread. Failures degrade to the unchanged thread (the conversation itself
 *  is authoritative). */
export async function attachPersistedTurnArtifacts(
  thread: Thread,
  sessionId: string,
  cwd: string,
  opts: { windowComplete?: boolean } = {},
): Promise<Thread> {
  if (!sessionId) return thread;
  try {
    const { turns } = await queryClient.fetchQuery({
      queryKey: turnArtifactsKey(cwd, sessionId),
      queryFn: () => getClient().getTurnArtifacts(sessionId, cwd),
      staleTime: TURN_ARTIFACTS_STALE_MS,
      retry: false,
    });
    return attachTurnArtifacts(thread, turns, opts);
  } catch {
    return thread;
  }
}
