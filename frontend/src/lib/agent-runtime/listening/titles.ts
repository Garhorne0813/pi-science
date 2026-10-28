import { aiTitleAttemptedAt, hasAiTitle, markAiTitleAttempted } from "../../client/pi-science-client";
import { applyAiSessionName } from "../naming";
import { listenerBinding } from "./binding";

/** AI title generation is best-effort: one in-flight request per session,
 *  skipped once a title is already marked as AI-generated, silent on failure.
 *  Failed attempts are recorded with a TTL so a broken provider or runtime
 *  does not spawn a fresh agent worker on every idle event. */
const aiTitleInFlight = new Set<string>();

const AI_TITLE_RETRY_MS = 60 * 60 * 1000;

export function maybeGenerateAiTitle(sessionId: string, cwd?: string): void {
  const client = listenerBinding.client;
  if (!client || !cwd || hasAiTitle(cwd, sessionId)) return;
  const attemptedAt = aiTitleAttemptedAt(cwd, sessionId);
  if (attemptedAt && Date.now() - attemptedAt < AI_TITLE_RETRY_MS) return;
  const key = `${cwd}\u0000${sessionId}`;
  if (aiTitleInFlight.has(key)) return;
  aiTitleInFlight.add(key);
  void client
    .generateSessionTitle(sessionId, cwd)
    .then((title) => {
      if (title) applyAiSessionName(cwd, sessionId, title);
      else markAiTitleAttempted(cwd, sessionId);
    })
    .catch(() => {
      markAiTitleAttempted(cwd, sessionId);
    })
    .finally(() => {
      aiTitleInFlight.delete(key);
    });
}
