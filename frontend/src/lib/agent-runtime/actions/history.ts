/** History pagination owns cursor-scoped in-flight requests and stale-cursor rebasing. */
import { getClient } from "../../client/pi-science-client";
import { appendRuntimeError } from "../errors";
import { attachTurnArtifacts } from "../folding/artifacts";
import { prependHistoryMessages } from "../folding/history-window";
import { fetchPersistedTurnArtifacts } from "../turn-artifacts";
import { mergeRecoveryHistoryWindow } from "../history-window-recovery";
import { generations } from "../generations";
import type { RuntimeState } from "../types";
import type { GetState, SetState } from "./types";
import { historyPageKey } from "./identity";

const _historyPagePromises = new Map<string, Promise<number>>();
export function clearHistoryRequests(): void { _historyPagePromises.clear(); }

export function createHistoryActions(set: SetState, get: GetState): Pick<RuntimeState, "loadOlderMessages"> {
  const loadHistoryPage = async (sessionId: string, cwd: string, before: string): Promise<number> => {
    const connectionGeneration = generations.connection;
    set({ historyLoading: true });
    try {
      const client = getClient();
      let page;
      try {
        page = await client.getMessagesPage(sessionId, cwd, { before });
      } catch (firstError) {
        if (String(firstError).includes("stale history cursor")) {
          const current = get();
          const fresh = await client.getMessagesPage(sessionId, cwd);
          const rebased = await mergeRecoveryHistoryWindow(client, sessionId, cwd, current.thread, fresh, { keepLiveExtras: true });
          const latest = get();
          if (
            connectionGeneration !== generations.connection
            || latest.activeSessionId !== sessionId
            || latest.cwd !== cwd
            || latest.historyCursor !== before
          ) return 0;
          const added = rebased.thread.blocks.length - latest.thread.blocks.length;
          ++generations.historyWindow;
          set({
            thread: rebased.thread,
            historyCursor: rebased.boundaryPage.next_cursor,
            historyHasMore: rebased.boundaryPage.has_more,
            historySnapshotVersion: fresh.snapshot_version,
            historyLoading: false,
          });
          return added;
        }
        // One bounded retry absorbs a transient backend restart without
        // requiring the user to leave the top of the list and scroll back.
        page = await client.getMessagesPage(sessionId, cwd, { before });
      }
      const current = get();
      if (
        connectionGeneration !== generations.connection
        || current.activeSessionId !== sessionId
        || current.cwd !== cwd
        || current.historyCursor !== before
      ) return 0;
      const merged = prependHistoryMessages(current.thread, page.messages);
      ++generations.historyWindow;
      set({
        thread: merged,
        historyCursor: page.next_cursor,
        historyHasMore: page.has_more,
        historySnapshotVersion: page.snapshot_version,
        historyLoading: false,
      });

      // Show history first. Re-anchor against the newest thread after the
      // optional artifact request completes.
      void fetchPersistedTurnArtifacts(sessionId, cwd).then((turns) => {
        const latest = get();
        if (
          connectionGeneration !== generations.connection
          || latest.activeSessionId !== sessionId
          || latest.cwd !== cwd
        ) return;
        set({
          thread: attachTurnArtifacts(latest.thread, turns, { windowComplete: !latest.historyHasMore }),
        });
      });
      // Report what is actually new. A duplicate page (a boundary that
      // drifted into already-loaded history) must not scroll-anchor as if
      // fresh content arrived; the received count is page.messages.length.
      return merged.blocks.length - current.thread.blocks.length;
    } catch (error) {
      const current = get();
      if (current.activeSessionId === sessionId && current.cwd === cwd) {
        appendRuntimeError(error, sessionId, cwd);
      }
      return 0;
    } finally {
      const current = get();
      if (current.activeSessionId === sessionId && current.cwd === cwd) set({ historyLoading: false });
    }
  };


  return {
    loadOlderMessages: async () => {
      const state = get();
      if (!state.activeSessionId || !state.historyHasMore || !state.historyCursor) return 0;
      const before = state.historyCursor;
      const key = historyPageKey(state.cwd, state.activeSessionId, before);
      const existing = _historyPagePromises.get(key);
      if (existing) return existing;
      if (state.historyLoading) return 0;
      const promise = loadHistoryPage(state.activeSessionId, state.cwd, before);
      _historyPagePromises.set(key, promise);
      try {
        return await promise;
      } finally {
        if (_historyPagePromises.get(key) === promise) _historyPagePromises.delete(key);
      }
    },
  };
}
