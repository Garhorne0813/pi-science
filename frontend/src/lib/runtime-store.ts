/** Agent Runtime Store — manages pi agent session state.
 *  Rewrite of open-science's useRuntimeStore for the pi-science backend. */

import { create } from "zustand";
import type { ThreadBlock } from "../types/thread";
import {
  PiScienceClient,
  getClient,
  getSessionName,
  setSessionName,
  type PiScienceEvent,
  type SessionInfo,
  type HistoryMessage,
} from "./pi-science-client";

export interface PendingInteraction {
  requestId: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: Array<string | { label?: string; value?: string }>;
  placeholder?: string;
  prefill?: string;
}

// ── Thread state types ──

interface Thread {
  blocks: ThreadBlock[];
  /** Map from block id to index in blocks array */
  index: Record<string, number>;
  loaded: boolean;
}

export interface RuntimeState {
  // Connection
  status: "connecting" | "ready" | "error" | "offline";
  client: PiScienceClient | null;

  // Session
  sessions: SessionInfo[];
  activeSessionId: string | null;
  cwd: string;

  // Thread
  thread: Thread;
  working: boolean;
  model: string | null;
  thinking: string | null;
  pendingInteraction: PendingInteraction | null;

  // Draft (unsent message)
  draft: string;

  // Actions
  connect: (cwd: string, sessionId?: string) => Promise<void>;
  disconnect: () => void;
  sendPrompt: (message: string) => Promise<void>;
  abort: () => Promise<void>;
  setModel: (model: string, thinking?: string) => Promise<string | null>;
  respondToInteraction: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => Promise<void>;
  loadSessions: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  forkSession: (sessionId: string) => Promise<string>;
  createNewSession: () => Promise<string>;
  setDraft: (text: string) => void;
}

function emptyThread(): Thread {
  return { blocks: [], index: {}, loaded: false };
}

// ── Event folding (ported from open-science foldEvent) ──

let _textBuffer = ""; // Accumulates text deltas
let _currentTurnId = ""; // Unique ID per agent turn, resets on agent_start
const _createSessionPromises = new Map<string, Promise<string>>();
let _connectionGeneration = 0;
let _activityGeneration = 0;
let _localMutationGeneration = 0;
let _promptMonitorGeneration = 0;
let _listenerClient: PiScienceClient | null = null;
let _listenerUnsubscribe: (() => void) | null = null;
let _turnErrored = false;
let _errorSequence = 0;

