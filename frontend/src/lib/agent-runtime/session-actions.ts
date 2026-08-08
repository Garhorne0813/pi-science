/** The store's action implementations. They are created once, when the store
 *  is created, and receive zustand's `set`/`get` directly — so action
 *  references stay stable across renders exactly as before. */

import type { StoreApi } from "zustand";
import type { ThreadBlock } from "../../types/thread";
import {
  clearCachedMessages,
  getClient,
  moveSessionName,
  type HistoryMessage,
  type SessionInfo,
} from "../client/pi-science-client";
import { appendRuntimeError, isMissingSessionError } from "./errors";
import { emptyThread, mergeHistoryWithLive, prependHistoryMessages, resetTurnBuffer, threadFromMessages } from "./event-fold";
import { attachPersistedTurnArtifacts } from "./turn-artifacts";
import { generations, turnState } from "./generations";
import { registerEventListener } from "./listener";
import { applyPromptSessionName, backfillSessionName } from "./naming";
import { recoverMissingSession, reconcileAfterConnectionLoss, reconcilePromptAfterLateStream, rememberRuntimeState, suppressConnectionRecovery } from "./recovery";
import { loadSessionsInternal, optimisticSessionIds } from "./sessions";
import { hasActivePendingInteraction, hasPendingInteractionData, type RuntimeState } from "./types";

type SetState = StoreApi<RuntimeState>["setState"];
type GetState = StoreApi<RuntimeState>["getState"];

/** In-flight createSession calls per workspace, so concurrent first prompts
 *  (or a StrictMode double effect) share one backend session instead of
 *  racing two. Owned by `createNewSession`, which also clears each entry. */
const _createSessionPromises = new Map<string, Promise<string>>();
function connectionKey(cwd: string, sessionId?: string): string { return `${cwd}\u0000${sessionId ?? ""}`; }

