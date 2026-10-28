import { listenerBinding } from "./binding";

/** Science review is best-effort after report-shaped turns: the backend
 *  re-checks the report heuristic and its own enable gate, so this stays a
 *  cheap fire-and-forget probe that no-ops for ordinary turns. */
const scienceReviewInFlight = new Set<string>();

export function maybeRequestScienceReview(sessionId: string, cwd?: string): void {
  const client = listenerBinding.client;
  if (!client || !cwd) return;
  const key = `${cwd}\u0000${sessionId}`;
  if (scienceReviewInFlight.has(key)) return;
  scienceReviewInFlight.add(key);
  void client.requestScienceReview(sessionId, cwd, "auto").finally(() => {
    scienceReviewInFlight.delete(key);
  });
}