function foldEvent(state: Thread, event: PiScienceEvent): Thread {
  const blocks = [...state.blocks];
  const index = { ...state.index };

  switch (event.type) {
    case "text.updated": {
      const eventPartId = typeof event.partId === "string" && event.partId
        ? event.partId
        : null;
      if (eventPartId && _currentTurnId && eventPartId !== _currentTurnId) {
        const previousIdx = index[_currentTurnId];
        const previous = previousIdx !== undefined ? blocks[previousIdx] : undefined;
        if (previous?.kind === "agent" && previous.partial) {
          blocks[previousIdx] = { ...previous, partial: false };
        }
        _textBuffer = "";
        _currentTurnId = eventPartId;
      } else if (eventPartId && !_currentTurnId) {
        _currentTurnId = eventPartId;
      }
      _textBuffer += (event.text as string) || "";
      // Skip initial empty text events that create placeholder agent blocks
      // (DeepSeek sends empty text.updated between tool calls before real text)
      const hasText = _textBuffer.trim().length > 0;
      if (!hasText) break;  // Don't create/update agent block for empty text
      const turnId = _currentTurnId || `agent-${Date.now()}`;
      if (!_currentTurnId) _currentTurnId = turnId;
      const blockId = turnId;
      const existingIdx = index[blockId];
      if (existingIdx !== undefined) {
        const hasToolsAfter = blocks.slice(existingIdx + 1).some((b) => b.kind === "tool");
        if (hasToolsAfter) {
          // Pre-tool text → finalize old block; redirect turn ID to new post-tool block
          const oldBlock = blocks[existingIdx];
          if (oldBlock.kind === "agent") {
            blocks[existingIdx] = { ...oldBlock, partial: false };
          }
          _textBuffer = (event.text as string) || "";
          // Update turn ID so subsequent events find this post-tool block
          _currentTurnId = turnId + "-post";
          index[turnId + "-post"] = blocks.length;
          blocks.push({
            kind: "agent",
            id: turnId + "-post",
            parts: [{ id: turnId + "-post", text: _textBuffer }],
            partial: true,
          } as ThreadBlock);
        } else {
          blocks[existingIdx] = {
            ...blocks[existingIdx],
            kind: "agent",
            parts: [{ id: turnId, text: _textBuffer }],
            partial: true,
          } as ThreadBlock;
        }
      } else {
        // New block for this turn
        const block: ThreadBlock = {
          kind: "agent",
          id: blockId,
          parts: [{ id: turnId, text: _textBuffer }],
          partial: true,
        };
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      break;
    }

    case "tool.updated": {
      const callId = event.callId as string;
      const blockId = `tool-${callId}`;
      const existingIdx = index[blockId];
      const previous = existingIdx !== undefined && blocks[existingIdx].kind === "tool"
        ? blocks[existingIdx]
        : undefined;
      const block: ThreadBlock = {
        kind: "tool",
        id: blockId,
        callId,
        tool: (event.tool as string) || previous?.tool || "unknown",
        status: event.status as ThreadBlock extends { status: infer S } ? S : never,
        title: (event.title as string | undefined) ?? previous?.title,
        input: (event.input as Record<string, unknown> | undefined) ?? previous?.input,
        output: (event.output as string | undefined) ?? previous?.output,
        partialOutput: (event.partialOutput as string | undefined) ?? previous?.partialOutput,
        diff: (event.diff as string | undefined) ?? previous?.diff,
        startedAt: (event.startedAt as string | undefined) ?? previous?.startedAt,
        endedAt: (event.endedAt as string | undefined) ?? previous?.endedAt,
        childSessionId: (event.childSessionId as string | undefined) ?? previous?.childSessionId,
      };
      if (existingIdx !== undefined) {
        blocks[existingIdx] = block;
      } else {
        // Push to end — the agent block moves to end on each text.updated,
        // so tools naturally appear before the current agent text.
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      break;
    }

    case "session.idle": {
      _textBuffer = "";
      _currentTurnId = "";  // Reset for next turn
      // Mark last agent block as not partial
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.kind === "agent" && block.partial) {
          blocks[i] = { ...block, partial: false };
          break;
        }
      }
      break;
    }

    case "error": {
      const msg = (event.message as string) || "Unknown error";
      // If we already have a partial agent block without text, replace it with the error
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.kind === "agent" && lastBlock.partial && !lastBlock.parts?.[0]?.text) {
        blocks[blocks.length - 1] = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: msg,
          level: "error",
        } as ThreadBlock;
        index[blocks[blocks.length - 1].id] = blocks.length - 1;
      } else {
        const errBlock: ThreadBlock = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: msg,
          level: "error",
        };
        index[errBlock.id] = blocks.length;
        blocks.push(errBlock);
      }
      break;
    }
  }

  return { blocks, index, loaded: true };
}

// ── Helpers ──

