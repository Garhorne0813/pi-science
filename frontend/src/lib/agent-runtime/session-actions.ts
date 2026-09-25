/** The store's action implementations. They are created once, when the store
 *  is created, and receive zustand's `set`/`get` directly — so action
 *  references stay stable across renders exactly as before. */

import type { StoreApi } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { ThreadBlock } from "../../types/thread";
import { activityPolicy } from "../conversation/activity-policy";
import {
  clearCachedMessages,
  getClient,
  moveSessionName,
  type HistoryMessage,
  type PromptRequestStatus,
  type SessionInfo,
} from "../client/pi-science-client";
import {
  localPromptRequests,
  promptContentDigest,
  removeLocalPromptRequest,
  saveLocalPromptRequest,
  updateLocalPromptRequest,
} from "../client/prompt-request-cache";
import { appendRuntimeError, isMissingSessionError } from "./errors";
import { attachTurnArtifacts, emptyThread, mergeHistoryWithLive, prependHistoryMessages, resetTurnBuffer, threadFromMessages } from "./event-fold";
import { fetchPersistedTurnArtifacts } from "./turn-artifacts";
import { mergeRecoveryHistoryWindow } from "./history-window-recovery";
import { generations, turnState } from "./generations";
import { registerEventListener, ensureTurnWatchdog } from "./listener";
import { applyPromptSessionName, backfillSessionName } from "./naming";
import { recoverMissingSession, reconcileAfterConnectionLoss, reconcilePromptAfterLateStream, rememberRuntimeState, suppressConnectionRecovery } from "./recovery";
import { loadMoreSessionsInternal, loadSessionsInternal, optimisticSessionIds } from "./sessions";
import { hasActivePendingInteraction, hasPendingInteractionData, type RuntimeState } from "./types";

type SetState = StoreApi<RuntimeState>["setState"];
type GetState = StoreApi<RuntimeState>["getState"];

/** In-flight createSession calls per workspace, so concurrent first prompts
 *  (or a StrictMode double effect) share one backend session instead of
 *  racing two. Owned by `createNewSession`, which also clears each entry. */
const _createSessionPromises = new Map<string, Promise<string>>();
const _historyPagePromises = new Map<string, Promise<number>>();
const _interactionResponsePromises = new Map<string, Promise<void>>();
function connectionKey(cwd: string, sessionId?: string): string { return `${cwd}\u0000${sessionId ?? ""}`; }
function historyPageKey(cwd: string, sessionId: string, before: string): string { return `${connectionKey(cwd, sessionId)}\u0000${before}`; }
function interactionResponseKey(cwd: string, sessionId: string, requestId: string): string { return `${connectionKey(cwd, sessionId)}\u0000${requestId}`; }

function applyPromptDeliveryStatus(
  get: GetState,
  set: SetState,
  clientMessageId: string,
  status: PromptRequestStatus,
): void {
  const current = get();
  const userBlocks = current.thread.blocks.filter((block): block is Extract<ThreadBlock, { kind: "user" }> => block.kind === "user");
  const target = userBlocks.find((block) => block.client_message_id === clientMessageId);
  const blocks = current.thread.blocks.map((block) => {
    if (block.kind !== "user" || block.client_message_id !== clientMessageId) return block;
    if (status.status === "persisted") {
      return { ...block, id: status.durable_message_id ?? block.id, deliveryStatus: undefined };
    }
    return {
      ...block,
      deliveryStatus: status.status === "rejected" ? "rejected" as const
        : status.status === "indeterminate" ? "indeterminate" as const
          : "pending" as const,
    };
  });
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  const notice = status.status === "indeterminate" ? "indeterminate"
    : status.status === "pending" || status.status === "accepted" ? "pending"
      : null;
  set({
    ...(target ? { thread: { ...current.thread, blocks, index } } : {}),
    ...(current.promptDeliveryNotice === null || current.promptDeliveryNotice !== notice
      ? { promptDeliveryNotice: notice }
      : {}),
  });
}

