import { listenerBinding } from "./binding";

/** Science review is best-effort after report-shaped turns: the backend
 *  re-checks the report heuristic and its own enable gate, so this stays a
 *  cheap fire-and-forget probe that no-ops for ordinary turns. */
const scienceReviewInFlight = new Set<string>();

function reportFailure(error: unknown): void {
  console.warn("Science review request failed:", error);
}

export function maybeRequestScienceReview(sessionId: string, cwd?: string): void {
  const client = listenerBinding.client;
  if (!client || !cwd) return;
  const key = `${cwd}\u0000${sessionId}`;
  if (scienceReviewInFlight.has(key)) return;
  scienceReviewInFlight.add(key);
  // A 409 (a review is already running), a 5xx, a dropped request or a client
  // that throws before it returns a promise all mean the review did not start.
  // None of them may become an unhandled rejection, and none may pin this
  // workspace session out of the reviews of later turns.
  const release = () => { scienceReviewInFlight.delete(key); };
  try {
    void client.requestScienceReview(sessionId, cwd, "auto").catch(reportFailure).finally(release);
  } catch (error) {
    reportFailure(error);
    release();
  }
}
