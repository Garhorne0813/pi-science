import type { PiScienceClient, SessionMessagePage } from "../client/pi-science-client";
import { mergeHistoryWindow, type HistoryWindowMerge, type Thread } from "./event-fold";

export interface RecoveryHistoryWindow extends HistoryWindowMerge {
  boundaryPage: SessionMessagePage;
}

/** Merge a fresh latest-page snapshot without treating a pagination gap as a
 * history rewrite. If the newest page has no overlap with the loaded window,
 * walk older pages until an overlap is found or the beginning of history is
 * reached. Only the latter proves that a no-overlap snapshot is a different
 * lineage and may replace the loaded window wholesale.
 *
 * If an older-page probe fails, keep the current window conservatively. A
 * later recovery round can retry; dropping already loaded history is not a
 * safe fallback for an incomplete lineage check. */
export async function mergeRecoveryHistoryWindow(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  current: Thread,
  initial: SessionMessagePage,
  opts: { keepLiveExtras: boolean },
): Promise<RecoveryHistoryWindow> {
  let boundaryPage = initial;
  let messages = [...initial.messages];
  let merged = mergeHistoryWindow(current, messages, opts);

  while (!merged.retainedOlderPrefix && boundaryPage.has_more) {
    const before = boundaryPage.next_cursor;
    if (!before) {
      return { thread: current, retainedOlderPrefix: true, boundaryPage: initial };
    }
    try {
      boundaryPage = await client.getMessagesPage(sessionId, cwd, { before });
    } catch {
      return { thread: current, retainedOlderPrefix: true, boundaryPage: initial };
    }
    messages = [...boundaryPage.messages, ...messages];
    merged = mergeHistoryWindow(current, messages, opts);
  }

  return { ...merged, boundaryPage };
}
