/** Connection bootstrap and teardown; each action set owns its StrictMode single-flight map. */
import { getClient } from "../../client/pi-science-client";
import { appendRuntimeError, isMissingSessionError } from "../errors";
import { attachTurnArtifacts } from "../folding/artifacts";
import { emptyThread, resetTurnBuffer } from "../folding/state";
import { mergeHistoryWithLive } from "../folding/history-window";
import { threadFromMessages } from "../folding/history-conversion";
import { fetchPersistedTurnArtifacts } from "../turn-artifacts";
import { generations, turnState } from "../generations";
import { registerEventListener } from "../listening/subscription";
import { backfillSessionName } from "../naming";
import { recoverMissingSession } from "../recovery/missing-session";
import { reconcileAfterConnectionLoss, reconcileRestoredSession } from "../recovery/connection";
import { restoredActivityState, rememberRuntimeState, suppressConnectionRecovery } from "../recovery/runtime-state";
import { loadSessionsInternal } from "../sessions";
import type { RuntimeState } from "../types";
import type { GetState, SetState } from "./types";
import { connectionKey } from "./identity";
import { clearHistoryRequests } from "./history";
import { restorePendingPromptRequests } from "./prompt-delivery";

export function createConnectionActions(set: SetState, get: GetState): Pick<RuntimeState, "connect" | "disconnect"> {
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
    if (targetChanged) clearHistoryRequests();
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
        promptDeliveryNotice: null,
        turnLifecycle: "settled",
        model: null,
        thinking: null,
        contextTokens: null,
        mcpDiagnostics: [],
        contextWindow: null,
        contextPercent: null,
        compactionEnabled: true,
        compactionThresholdPercent: null,
        sessionStats: null,
        pendingInteraction: null,
        pendingInteractionQueue: [],
        pendingQuestionnaire: null,
      });
    }
    set({ status: "connecting", cwd, ...(state.cwd !== cwd ? { draftApproval: null } : {}) });
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
          turnLifecycle: "settled",
        });
        void loadSessionsInternal();
        return;
      }
      const targetSessionId = sessionId;
      set({ activeSessionId: targetSessionId });

      // Restore the sidebar metadata independently from the heavier session
      // activation below. On a direct page refresh the runtime store starts
      // empty; waiting for history + runtime state before listing sessions
      // leaves the sidebar showing the raw session id, and an early recovery
      // return can prevent the list (and its persisted title) from loading at
      // all. Stale-list protection in loadSessionsInternal keeps this safe
      // when the user switches workspaces/sessions while the request runs.
      const sessionsPromise = loadSessionsInternal(cwd);

      // Optimistic render: if we have a cached message snapshot for this
      // session, render it immediately so the user sees the conversation
      // while the network request is still in flight.
      const cachedMessages = client.getCachedMessages(targetSessionId, cwd);
      if (cachedMessages && cachedMessages.length > 0) {
        if (localMutationGeneration === generations.localMutation && generation === generations.connection) {
          // Cached snapshots are the tail page of a previous view. Show the
          // messages immediately; authoritative restore attaches artifacts.
          set({ thread: threadFromMessages(cachedMessages) });
        }
      }

      client.connect(targetSessionId, cwd);
      const [messagesResult, runtimeStateResult, sessionsResult, artifactsResult] = await Promise.allSettled([
        client.getMessagesPage(targetSessionId, cwd),
        client.getSessionState(targetSessionId, cwd),
        sessionsPromise,
        fetchPersistedTurnArtifacts(targetSessionId, cwd),
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
        // Keep the initial page as one continuous tail. A user-message index
        // can locate a target, but its cursor must never be merged into the
        // current history window as an arbitrary prepend.
        const historyPage = messagesResult.value;
        const turns = artifactsResult.status === "fulfilled" ? artifactsResult.value : [];
        nextState.thread = attachTurnArtifacts(
          mergeHistoryWithLive(
            threadFromMessages(historyPage.messages),
            get().thread,
          ),
          turns,
          { windowComplete: !historyPage.has_more },
        );
        nextState.historyCursor = historyPage.next_cursor;
        nextState.historyHasMore = historyPage.has_more;
        nextState.historySnapshotVersion = historyPage.snapshot_version;
      }
      if (sessionsResult.status === "fulfilled" && sessionsResult.value.length > 0) {
        nextState.sessions = sessionsResult.value;
      }
      if (runtimeStateResult.status === "fulfilled") {
        const runtimeState = runtimeStateResult.value;
        rememberRuntimeState(client, targetSessionId, cwd, runtimeState, connectActivityGeneration);
        if (!liveActivityArrived) {
          // History is presentation evidence; only REST busy/idle determines
          // availability when no newer live event owns the state.
          Object.assign(nextState, restoredActivityState(runtimeState, get(), nextState.thread ?? get().thread));
        }
        nextState.model = runtimeState.model ?? null;
        nextState.thinking = runtimeState.thinking ?? null;
        nextState.contextTokens = runtimeState.context_tokens ?? null;
        nextState.mcpDiagnostics = runtimeState.mcp_diagnostics ?? [];
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
          nextState.turnLifecycle = "recovering";
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
      void restorePendingPromptRequests(client, cwd, targetSessionId, get, set);

      // Conflicting busy/history snapshots and failed state reads are repaired
      // within bounded rounds; a final alone never unlocks the composer.
      if (!liveActivityArrived && nextState.working === true) {
        void reconcileRestoredSession(client, targetSessionId, cwd, generation, connectActivityGeneration, localMutationGeneration);
      }

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
        if (!liveActivityArrived && nextState.working !== true) {
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


  return {
    connect: connectDeduped,
    disconnect: () => {
      connectPromises.clear();
      clearHistoryRequests();
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
      set({ status: "offline", pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null });
    },
  };
}