export function createRuntimeActions(set: SetState, get: GetState) {
  /** React StrictMode can replay the route effect while the first session
   * connection is still loading. Share that initial load for the same target;
   * a later target still supersedes the previous generation as before. */
  const connectPromises = new Map<string, Promise<void>>();

  const connect = async (cwd: string, sessionId?: string) => {
      const generation = ++generations.connection;
      ++generations.promptMonitor;
      ++generations.activity;
      const connectActivityGeneration = generations.activity;
      const localMutationGeneration = generations.localMutation;
      resetTurnBuffer();
      turnState.errored = false;
      const state = get();
      const targetChanged = state.cwd !== cwd || state.activeSessionId !== (sessionId ?? null);
      if (targetChanged) {
        set({
          thread: emptyThread(),
          historyCursor: null,
          historyHasMore: false,
          historyLoading: false,
          historySnapshotVersion: "",
          sessions: state.cwd !== cwd ? [] : state.sessions,
          activeSessionId: sessionId ?? null,
          working: false,
          model: null,
          thinking: null,
          contextTokens: null,
          contextWindow: null,
          contextPercent: null,
          compactionEnabled: true,
          compactionThresholdPercent: null,
          pendingInteraction: null,
          pendingQuestionnaire: null,
        });
      }
      set({ status: "connecting", cwd });
      const client = getClient();
      registerEventListener(client);
      set({ client });

      try {
        if (!sessionId) {
          // A workspace landing page is not itself a conversation. Creating
          // lazily on the first send/new-session action avoids StrictMode ghost
          // sessions and empty records created merely by navigation.
          client.disconnect();
          set({
            activeSessionId: null,
            thread: { blocks: [], index: {}, loaded: true },
            historyCursor: null,
            historyHasMore: false,
            historyLoading: false,
            historySnapshotVersion: "",
            status: "ready",
            working: false,
          });
          void loadSessionsInternal();
          return;
        }
        const targetSessionId = sessionId;
        set({ activeSessionId: targetSessionId });

        // Optimistic render: if we have a cached message snapshot for this
        // session, render it immediately so the user sees the conversation
        // while the network request is still in flight.
        const cachedMessages = client.getCachedMessages(targetSessionId, cwd);
        if (cachedMessages && cachedMessages.length > 0) {
          if (localMutationGeneration === generations.localMutation && generation === generations.connection) {
            set({ thread: await attachPersistedTurnArtifacts(threadFromMessages(cachedMessages), targetSessionId, cwd) });
          }
        }

        client.connect(targetSessionId, cwd);
        const [messagesResult, runtimeStateResult] = await Promise.allSettled([
          client.getMessagesPage(targetSessionId, cwd),
          client.getSessionState(targetSessionId, cwd),
        ]);
        if (generation !== generations.connection) return;
        // A prompt/model action may have started while the initial history/state
        // reads were in flight. Never overwrite its optimistic blocks or status
        // with the older snapshot that just arrived.
        if (localMutationGeneration !== generations.localMutation) return;

        const nextState: Partial<RuntimeState> = {};
        // History/state requests race the SSE connection. If live events arrived
        // while those requests were in flight, their reducer state is newer than
        // either HTTP snapshot and must not be overwritten by a stale
        // `is_streaming: false` (or a transient state-read error).
        const liveActivityArrived = generations.activity !== connectActivityGeneration;
        if (messagesResult.status === "fulfilled") {
          nextState.thread = await attachPersistedTurnArtifacts(
            mergeHistoryWithLive(
              threadFromMessages(messagesResult.value.messages),
              get().thread,
            ),
            targetSessionId,
            cwd,
          );
          nextState.historyCursor = messagesResult.value.next_cursor;
          nextState.historyHasMore = messagesResult.value.has_more;
          nextState.historySnapshotVersion = messagesResult.value.snapshot_version;
        }
        if (runtimeStateResult.status === "fulfilled") {
          const runtimeState = runtimeStateResult.value;
          rememberRuntimeState(client, targetSessionId, cwd, runtimeState, connectActivityGeneration);
          if (!liveActivityArrived) {
            const runtimeBusy = runtimeState.is_streaming
              || runtimeState.is_compacting
              || runtimeState.pending_message_count > 0;
            const current = get();
            const pendingInteraction = hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire);
            const awaitingUserInput = hasActivePendingInteraction(current.pendingInteraction, current.pendingQuestionnaire);
            nextState.working = pendingInteraction ? !awaitingUserInput : runtimeBusy;
          }
          nextState.model = runtimeState.model ?? null;
          nextState.thinking = runtimeState.thinking ?? null;
          nextState.contextTokens = runtimeState.context_tokens ?? null;
          nextState.contextWindow = runtimeState.context_window ?? null;
          nextState.contextPercent = runtimeState.context_percent ?? null;
          nextState.compactionEnabled = runtimeState.compaction_enabled ?? true;
          nextState.compactionThresholdPercent = runtimeState.compaction_threshold_percent ?? null;
        } else {
          if (!liveActivityArrived) {
            // A failed state read is not proof that a restored session is idle.
            // Keep the composer guarded until bounded authoritative recovery
            // confirms an idle runtime.
            nextState.status = "error";
            nextState.working = true;
          }
        }
        // A newly-created session may already have opened its SSE connection
        // before the route effect calls connect() again. In that case
        // PiScienceClient.connect() is intentionally a no-op, so the route
        // effect must still settle the store back to ready after REST succeeds.
        if (
          messagesResult.status === "fulfilled"
          && runtimeStateResult.status === "fulfilled"
          && client.isOpenTo(targetSessionId, cwd)
        ) {
          nextState.status = "ready";
        }
        set(nextState);
        if (nextState.thread) backfillSessionName(cwd, targetSessionId, nextState.thread);

        const failure = messagesResult.status === "rejected"
          ? messagesResult.reason
          : runtimeStateResult.status === "rejected"
            ? runtimeStateResult.reason
            : null;
        if (failure && isMissingSessionError(failure)) {
          recoverMissingSession(targetSessionId, cwd, client);
          return;
        }
        if (failure) {
          appendRuntimeError(failure, targetSessionId, cwd);
          if (!liveActivityArrived) {
            void reconcileAfterConnectionLoss(
              client,
              targetSessionId,
              cwd,
              generation,
              generations.activity,
            );
          }
        }
      } catch (err) {
        if (generation !== generations.connection) return;
        console.error("Failed to connect session:", err);
        if (isMissingSessionError(err) && sessionId) {
          recoverMissingSession(sessionId, cwd, client);
          return;
        }
        appendRuntimeError(err, sessionId ?? null, cwd);
        // A failed connection is not proof that the backend is idle. Keep the
        // composer guarded until a subsequent authoritative state read.
        set({ status: "error", working: true });
      }

      if (generation === generations.connection) void loadSessionsInternal();
    };

  const connectDeduped = (cwd: string, sessionId?: string): Promise<void> => {
    const key = connectionKey(cwd, sessionId);
    const existing = connectPromises.get(key);
    if (existing) return existing;
    // A different target makes all previous in-flight loads stale. Their
    // generation checks still prevent them from writing state when they finish.
    connectPromises.clear();
    const pending = connect(cwd, sessionId);
    connectPromises.set(key, pending);
    const clearIfCurrent = () => {
      if (connectPromises.get(key) === pending) connectPromises.delete(key);
    };
    void pending.then(clearIfCurrent, clearIfCurrent);
    return pending;
  };

  const loadHistoryPage = async (sessionId: string, cwd: string, before: string): Promise<number> => {
    set({ historyLoading: true });
    try {
      const page = await getClient().getMessagesPage(sessionId, cwd, { before });
      const current = get();
      if (current.activeSessionId !== sessionId || current.cwd !== cwd) return 0;
      set({
        thread: prependHistoryMessages(current.thread, page.messages),
        historyCursor: page.next_cursor,
        historyHasMore: page.has_more,
        historySnapshotVersion: page.snapshot_version,
      });
      return page.messages.length;
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
    connect: connectDeduped,

    disconnect: () => {
      connectPromises.clear();
      ++generations.connection;
      ++generations.promptMonitor;
      const { client, activeSessionId, cwd } = get();
      if (client && activeSessionId && client.isConnectedTo(activeSessionId, cwd)) {
        suppressConnectionRecovery(client, activeSessionId, cwd);
      }
      client?.disconnect();
      // Unmounting the conversation view does not stop the backend turn. Keep
      // the stop/busy state so workspace-level controls cannot race the active
      // agent merely because the user opened Files or Knowledge.
      set({ status: "offline", pendingInteraction: null, pendingQuestionnaire: null });
    },

    sendPrompt: async (message: string): Promise<string | null> => {
      if (!message.trim()) return null;
      const initialState = get();
      if (initialState.working || initialState.pendingInteraction || initialState.pendingQuestionnaire) {
        throw new Error("The current conversation is still running");
      }
      let { activeSessionId, cwd } = initialState;
      const thread = get().thread;
      const userBlock: ThreadBlock = {
        kind: "user",
        id: `user-${Date.now()}`,
        text: message,
        timestamp: new Date().toISOString(),
      };
      const blocks = [...thread.blocks, userBlock];
      set({ thread: { blocks, index: { ...thread.index, [userBlock.id]: blocks.length - 1 }, loaded: true }, working: true });
      if (!activeSessionId) {
        try {
          activeSessionId = await get().createNewSession();
        } catch (error) {
          const current = get();
          if (current.cwd === cwd) set({ working: false });
          throw error;
        }
      }
      const client = getClient();
      registerEventListener(client);
      if (!client.isConnectedTo(activeSessionId, cwd)) {
        set({ activeSessionId, client, status: "connecting" });
        client.connect(activeSessionId, cwd);
      }
      const streamWasOpen = client.isOpenTo(activeSessionId, cwd);

      const activityGeneration = ++generations.activity;
      ++generations.localMutation;
      resetTurnBuffer();
      turnState.errored = false;
      set({ client, working: true });

      applyPromptSessionName(cwd, activeSessionId, message);
      // Baseline for the late-stream monitor: any assistant message persisted
      // after this instant belongs to the turn being sent. Captured before the
      // HTTP acknowledgement so a fast reply can never be attributed to a
      // previous turn (nor a slow monitor to the wrong prompt).
      const promptTimestamp = Date.now();
      try {
        await client.sendPrompt(activeSessionId, message, cwd);
        if (!streamWasOpen) {
          const monitorGeneration = ++generations.promptMonitor;
          void reconcilePromptAfterLateStream(
            client,
            activeSessionId,
            cwd,
            monitorGeneration,
            promptTimestamp,
          );
        }
        return activeSessionId;
      } catch (error) {
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
          // A stale URL/session can fail before the SSE terminal event arrives.
          // Clear it here as well so the prompt error cannot leave the UI bound
          // to an ID that will only produce more "session not found" events.
          if (isMissingSessionError(error)) {
            recoverMissingSession(activeSessionId, cwd, client);
            throw error;
          }
          // The HTTP acknowledgement can time out after Pi already accepted the
          // prompt. Live events or authoritative streaming state win over that
          // ambiguous transport failure, preventing a false reset to Send.
          if (activityGeneration !== generations.activity && current.working) return null;
          try {
            const runtimeState = await client.getSessionState(activeSessionId, cwd);
            const stillCurrent = get();
            if (
              stillCurrent.activeSessionId === activeSessionId
              && stillCurrent.cwd === cwd
              && (
                runtimeState.is_streaming
                || runtimeState.is_compacting
                || runtimeState.pending_message_count > 0
              )
            ) {
              set({ working: true, status: "connecting" });
              return null;
            }
          } catch {
            // Fall through to the original request error.
          }
          appendRuntimeError(error, activeSessionId, cwd);
          const metadata = error as Error & { code?: string; status?: number };
          const ambiguousTransportFailure = metadata.code === "timeout"
            || (!metadata.code && (metadata.status === undefined || metadata.status >= 500));
          set({
            // Pi keeps its busy guard after an ambiguous prompt acknowledgement
            // until the user aborts. Keep Stop visible so the UI cannot submit a
            // second prompt against that still-running/unknown turn.
            working: ambiguousTransportFailure,
            status: "error",
          });
        }
        throw error;
      }
    },

    abort: async () => {
      const { activeSessionId, cwd } = get();
      if (!activeSessionId) return;
      ++generations.activity;
      ++generations.localMutation;
      ++generations.promptMonitor;
      try {
        await getClient().abort(activeSessionId, cwd);
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
          set({ working: false, status: "ready", pendingInteraction: null, pendingQuestionnaire: null });
        }
      } catch (error) {
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
          appendRuntimeError(error, activeSessionId, cwd);
          set({ status: "error" });
        }
        throw error;
      }
    },

    setModel: async (model: string, thinking?: string) => {
      const { activeSessionId, cwd, working } = get();
      if (!activeSessionId) return null;
      if (working) throw new Error("Stop the current task before changing models");
      const activityGeneration = ++generations.activity;
      ++generations.localMutation;
      const client = getClient();
      registerEventListener(client);
      try {
        const result = await client.setModel(activeSessionId, model, cwd, thinking);
        const nextSessionId = result.id || activeSessionId;
        const current = get();
        if (
          activityGeneration === generations.activity
          && current.activeSessionId === activeSessionId
          && current.cwd === cwd
        ) {
          if (nextSessionId !== activeSessionId) {
            ++generations.connection;
            ++generations.activity;
            ++generations.localMutation;
            resetTurnBuffer();
            turnState.errored = false;
            clearCachedMessages(cwd, activeSessionId);
            client.clearCursor(cwd, activeSessionId);
            const movedName = moveSessionName(cwd, activeSessionId, nextSessionId);
              client.connect(nextSessionId, cwd);
            set({
              client,
              activeSessionId: nextSessionId,
              historyCursor: null,
              historyHasMore: false,
              historyLoading: false,
              historySnapshotVersion: "",
              model: result.model ?? model,
              thinking: result.thinking ?? thinking ?? current.thinking,
              status: result.restarted ? "connecting" : "ready",
              sessions: [
                {
                  ...(current.sessions.find((session) => session.id === activeSessionId) || { cwd }),
                  id: nextSessionId,
                  name: movedName || current.sessions.find((session) => session.id === activeSessionId)?.name,
                },
                ...current.sessions.filter((session) => session.id !== activeSessionId && session.id !== nextSessionId),
              ].slice(0, 50),
            });
            return nextSessionId;
          }
          set({
            client,
            activeSessionId: nextSessionId,
            sessions: nextSessionId === activeSessionId
              ? current.sessions
              : [
                  {
                    ...(current.sessions.find((session) => session.id === activeSessionId) || { cwd }),
                    id: nextSessionId,
                    name: current.sessions.find((session) => session.id === activeSessionId)?.name,
                  },
                  ...current.sessions.filter((session) => session.id !== activeSessionId && session.id !== nextSessionId),
                ].slice(0, 50),
            model: result.model ?? model,
            thinking: result.thinking ?? thinking ?? current.thinking,
            status: result.restarted ? "connecting" : "ready",
          });
        }
        return nextSessionId;
      } catch (error) {
        try {
          const runtimeState = await client.getSessionState(activeSessionId, cwd);
          const current = get();
          if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
            set({
              model: runtimeState.model ?? current.model,
              thinking: runtimeState.thinking ?? current.thinking,
              working: runtimeState.is_streaming || runtimeState.is_compacting,
            });
          }
        } catch {
          // Preserve the previous UI state when even the recovery read fails.
        }
        throw error;
      }
    },

    respondToInteraction: async (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
      const { activeSessionId, cwd, pendingInteraction } = get();
      if (!activeSessionId || !pendingInteraction) return;
      const requestId = pendingInteraction.requestId;
      ++generations.activity;
      ++generations.localMutation;
      try {
        await getClient().respondToInteraction(
          activeSessionId,
          requestId,
          response,
          cwd,
        );
        const current = get();
        if (
          current.activeSessionId === activeSessionId
          && current.cwd === cwd
          && current.pendingInteraction?.requestId === requestId
        ) {
          set({ pendingInteraction: null, status: "ready" });
        }
      } catch (error) {
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
          appendRuntimeError(error, activeSessionId, cwd);
          set({ status: "error" });
        }
        throw error;
      }
    },

    loadSessions: async (cwd?: string) => {
      return loadSessionsInternal(cwd);
    },

    loadSession: async (sessionId: string) => {
      const cwd = get().cwd;
      await get().connect(cwd, sessionId);
    },

    loadOlderMessages: async () => {
      const state = get();
      if (!state.activeSessionId || !state.historyHasMore || !state.historyCursor || state.historyLoading) return 0;
      return loadHistoryPage(state.activeSessionId, state.cwd, state.historyCursor);
    },

    loadMessagesForNavigation: async (before: string) => {
      const state = get();
      if (!state.activeSessionId || !before || state.historyLoading) return 0;
      return loadHistoryPage(state.activeSessionId, state.cwd, before);
    },

    forkSession: async (sessionId: string) => {
      const { cwd } = get();
      const client = getClient();
      const result = await client.forkSession(sessionId, cwd);
      if (get().cwd !== cwd) {
        throw new Error("Workspace changed while the conversation was being forked");
      }
      ++generations.connection;
      ++generations.activity;
      ++generations.localMutation;
      optimisticSessionIds.add(result.id);
      set({ activeSessionId: result.id, status: "connecting", pendingInteraction: null, pendingQuestionnaire: null });
      registerEventListener(client);
      client.connect(result.id, cwd);
      let history = {
        messages: [] as HistoryMessage[],
        next_cursor: null as string | null,
        has_more: false,
        snapshot_version: "",
      };
      let historyError: unknown = null;
      try {
        history = await client.getMessagesPage(result.id, cwd);
      } catch (error) {
        // The clone already succeeded and changed the backend's active session.
        // Do not strand the UI on the parent route merely because the immediate
        // history read had a transient failure.
        historyError = error;
      }
      set({
        client,
        activeSessionId: result.id,
        thread: await attachPersistedTurnArtifacts(threadFromMessages(history.messages), result.id, cwd),
        historyCursor: history.next_cursor,
        historyHasMore: history.has_more,
        historyLoading: false,
        historySnapshotVersion: history.snapshot_version,
        working: false,
        sessions: [
          { id: result.id, cwd, project_id: get().sessions.find((session) => session.cwd === cwd)?.project_id ?? null, name: "New Session" },
          ...get().sessions.filter((session) => session.id !== result.id),
        ].slice(0, 50),
      });
      if (historyError) appendRuntimeError(historyError, result.id, cwd);
      await loadSessionsInternal();
      return result.id;
    },

    createNewSession: async () => {
      const requestCwd = get().cwd;
      const existing = _createSessionPromises.get(requestCwd);
      if (existing) return existing;
      const promise = (async () => {
        const client = getClient();
        const result = await client.createSession(requestCwd);
        if (get().cwd !== requestCwd) {
          throw new Error("Workspace changed while the conversation was being created");
        }
        ++generations.connection;
        ++generations.activity;
        ++generations.localMutation;
        resetTurnBuffer();
        turnState.errored = false;
        registerEventListener(client);
        const currentThread = get().thread;
        set({
          client,
          activeSessionId: result.id,
          thread: currentThread.blocks.length > 0 ? currentThread : emptyThread(),
          historyCursor: null,
          historyHasMore: false,
          historyLoading: false,
          historySnapshotVersion: "",
          working: false,
          status: "connecting",
          pendingInteraction: null,
          pendingQuestionnaire: null,
        });
        optimisticSessionIds.add(result.id);
        client.connect(result.id, requestCwd);
        const newSession: SessionInfo = { id: result.id, cwd: requestCwd, project_id: result.project_id ?? null, name: "New Session" };
        set((s) => ({
          sessions: [
            newSession,
            ...s.sessions.filter((item) => item.id !== result.id),
          ].slice(0, 50),
        }));
        return result.id;
      })();
      _createSessionPromises.set(requestCwd, promise);

      try {
        return await promise;
      } catch (error) {
        const current = get();
        const errorBlock: ThreadBlock = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: error instanceof Error ? error.message : "Unable to create a new session",
          level: "error",
        };
        const nextBlocks = [...current.thread.blocks, errorBlock];
        if (current.cwd === requestCwd) {
          set({
            thread: {
              blocks: nextBlocks,
              index: { ...current.thread.index, [errorBlock.id]: nextBlocks.length - 1 },
              loaded: true,
            },
            status: "error",
            working: false,
          });
        }
        throw error;
      } finally {
        if (_createSessionPromises.get(requestCwd) === promise) {
          _createSessionPromises.delete(requestCwd);
        }
      }
    },

    deleteSession: async (sessionId: string) => {
      const { cwd, activeSessionId } = get();
      await getClient().deleteSession(sessionId, cwd);
      if (activeSessionId === sessionId) {
        // Deleting the active conversation must clear its cursor/history/thread
        // state, not just drop the list row — reuse the full recovery reset.
        // Pass the client so the reset also disconnects any live SSE stream for
        // the deleted session (missing client leaves a phantom error state).
        recoverMissingSession(sessionId, cwd, getClient());
      } else {
        optimisticSessionIds.delete(sessionId);
        set((state) => ({ sessions: state.sessions.filter((session) => session.id !== sessionId) }));
      }
      await loadSessionsInternal();
    },

    removeSession: (sessionId: string) => {
      optimisticSessionIds.delete(sessionId);
      set((state) => ({ sessions: state.sessions.filter((session) => session.id !== sessionId) }));
    },

    setDraft: (text: string) => set({ draft: text }),
  };
}
