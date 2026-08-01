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
import { emptyThread, mergeHistoryWithLive, resetTurnBuffer, threadFromMessages } from "./event-fold";
import { generations, turnState } from "./generations";
import { registerEventListener } from "./listener";
import { applyPromptSessionName, backfillSessionName } from "./naming";
import { recoverMissingSession, reconcilePromptAfterLateStream } from "./recovery";
import { loadSessionsInternal, optimisticSessionIds } from "./sessions";
import type { RuntimeState } from "./types";

type SetState = StoreApi<RuntimeState>["setState"];
type GetState = StoreApi<RuntimeState>["getState"];

/** In-flight createSession calls per workspace, so concurrent first prompts
 *  (or a StrictMode double effect) share one backend session instead of
 *  racing two. Owned by `createNewSession`, which also clears each entry. */
const _createSessionPromises = new Map<string, Promise<string>>();

export function createRuntimeActions(set: SetState, get: GetState) {
  return {
    connect: async (cwd: string, sessionId?: string) => {
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
          set({ activeSessionId: null, thread: { blocks: [], index: {}, loaded: true }, status: "ready", working: false });
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
            set({ thread: threadFromMessages(cachedMessages) });
          }
        }

        client.connect(targetSessionId, cwd);
        const [messagesResult, runtimeStateResult] = await Promise.allSettled([
          client.getMessages(targetSessionId, cwd),
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
          nextState.thread = mergeHistoryWithLive(
            threadFromMessages(messagesResult.value),
            get().thread,
          );
        }
        if (runtimeStateResult.status === "fulfilled") {
          const runtimeState = runtimeStateResult.value;
          if (!liveActivityArrived) {
            nextState.working = runtimeState.is_streaming
              || runtimeState.is_compacting
              || runtimeState.pending_message_count > 0;
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
            nextState.status = "error";
            nextState.working = false;
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
        if (failure) appendRuntimeError(failure, targetSessionId, cwd);
      } catch (err) {
        if (generation !== generations.connection) return;
        console.error("Failed to connect session:", err);
        if (isMissingSessionError(err) && sessionId) {
          recoverMissingSession(sessionId, cwd, client);
          return;
        }
        appendRuntimeError(err, sessionId ?? null, cwd);
        set({ status: "error", working: false });
      }

      if (generation === generations.connection) void loadSessionsInternal();
    },

    disconnect: () => {
      ++generations.connection;
      ++generations.promptMonitor;
      const { client } = get();
      client?.disconnect();
      // Unmounting the conversation view does not stop the backend turn. Keep
      // the stop/busy state so workspace-level controls cannot race the active
      // agent merely because the user opened Files or Knowledge.
      set({ status: "offline", pendingInteraction: null });
    },

    sendPrompt: async (message: string): Promise<string | null> => {
      if (!message.trim()) return null;
      if (get().working) throw new Error("The current conversation is still running");
      let { activeSessionId, cwd } = get();
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
      try {
        await client.sendPrompt(activeSessionId, message, cwd);
        if (!streamWasOpen) {
          const monitorGeneration = ++generations.promptMonitor;
          void reconcilePromptAfterLateStream(
            client,
            activeSessionId,
            cwd,
            monitorGeneration,
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
          set({ working: false, status: "ready", pendingInteraction: null });
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
      set({ activeSessionId: result.id, status: "connecting", pendingInteraction: null });
      registerEventListener(client);
      client.connect(result.id, cwd);
      let messages: HistoryMessage[] = [];
      let historyError: unknown = null;
      try {
        messages = await client.getMessages(result.id, cwd);
      } catch (error) {
        // The clone already succeeded and changed the backend's active session.
        // Do not strand the UI on the parent route merely because the immediate
        // history read had a transient failure.
        historyError = error;
      }
      set({
        client,
        activeSessionId: result.id,
        thread: threadFromMessages(messages),
        working: false,
        sessions: [
          { id: result.id, cwd, name: "New Session" },
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
          working: false,
          status: "connecting",
          pendingInteraction: null,
        });
        optimisticSessionIds.add(result.id);
        client.connect(result.id, requestCwd);
        const newSession: SessionInfo = { id: result.id, cwd: requestCwd, name: "New Session" };
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
      const { cwd } = get();
      await getClient().deleteSession(sessionId, cwd);
      optimisticSessionIds.delete(sessionId);
      set((state) => ({ sessions: state.sessions.filter((session) => session.id !== sessionId) }));
      await loadSessionsInternal();
    },

    removeSession: (sessionId: string) => {
      optimisticSessionIds.delete(sessionId);
      set((state) => ({ sessions: state.sessions.filter((session) => session.id !== sessionId) }));
    },

    setDraft: (text: string) => set({ draft: text }),
  };
}