async function loadSessionsInternal() {
  const state = useRuntimeStore.getState();
  const requestedCwd = state.cwd;
  try {
    const client = getClient();
    const fromDisk = await client.listSessions(requestedCwd);
    const current = useRuntimeStore.getState();
    if (current.cwd !== requestedCwd) return;
    // Inject names from localStorage
    const named = fromDisk.map((s: SessionInfo) => ({
      ...s,
      name: s.name || getSessionName(s.id) || undefined,
    }));
    // Preserve only the active, newly-created optimistic entry. Treating every
    // disk-missing item as optimistic resurrects sessions after deletion.
    const diskIds = new Set(named.map((s: SessionInfo) => s.id));
    const optimistic = current.sessions.filter((session: SessionInfo) => (
      !diskIds.has(session.id)
      && session.id === current.activeSessionId
      && !session.created_at
      && !session.updated_at
    ));
    const merged = [...optimistic, ...named];
    useRuntimeStore.setState({ sessions: merged.slice(0, 50) });
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}

async function resyncCompletedHistory(sessionId: string, cwd: string): Promise<void> {
  const generation = _connectionGeneration;
  try {
    const messages = await getClient().getMessages(sessionId, cwd);
    const current = useRuntimeStore.getState();
    if (
      generation !== _connectionGeneration
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || current.working
    ) return;
    useRuntimeStore.setState({ thread: threadFromMessages(messages) });
  } catch (error) {
    console.error("Failed to resynchronize completed conversation:", error);
  }
}

async function reconcileWorkingState(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
): Promise<void> {
  try {
    const runtimeState = await client.getSessionState(sessionId, cwd);
    const current = useRuntimeStore.getState();
    if (
      connectionGeneration !== _connectionGeneration
      || activityGeneration !== _activityGeneration
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
    ) return;
    useRuntimeStore.setState({
      working: runtimeState.is_streaming
        || runtimeState.is_compacting
        || runtimeState.pending_message_count > 0,
      model: runtimeState.model ?? current.model,
      thinking: runtimeState.thinking ?? current.thinking,
    });
  } catch {
    // Keep the current working state. A stream transport failure must not
    // re-enable Send while the backend may still be executing the turn.
  }
}

async function reconcilePromptAfterLateStream(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  monitorGeneration: number,
): Promise<void> {
  let ticks = 0;
  while (true) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    const current = useRuntimeStore.getState();
    if (
      monitorGeneration !== _promptMonitorGeneration
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || !current.working
    ) return;

    ticks += 1;
    const streamOpen = client.isOpenTo(sessionId, cwd);
    if (!streamOpen && ticks % 4 !== 0) continue;

    try {
      const runtimeState = await client.getSessionState(sessionId, cwd);
      const latest = useRuntimeStore.getState();
      if (
        monitorGeneration !== _promptMonitorGeneration
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
        || !latest.working
      ) return;
      const runtimeWorking = runtimeState.is_streaming
        || runtimeState.is_compacting
        || runtimeState.pending_message_count > 0;
      if (!runtimeWorking) {
        ++_activityGeneration;
        useRuntimeStore.setState({ working: false, status: "ready", pendingInteraction: null });
        void resyncCompletedHistory(sessionId, cwd);
        void loadSessionsInternal();
        return;
      }
      // Once the stream is open while the runtime is authoritatively busy, its
      // subscriber is attached and will receive the eventual terminal event.
      if (streamOpen) return;
    } catch {
      // Keep polling while the stream is still connecting. Transport failure
      // handling remains responsible for the visible connection status.
    }
  }
}

function _registerEventListener(client: PiScienceClient) {
  if (_listenerClient === client && _listenerUnsubscribe) return;
  _listenerUnsubscribe?.();
  _listenerClient = client;
  _listenerUnsubscribe = client.onEvent((event) => {
    const state = useRuntimeStore.getState();
    if (event.sessionId && state.activeSessionId && event.sessionId !== state.activeSessionId) {
      return;
    }

    if (event.type === "connection.connecting" || event.type === "connection.reconnecting") {
      useRuntimeStore.setState({ status: "connecting" });
      return;
    }
    if (event.type === "connection.open") {
      useRuntimeStore.setState({ status: "ready" });
      return;
    }
    if (event.type === "connection.error") {
      useRuntimeStore.setState({ status: "error" });
      appendRuntimeError(
        new Error(String(event.message || "Conversation stream closed")),
        state.activeSessionId,
        state.cwd,
      );
      if (state.activeSessionId) {
        void reconcileWorkingState(
          client,
          state.activeSessionId,
          state.cwd,
          _connectionGeneration,
          _activityGeneration,
        );
      }
      return;
    }
    if (event.type === "connection.closed") {
      if (state.status !== "offline") useRuntimeStore.setState({ status: "offline" });
      return;
    }

    if (
      event.type === "error"
      && event.terminal === true
      && isMissingSessionError(event.message)
    ) {
      recoverMissingSession(String(event.sessionId || state.activeSessionId || ""), state.cwd, client);
      return;
    }

    if (event.type === "permission.asked" || event.type === "question.asked") {
      ++_activityGeneration;
      const method = event.type === "permission.asked"
        ? "confirm"
        : (event.method as PendingInteraction["method"]) || "input";
      useRuntimeStore.setState({
        working: true,
        status: "ready",
        pendingInteraction: {
          requestId: String(event.requestId || ""),
          method,
          title: String(event.title || (method === "confirm" ? "Confirmation" : "Question")),
          message: String(event.message || ""),
          options: Array.isArray(event.options) ? event.options as PendingInteraction["options"] : [],
          placeholder: String(event.placeholder || ""),
          prefill: String(event.prefill || ""),
        },
      });
      return;
    }

    if (event.type === "agent_start") {
      ++_activityGeneration;
      _textBuffer = "";
      _currentTurnId = "";
      _turnErrored = false;
      useRuntimeStore.setState({ working: true, status: "ready" });
    } else if (event.type === "text.updated" || event.type === "tool.updated") {
      ++_activityGeneration;
      _turnErrored = false;
      useRuntimeStore.setState({ working: true, status: "ready" });
    } else if (event.type === "agent_settled" || event.type === "session.idle") {
      ++_activityGeneration;
      const successful = !_turnErrored;
      useRuntimeStore.setState({
        working: false,
        status: successful ? "ready" : "error",
        pendingInteraction: null,
      });
      if (successful && state.activeSessionId && event.handledWithoutTurn !== true) {
        void resyncCompletedHistory(state.activeSessionId, state.cwd);
      }
      void loadSessionsInternal();
    } else if (event.type === "error") {
      ++_activityGeneration;
      if (event.recoverable === true) {
        useRuntimeStore.setState({ status: "connecting" });
      } else {
        _turnErrored = true;
        useRuntimeStore.setState({ working: false, status: "error", pendingInteraction: null });
      }
    }

    const current = useRuntimeStore.getState();
    const newThread = foldEvent(current.thread, event);
    if (newThread.blocks !== current.thread.blocks) {
      useRuntimeStore.setState({ thread: newThread });
    }
  });
}