function updateOptimisticStatus(get: GetState, set: SetState, status: PromptRequestStatus): void {
  if (status.status === "persisted") removeLocalPromptRequest(status.client_message_id);
  else updateLocalPromptRequest(status.client_message_id, { status: status.status });
  applyPromptDeliveryStatus(get, set, status.client_message_id, status);
}

function forgetMissingPromptRequest(get: GetState, set: SetState, cwd: string, sessionId: string, clientMessageId: string): void {
  // A server restarted after accepting a prompt with an older protocol can
  // have the transcript but no request ledger. Stop polling that absent ID;
  // without an association, delivery cannot be confirmed from this endpoint.
  removeLocalPromptRequest(clientMessageId);
  const current = get();
  if (current.cwd === cwd && current.activeSessionId === sessionId) {
    applyPromptDeliveryStatus(get, set, clientMessageId, { status: "indeterminate", client_message_id: clientMessageId });
  }
}

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
      if (targetChanged) _historyPagePromises.clear();
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
          contextWindow: null,
          contextPercent: null,
          compactionEnabled: true,
          compactionThresholdPercent: null,
          sessionStats: null,
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
        void restorePendingPromptRequests(client, cwd, targetSessionId, get, set);

        // A refresh can restore a cached busy snapshot after the turn's final
        // SSE event has already passed. Keep checking the authoritative state
        // until it is idle, and resync history, instead of leaving Working
        // latched forever waiting for an event that cannot be replayed.
        if (!liveActivityArrived && nextState.working === true) {
          void reconcilePromptAfterLateStream(
            client,
            targetSessionId,
            cwd,
            generations.promptMonitor,
            undefined,
            1,
            connectActivityGeneration,
          );
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

  const restorePendingPromptRequests = async (
    client: ReturnType<typeof getClient>,
    cwd: string,
    sessionId: string,
    getState: GetState,
    setState: SetState,
  ) => {
    for (const record of localPromptRequests(cwd, sessionId)) {
      if (getState().cwd !== cwd || getState().activeSessionId !== sessionId) return;
      try {
        const status = await client.getPromptRequestStatus(sessionId, record.clientMessageId, cwd);
        if (getState().cwd !== cwd || getState().activeSessionId !== sessionId) return;
        updateOptimisticStatus(getState, setState, status);
        if (status.status === "pending" || status.status === "accepted") {
          void monitorPromptRequest(client, cwd, sessionId, record.clientMessageId);
        }
      } catch (error) {
        if ((error as Error & { status?: number }).status === 404) {
          forgetMissingPromptRequest(getState, setState, cwd, sessionId, record.clientMessageId);
          continue;
        }
        const status: PromptRequestStatus = {
          status: record.status === "persisted" ? "accepted" : record.status,
          client_message_id: record.clientMessageId,
        };
        applyPromptDeliveryStatus(getState, setState, record.clientMessageId, status);
      }
    }
  };

  const monitorPromptRequest = async (
    client: ReturnType<typeof getClient>,
    cwd: string,
    sessionId: string,
    clientMessageId: string,
  ) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const current = get();
      if (current.cwd !== cwd || current.activeSessionId !== sessionId) return;
      try {
        const status = await client.getPromptRequestStatus(sessionId, clientMessageId, cwd);
        updateOptimisticStatus(get, set, status);
        if (status.status === "persisted" || status.status === "rejected" || status.status === "indeterminate") return;
      } catch (error) {
        if ((error as Error & { status?: number }).status === 404) {
          forgetMissingPromptRequest(get, set, cwd, sessionId, clientMessageId);
          return;
        }
        // Keep the stored ID and current visual state; a later connect can
        // resume status reconciliation without copying prompt text locally.
      }
    }
  };

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
    connect: connectDeduped,

    disconnect: () => {
      connectPromises.clear();
      _historyPagePromises.clear();
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

    sendPrompt: async (message: string, requestedClientMessageId?: string): Promise<string | null> => {
      if (!message.trim()) return null;
      const initialState = get();
      if (initialState.working || initialState.pendingInteraction || initialState.pendingQuestionnaire) {
        throw new Error("The current conversation is still running");
      }
      let { activeSessionId, cwd } = initialState;
      const contentDigest = promptContentDigest(message);
      // A retry identity is meaningful only while the original session is
      // active; a new-session send always receives a fresh scoped ID.
      let clientMessageId = activeSessionId ? requestedClientMessageId : undefined;
      let recoveredStatus: PromptRequestStatus | null = null;
      // A normal composer submission always means a new user send, even when
      // its text matches an older pending/rejected send. Only an explicit
      // retry action supplies the prior ID.
      if (!clientMessageId) clientMessageId = uuidv4();
      else if (activeSessionId) {
        try {
          recoveredStatus = await getClient().getPromptRequestStatus(activeSessionId, clientMessageId, cwd);
          if (recoveredStatus.status === "persisted") {
            updateOptimisticStatus(get, set, recoveredStatus);
            return activeSessionId;
          }
        } catch (error) {
          if ((error as Error & { status?: number }).status === 404) removeLocalPromptRequest(clientMessageId);
          // Reusing the same ID is safe: the server ledger either recognizes
          // it and returns its state without dispatching again, or has no
          // record and can accept this first attempt.
        }
      }
      const requestId = clientMessageId;
      const alreadyPending = recoveredStatus !== null
        && ["pending", "accepted", "indeterminate"].includes(recoveredStatus.status);

      const threadBeforeSend = get().thread;
      const priorOptimistic = threadBeforeSend.blocks.find((block) => block.kind === "user" && block.client_message_id === requestId);
      const userBlock: ThreadBlock = priorOptimistic ?? {
        kind: "user",
        id: `user-${requestId}`,
        client_message_id: requestId,
        deliveryStatus: alreadyPending && recoveredStatus?.status === "indeterminate" ? "indeterminate" : "pending",
        text: message,
        ...(!activeSessionId ? { optimisticFirstInSession: true } : {}),
        timestamp: new Date().toISOString(),
      };
      if (!priorOptimistic) {
        const blocks = [...threadBeforeSend.blocks, userBlock];
        set({ thread: { blocks, index: { ...threadBeforeSend.index, [userBlock.id]: blocks.length - 1 }, loaded: true } });
      }
      saveLocalPromptRequest({
        cwd,
        sessionId: activeSessionId ?? "",
        clientMessageId: requestId,
        contentDigest,
        status: recoveredStatus?.status ?? "pending",
      });

      if (alreadyPending && activeSessionId) {
        updateOptimisticStatus(get, set, recoveredStatus!);
        return activeSessionId;
      }

      const thread = get().thread;
      const blocks = [...thread.blocks];
      const blockPosition = blocks.findIndex((block) => block.id === userBlock.id);
      if (priorOptimistic && priorOptimistic.kind === "user") {
        blocks[blockPosition] = { ...priorOptimistic, deliveryStatus: "pending" };
      }
      const index: Record<string, number> = {};
      blocks.forEach((block, position) => { index[block.id] = position; });
      set({ thread: { blocks, index, loaded: true }, working: true, turnLifecycle: "active", promptDeliveryNotice: null });
      if (!activeSessionId) {
        try {
          activeSessionId = await get().createNewSession();
          updateLocalPromptRequest(requestId, { sessionId: activeSessionId });
        } catch (error) {
          const current = get();
          if (current.cwd === cwd) set({ working: false, turnLifecycle: "failed" });
          throw error;
        }
      }
      const client = getClient();
      registerEventListener(client);
      if (!client.isConnectedTo(activeSessionId, cwd)) {
        set({ activeSessionId, client, status: "connecting" });
        client.connect(activeSessionId, cwd);
      }
      const activityGeneration = ++generations.activity;
      ++generations.localMutation;
      resetTurnBuffer();
      turnState.errored = false;
      set({ client, working: true, turnLifecycle: "active" });

      applyPromptSessionName(cwd, activeSessionId, message);
      // Baseline for the late-stream monitor: any assistant message persisted
      // after this instant belongs to the turn being sent. Captured before the
      // HTTP acknowledgement so a fast reply can never be attributed to a
      // previous turn (nor a slow monitor to the wrong prompt).
      const promptTimestamp = Date.now();
      try {
        const delivery = await client.sendPrompt(activeSessionId, message, requestId, cwd);
        updateOptimisticStatus(get, set, delivery);
        if (delivery.status !== "persisted" && delivery.status !== "rejected" && delivery.status !== "indeterminate") {
          void monitorPromptRequest(client, cwd, activeSessionId, requestId);
        }
        // Monitor every prompt, including those sent through an EventSource
        // that currently reports OPEN. Old-session sockets can be half-open:
        // the backend accepts and persists the turn while no live event reaches
        // the browser. REST reconciliation and a cursor-preserving reconnect
        // make that failure self-healing.
        const monitorGeneration = ++generations.promptMonitor;
        void reconcilePromptAfterLateStream(
          client,
          activeSessionId,
          cwd,
          monitorGeneration,
          promptTimestamp,
          undefined,
          activityGeneration,
        );
        return activeSessionId;
      } catch (error) {
        const metadata = error as Error & { code?: string; status?: number; deliveryState?: PromptRequestStatus["status"] };
        const failedDelivery: PromptRequestStatus = {
          status: metadata.deliveryState
            ?? (metadata.code === "timeout" || metadata.status === undefined || metadata.status >= 500 ? "indeterminate" : "rejected"),
          client_message_id: requestId,
          ...(metadata.code ? { error_code: metadata.code } : {}),
        };
        updateOptimisticStatus(get, set, failedDelivery);
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
          const ambiguousTransportFailure = metadata.code === "timeout"
            || (!metadata.code && (metadata.status === undefined || metadata.status >= 500));
          set({
            // Pi keeps its busy guard after an ambiguous prompt acknowledgement
            // until the user aborts. Keep Stop visible so the UI cannot submit a
            // second prompt against that still-running/unknown turn.
            working: ambiguousTransportFailure,
            turnLifecycle: ambiguousTransportFailure ? "active" : "failed",
            status: "error",
          });
        }
        throw error;
      }
    },

    abort: async () => {
      const { activeSessionId, cwd, turnLifecycle } = get();
      if (!activeSessionId) return;
      ++generations.activity;
      ++generations.localMutation;
      ++generations.promptMonitor;
      // Keep the run visibly in-flight until the server acknowledges the
      // stop. This prevents a second prompt from racing an unconfirmed abort.
      set({ working: true, turnLifecycle: "stopping", status: "ready" });
      try {
        await getClient().abort(activeSessionId, cwd);
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd && current.turnLifecycle === "stopping") {
          set({ working: false, turnLifecycle: "aborted", status: "ready", pendingInteraction: null, pendingQuestionnaire: null });
        }
      } catch (error) {
        const current = get();
        if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
          appendRuntimeError(error, activeSessionId, cwd);
          const code = error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
          if (code === "runtime_evicted") {
            set({ working: false, turnLifecycle: "aborted", status: "ready", pendingInteraction: null, pendingQuestionnaire: null });
            return;
          }
          try {
            const runtimeState = await getClient().getSessionState(activeSessionId, cwd);
            const stillCurrent = get();
            if (stillCurrent.activeSessionId === activeSessionId && stillCurrent.cwd === cwd) {
              const busy = runtimeState.is_streaming
                || runtimeState.is_compacting
                || runtimeState.pending_message_count > 0;
              set({
                working: busy,
                turnLifecycle: busy ? "active" : "aborted",
                status: "error",
                ...(busy ? {} : { pendingInteraction: null, pendingQuestionnaire: null }),
              });
            }
          } catch {
            const stillCurrent = get();
            if (stillCurrent.activeSessionId === activeSessionId && stillCurrent.cwd === cwd) {
              set({ working: true, turnLifecycle: turnLifecycle === "settled" ? "active" : turnLifecycle, status: "error" });
            }
          }
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

    respondToInteraction: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
      const { activeSessionId, cwd, pendingInteraction } = get();
      if (!activeSessionId || !pendingInteraction) return Promise.resolve();
      const requestId = pendingInteraction.requestId;
      const key = interactionResponseKey(cwd, activeSessionId, requestId);
      const existing = _interactionResponsePromises.get(key);
      if (existing) return existing;
      const operation = (async () => {
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
            const resolvedBlocks = current.thread.blocks.map((block) => {
              if (block.kind !== "tool" || activityPolicy(block).plane !== "interaction") return block;
              // Resolve only the block this request is tied to. Without a
              // toolCallId the requestId itself is the only trustworthy link;
              // batch-resolving every interaction block would retire prompts the
              // user has not answered.
              const matches = pendingInteraction.toolCallId
                ? block.callId === pendingInteraction.toolCallId
                : block.callId === requestId;
              return matches ? { ...block, interactionResolved: true } : block;
            });
            const thread = resolvedBlocks.some((block, index) => block !== current.thread.blocks[index])
              ? { ...current.thread, blocks: resolvedBlocks, index: Object.fromEntries(resolvedBlocks.map((block, index) => [block.id, index])) }
              : current.thread;
            set({ pendingInteraction: null, working: true, turnLifecycle: "active", status: "ready", thread });
            ensureTurnWatchdog();
          }
        } catch (error) {
          const current = get();
          if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
            appendRuntimeError(error, activeSessionId, cwd);
            set({ status: "error" });
          }
          throw error;
        }
      })();
      _interactionResponsePromises.set(key, operation);
      return operation.finally(() => {
        if (_interactionResponsePromises.get(key) === operation) _interactionResponsePromises.delete(key);
      });
    },

    loadSessions: async (cwd?: string) => {
      return loadSessionsInternal(cwd);
    },

    loadMoreSessions: async () => loadMoreSessionsInternal(),

    loadSession: async (sessionId: string) => {
      const cwd = get().cwd;
      await get().connect(cwd, sessionId);
    },

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
      let artifactTurns = [] as Awaited<ReturnType<typeof fetchPersistedTurnArtifacts>>;
      const [historyResult, artifactsResult] = await Promise.allSettled([
        client.getMessagesPage(result.id, cwd),
        fetchPersistedTurnArtifacts(result.id, cwd),
      ]);
      if (historyResult.status === "fulfilled") history = historyResult.value;
      else historyError = historyResult.reason;
      if (artifactsResult.status === "fulfilled") artifactTurns = artifactsResult.value;
      const latest = get();
      if (latest.cwd !== cwd || latest.activeSessionId !== result.id) return result.id;
      set({
        client,
        activeSessionId: result.id,
        thread: attachTurnArtifacts(threadFromMessages(history.messages), artifactTurns, { windowComplete: !history.has_more }),
        historyCursor: history.next_cursor,
        historyHasMore: history.has_more,
        historyLoading: false,
        historySnapshotVersion: history.snapshot_version,
        working: false,
        turnLifecycle: "settled",
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
        const live = get();
        set({
          client,
          activeSessionId: result.id,
          thread: live.thread.blocks.length > 0 ? live.thread : emptyThread(),
          historyCursor: null,
          historyHasMore: false,
          historyLoading: false,
          historySnapshotVersion: "",
          // sendPrompt creates this session lazily while its prompt is already
          // in flight, so keep the live turn state. Resetting to settled here
          // renders the running turn as "Completed" for the whole
          // session-creation round trip, until sendPrompt re-arms it.
          working: live.working,
          turnLifecycle: live.turnLifecycle,
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
            turnLifecycle: "failed",
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
