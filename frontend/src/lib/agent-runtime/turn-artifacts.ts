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
    const { turns } = await queryTurnArtifacts(sessionId, cwd, TURN_ARTIFACTS_STALE_MS);
    return turns;
  } catch {
    return [];
  }
}

/** Force an authoritative artifact read after live metadata changed while a
 * history resync was in flight. Unlike the normal restore helper, failures are
 * surfaced so the caller can preserve the newer live metadata instead of
 * mistaking an unavailable endpoint for an empty artifact list. */
export async function refetchPersistedTurnArtifacts(sessionId: string, cwd: string): Promise<TurnArtifactTurn[]> {
  if (!sessionId) return [];
  const { turns } = await queryTurnArtifacts(sessionId, cwd, 0);
  return turns;
}

function queryTurnArtifacts(sessionId: string, cwd: string, staleTime: number) {
  return queryClient.fetchQuery({
    queryKey: turnArtifactsKey(cwd, sessionId),
    queryFn: () => getClient().getTurnArtifacts(sessionId, cwd),
    staleTime,
    retry: false,
  });
}
