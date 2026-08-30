import { getClient, type TurnArtifactTurn } from "../client/pi-science-client";
import { queryClient } from "../client/query-client";

const TURN_ARTIFACTS_STALE_MS = 3_000;

/** The same session can be restored twice during a refresh: first from the
 * local message snapshot and then from the authoritative server history. */
export const turnArtifactsKey = (cwd: string, sessionId: string) => [
  "session-turn-artifacts",
  cwd,
  sessionId,
] as const;

/** Fetch persisted turn-artifact summaries through the shared query cache. */
export async function fetchPersistedTurnArtifacts(sessionId: string, cwd: string): Promise<TurnArtifactTurn[]> {
  if (!sessionId) return [];
  try {
    const { turns } = await queryClient.fetchQuery({
      queryKey: turnArtifactsKey(cwd, sessionId),
      queryFn: () => getClient().getTurnArtifacts(sessionId, cwd),
      staleTime: TURN_ARTIFACTS_STALE_MS,
      retry: false,
    });
    return turns;
  } catch {
    return [];
  }
}