// ── Store ──

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  status: "offline",
  client: null,
  sessions: [],
  activeSessionId: null,
  cwd: ".",
  thread: emptyThread(),
  working: false,
  model: null,
  thinking: null,
  pendingInteraction: null,
  draft: "",

  connect: async (cwd: string, sessionId?: string) => {
    const existingState = get();
    if (
      existingState.cwd === cwd
      && existingState.working
      && existingState.activeSessionId
      && existingState.activeSessionId !== (sessionId ?? null)
    ) {
      // Browser history/direct URL edits can bypass the disabled sidebar. Do
      // not detach the only frontend control surface from a turn that is still
      // running in this workspace.
      return;
    }
    const generation = ++_connectionGeneration;
    ++_promptMonitorGeneration;
    ++_activityGeneration;
    const connectActivityGeneration = _activityGeneration;
    const localMutationGeneration = _localMutationGeneration;
    _textBuffer = "";
    _currentTurnId = "";
    _turnErrored = false;
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
        pendingInteraction: null,
      });
    }
    set({ status: "connecting", cwd });
    const client = getClient();
    _registerEventListener(client);
    set({ client });

    try {
      if (!sessionId) {
        // A workspace landing page is not itself a conversation. Creating
        // lazily on the first send/new-session action avoids StrictMode ghost
        // sessions and empty records created merely by navigation.
        client.disconnect();
        set({ activeSessionId: null, thread: emptyThread(), status: "ready", working: false });
        void loadSessionsInternal();
        return;
      }
      const targetSessionId = sessionId;
      set({ activeSessionId: targetSessionId });

      client.connect(targetSessionId, cwd);
      const [messagesResult, runtimeStateResult] = await Promise.allSettled([
        client.getMessages(targetSessionId, cwd),
        client.getSessionState(targetSessionId, cwd),
      ]);
      if (generation !== _connectionGeneration) return;
      // A prompt/model action may have started while the initial history/state
      // reads were in flight. Never overwrite its optimistic blocks or status
      // with the older snapshot that just arrived.
      if (localMutationGeneration !== _localMutationGeneration) return;

      const nextState: Partial<RuntimeState> = {};
      // History/state requests race the SSE connection. If live events arrived
      // while those requests were in flight, their reducer state is newer than
      // either HTTP snapshot and must not be overwritten by a stale
      // `is_streaming: false` (or a transient state-read error).
      const liveActivityArrived = _activityGeneration !== connectActivityGeneration;
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
      } else {
        if (!liveActivityArrived) {
          nextState.status = "error";
          nextState.working = false;
        }
      }
      set(nextState);

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
      if (generation !== _connectionGeneration) return;
      console.error("Failed to connect session:", err);
      if (isMissingSessionError(err) && sessionId) {
        recoverMissingSession(sessionId, cwd, client);
        return;
      }
      appendRuntimeError(err, sessionId ?? null, cwd);
      set({ status: "error", working: false });
    }

    if (generation === _connectionGeneration) void loadSessionsInternal();
  },

  disconnect: () => {
    ++_connectionGeneration;
    ++_promptMonitorGeneration;
    const { client } = get();
    client?.disconnect();
    // Unmounting the conversation view does not stop the backend turn. Keep
    // the stop/busy state so workspace-level controls cannot race the active
    // agent merely because the user opened Files or Knowledge.
    set({ status: "offline", pendingInteraction: null });
  },

  sendPrompt: async (message: string) => {
    if (!message.trim()) return;
    if (get().working) throw new Error("The current conversation is still running");
    let { activeSessionId, cwd } = get();
    if (!activeSessionId) {
      activeSessionId = await get().createNewSession();
    }
    const client = getClient();
    _registerEventListener(client);
    if (!client.isConnectedTo(activeSessionId, cwd)) {
      set({ activeSessionId, client, status: "connecting" });
      client.connect(activeSessionId, cwd);
    }
    const streamWasOpen = client.isOpenTo(activeSessionId, cwd);

    const activityGeneration = ++_activityGeneration;
    ++_localMutationGeneration;
    _textBuffer = "";
    _currentTurnId = "";
    _turnErrored = false;
    const thread = get().thread;
    const userBlock: ThreadBlock = {
      kind: "user",
      id: `user-${Date.now()}`,
      text: message,
    };
    const blocks = [...thread.blocks, userBlock];
    const index = { ...thread.index, [userBlock.id]: blocks.length - 1 };
    set({ thread: { blocks, index, loaded: true }, working: true, client });

    // Use first user message as session name
    if (!getSessionName(activeSessionId)) {
      setSessionName(activeSessionId, message);
    }
    try {
      await client.sendPrompt(activeSessionId, message, cwd);
      if (!streamWasOpen) {
        const monitorGeneration = ++_promptMonitorGeneration;
        void reconcilePromptAfterLateStream(
          client,
          activeSessionId,
          cwd,
          monitorGeneration,
        );
      }
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
        if (activityGeneration !== _activityGeneration && current.working) return;
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
            return;
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
    ++_activityGeneration;
    ++_localMutationGeneration;
    ++_promptMonitorGeneration;
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
    const activityGeneration = ++_activityGeneration;
    ++_localMutationGeneration;
    const client = getClient();
    _registerEventListener(client);
    try {
      const result = await client.setModel(activeSessionId, model, cwd, thinking);
      const nextSessionId = result.id || activeSessionId;
      const current = get();
      if (
        activityGeneration === _activityGeneration
        && current.activeSessionId === activeSessionId
        && current.cwd === cwd
      ) {
        if (nextSessionId !== activeSessionId) {
          ++_connectionGeneration;
          ++_activityGeneration;
          ++_localMutationGeneration;
          _textBuffer = "";
          _currentTurnId = "";
          _turnErrored = false;
          client.connect(nextSessionId, cwd);
        }
        set({
          client,
          activeSessionId: nextSessionId,
          sessions: nextSessionId === activeSessionId
            ? current.sessions
            : [
                { id: nextSessionId, cwd, name: "New Session" },
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

  respondToInteraction: async (response) => {
    const { activeSessionId, cwd, pendingInteraction } = get();
    if (!activeSessionId || !pendingInteraction) return;
    const requestId = pendingInteraction.requestId;
    ++_activityGeneration;
    ++_localMutationGeneration;
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

  loadSessions: async () => {
    await loadSessionsInternal();
  },

  loadSession: async (sessionId: string) => {
    const cwd = get().cwd;
    await get().connect(cwd, sessionId);
  },

  forkSession: async (sessionId: string) => {
    const { cwd, working } = get();
    if (working) throw new Error("Stop the current task before forking this conversation");
    const client = getClient();
    const result = await client.forkSession(sessionId, cwd);
    if (get().cwd !== cwd) {
      throw new Error("Workspace changed while the conversation was being forked");
    }
    ++_connectionGeneration;
    ++_activityGeneration;
    ++_localMutationGeneration;
    set({ activeSessionId: result.id, status: "connecting", pendingInteraction: null });
    _registerEventListener(client);
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
    if (get().working) throw new Error("Stop the current task before creating a new conversation");
    const previousActiveSessionId = get().activeSessionId;
    const previousHadContent = get().thread.blocks.some((block) => (
      block.kind === "user" || block.kind === "agent" || block.kind === "tool"
    ));

    const promise = (async () => {
      const client = getClient();
      const result = await client.createSession(requestCwd);
      if (get().cwd !== requestCwd) {
        throw new Error("Workspace changed while the conversation was being created");
      }
      ++_connectionGeneration;
      ++_activityGeneration;
      ++_localMutationGeneration;
      _textBuffer = "";
      _currentTurnId = "";
      _turnErrored = false;
      _registerEventListener(client);
      set({
        client,
        activeSessionId: result.id,
        thread: emptyThread(),
        working: false,
        status: "connecting",
        pendingInteraction: null,
      });
      client.connect(result.id, requestCwd);
      const newSession: SessionInfo = { id: result.id, cwd: requestCwd, name: "New Session" };
      set((s) => ({
        // Pi cannot persist more than the currently active blank conversation.
        // Remove older optimistic blanks so the sidebar never offers an ID
        // that disappeared when the runtime created this new empty session.
        sessions: [
          newSession,
          ...s.sessions.filter((item) => (
            item.id !== result.id
            && (
              item.created_at
              || item.updated_at
              || (previousHadContent && item.id === previousActiveSessionId)
            )
          )),
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

  setDraft: (text: string) => set({ draft: text }),
}));

// ── Helpers ──

function appendRuntimeError(
  error: unknown,
  sessionId?: string | null,
  cwd?: string,
): void {
  const current = useRuntimeStore.getState();
  if (sessionId && current.activeSessionId !== sessionId) return;
  if (cwd && current.cwd !== cwd) return;
  const errorBlock: ThreadBlock = {
    kind: "status-line",
    id: `error-${Date.now()}-${++_errorSequence}`,
    text: error instanceof Error ? error.message : "Unable to complete the request",
    level: "error",
  };
  const nextBlocks = [...current.thread.blocks, errorBlock];
  useRuntimeStore.setState({
    thread: {
      blocks: nextBlocks,
      index: { ...current.thread.index, [errorBlock.id]: nextBlocks.length - 1 },
      loaded: true,
    },
  });
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.toLowerCase().includes("session not found in this workspace");
}

/**
 * A stale session can survive in a URL or local storage after its JSONL record
 * was removed. Treat that as a recoverable navigation state, not a failed
 * conversation: detach the stream, clear the invalid thread, and leave the
 * workspace on a ready blank composer so the next prompt creates a session.
 */
function recoverMissingSession(sessionId: string, cwd: string, client?: PiScienceClient): void {
  const current = useRuntimeStore.getState();
  if (current.cwd !== cwd || (current.activeSessionId !== null && current.activeSessionId !== sessionId)) {
    return;
  }

  ++_connectionGeneration;
  ++_promptMonitorGeneration;
  ++_activityGeneration;
  ++_localMutationGeneration;
  _textBuffer = "";
  _currentTurnId = "";
  _turnErrored = false;
  client?.disconnect();
  useRuntimeStore.setState({
    activeSessionId: null,
    sessions: current.sessions.filter((session) => session.id !== sessionId),
    thread: emptyThread(),
    working: false,
    status: "ready",
    model: null,
    thinking: null,
    pendingInteraction: null,
  });
}

function threadFromMessages(messages: HistoryMessage[]): Thread {
  const blocks = convertHistoryToBlocks(messages);
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

function mergeHistoryWithLive(history: Thread, live: Thread): Thread {
  if (live.blocks.length === 0) return history;
  const ids = new Set(history.blocks.map((block) => block.id));
  const toolCallIds = new Set(
    history.blocks
      .filter((block): block is Extract<ThreadBlock, { kind: "tool" }> => block.kind === "tool")
      .map((block) => block.callId),
  );
  const blocks = [...history.blocks];
  for (const block of live.blocks) {
    if (ids.has(block.id)) continue;
    if (block.kind === "tool" && toolCallIds.has(block.callId)) continue;
    blocks.push(block);
    ids.add(block.id);
    if (block.kind === "tool") toolCallIds.add(block.callId);
  }
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

export function convertHistoryToBlocks(messages: HistoryMessage[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  const toolNames = new Map<string, string>();

  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) blocks.push({ kind: "user", id: msg.id, text });
    } else if (role === "assistant") {
      for (const content of msg.content) {
        if (content.type !== "toolCall") continue;
        const callId = String(content.id || "");
        if (callId) {
          toolNames.set(callId, String(content.name || content.tool || "unknown"));
        }
      }
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) {
        blocks.push({ kind: "agent", id: msg.id, parts: [{ id: msg.id, text }] });
      }
    } else if (role === "toolResult") {
      const callId = msg.toolCallId || msg.id;
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      blocks.push({
        kind: "tool",
        id: `tool-${callId}`,
        callId,
        tool: msg.toolName || toolNames.get(callId) || "unknown",
        status: msg.isError ? "error" as const : "done" as const,
        output: text || undefined,
      });
    }
  }
  return blocks;
}
