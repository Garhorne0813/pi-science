/** Agent Runtime Store — manages pi agent session state.
 *  Rewrite of open-science's useRuntimeStore for the pi-science backend. */

import { create } from "zustand";
import type { ThreadBlock } from "../types/thread";
import {
  PiScienceClient,
  getClient,
  type PiScienceEvent,
  type SessionInfo,
  type HistoryMessage,
} from "./pi-science-client";

// ── Thread state types ──

interface Thread {
  blocks: ThreadBlock[];
  /** Map from block id to index in blocks array */
  index: Record<string, number>;
  loaded: boolean;
}

interface RuntimeState {
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

  // Draft (unsent message)
  draft: string;

  // Actions
  connect: (cwd: string, sessionId?: string) => Promise<void>;
  disconnect: () => void;
  sendPrompt: (message: string) => Promise<void>;
  abort: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
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

function foldEvent(state: Thread, event: PiScienceEvent): Thread {
  const blocks = [...state.blocks];
  const index = { ...state.index };

  switch (event.type) {
    case "text.updated": {
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
            (oldBlock as any).partial = false;
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
      const block: ThreadBlock = {
        kind: "tool",
        id: blockId,
        callId,
        tool: event.tool as string,
        status: event.status as ThreadBlock extends { status: infer S } ? S : never,
        title: event.title as string | undefined,
        input: event.input as Record<string, unknown> | undefined,
        output: event.output as string | undefined,
        partialOutput: event.partialOutput as string | undefined,
        diff: event.diff as string | undefined,
        startedAt: event.startedAt as string | undefined,
        endedAt: event.endedAt as string | undefined,
        childSessionId: event.childSessionId as string | undefined,
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
        if (blocks[i].kind === "agent" && blocks[i].partial) {
          blocks[i] = { ...blocks[i], partial: false } as ThreadBlock;
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
  try {
    const client = getClient();
    const fromDisk = await client.listSessions(state.cwd);
    // Inject names from localStorage
    const { getSessionName } = await import("./pi-science-client");
    const named = fromDisk.map((s: SessionInfo) => ({
      ...s,
      name: s.name || getSessionName(s.id) || undefined,
    }));
    // Merge: optimistic entries first (new session on top), then disk, dedupe by id
    const diskIds = new Set(named.map((s: SessionInfo) => s.id));
    const optimistic = state.sessions.filter((s: SessionInfo) => !diskIds.has(s.id));
    const merged = [...optimistic, ...named];
    useRuntimeStore.setState({ sessions: merged.slice(0, 50) });
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}

function _registerEventListener(client: PiScienceClient) {
  client.onEvent((event) => {
    const state = useRuntimeStore.getState();
    if (event.type === "agent_start") {
      _textBuffer = "";
      _currentTurnId = "";
      state.working !== true && useRuntimeStore.setState({ working: true });
    } else if (event.type === "agent_settled" || event.type === "session.idle") {
      state.working !== false && useRuntimeStore.setState({ working: false });
      loadSessionsInternal();
    }

    const newThread = foldEvent(state.thread, event);
    if (newThread.blocks !== state.thread.blocks) {
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
  draft: "",

  connect: async (cwd: string, sessionId?: string) => {
    _textBuffer = "";  // Reset on new connection
    _currentTurnId = "";
    // Reset thread when switching workspaces
    const state = get();
    if (state.cwd && state.cwd !== cwd) {
      set({ thread: emptyThread(), sessions: [], activeSessionId: null });
    }
    set({ status: "connecting", cwd });
    const client = getClient();

    if (sessionId) {
      // Historical session — load messages only, don't connect SSE
      set({ client, activeSessionId: sessionId, status: "ready" });
      try {
        const messages = await client.getMessages(sessionId, cwd);
        const blocks = convertHistoryToBlocks(messages);
        const index: Record<string, number> = {};
        blocks.forEach((b, i) => { index[b.id] = i; });
        set({ thread: { blocks, index, loaded: true } });
      } catch (err) {
        console.error("Failed to load messages:", err);
      }
    } else {
      // Create new session
      try {
        const result = await client.createSession(cwd);
        client.connect(result.id);
        set({ client, activeSessionId: result.id, status: "ready" });
      } catch (err) {
        console.error("Failed to create session:", err);
        set({ status: "error" });
        return;
      }
    }

    // Subscribe to events
    _registerEventListener(client);

    // Load session list on connect
    loadSessionsInternal();
  },

  disconnect: () => {
    const { client } = get();
    client?.disconnect();
    set({ status: "offline", client: null, activeSessionId: null });
  },

  sendPrompt: async (message: string) => {
    let { client, activeSessionId, thread, cwd } = get();
    if (!client) return;

    _textBuffer = "";

    // Add user message locally
    const userBlock: ThreadBlock = {
      kind: "user",
      id: `user-${Date.now()}`,
      text: message,
    };
    const blocks = [...thread.blocks, userBlock];
    const index = { ...thread.index, [userBlock.id]: blocks.length - 1 };
    set({ thread: { blocks, index, loaded: true }, working: true });

    // If no active SSE, connect to existing session or create new one
    if (!client.isConnected) {
      if (activeSessionId) {
        // Historical sessions must be loaded into the pi process before the
        // SSE stream is opened; otherwise the backend returns a one-shot
        // "session not found" stream.
        try {
          await client.resumeSession(activeSessionId, cwd);
          client.connect(activeSessionId);
          _registerEventListener(client);
          set({ client });
        } catch (err) {
          console.error("Failed to resume session:", err);
          set({ working: false, status: "error" });
          return;
        }
      } else {
        // No session at all — create new
        try {
          const result = await client.createSession(cwd);
          activeSessionId = result.id;
          const newSession: SessionInfo = { id: result.id, cwd: cwd, name: "New Session" };
          set((s) => ({ activeSessionId: result.id, sessions: [newSession, ...s.sessions].slice(0, 50) }));
          client.connect(result.id);
          _registerEventListener(client);
          set({ client });
        } catch (err) {
          console.error("Failed to create session for prompt:", err);
          set({ working: false });
          return;
        }
      }
    }

    // Use first user message as session name
    if (activeSessionId) {
      const { setSessionName } = await import("./pi-science-client");
      setSessionName(activeSessionId, message);
    }

    if (!activeSessionId) {
      set({ working: false, status: "error" });
      return;
    }
    await client.sendPrompt(activeSessionId, message, cwd);
  },

  abort: async () => {
    const { client, activeSessionId } = get();
    if (client && activeSessionId) {
      await client.abort(activeSessionId);
    }
    set({ working: false });
  },

  setModel: async (model: string) => {
    let { client, activeSessionId, cwd } = get();
    if (!activeSessionId) return;
    client = client ?? getClient();
    // Historical sessions have no live process until the first interaction.
    // Resume them here so changing the model works before sending a prompt.
    if (!client.isConnected) {
      await client.resumeSession(activeSessionId, cwd);
      client.connect(activeSessionId);
      _registerEventListener(client);
      set({ client });
    }
    await client.setModel(activeSessionId, model, cwd);
  },

  loadSessions: async () => {
    await loadSessionsInternal();
  },

  loadSession: async (sessionId: string) => {
    const { client: currentClient } = get();
    currentClient?.disconnect();
    _textBuffer = "";
    _currentTurnId = "";

    // Load messages from disk (works for inactive sessions)
    const messages = await getClient().getMessages(sessionId, get().cwd);
    const blocks = convertHistoryToBlocks(messages);
    const index: Record<string, number> = {};
    blocks.forEach((b, i) => { index[b.id] = i; });
    set({ thread: { blocks, index, loaded: true }, activeSessionId: sessionId, working: false,
      status: "ready", client: getClient() });
    // Note: don't connect SSE for historical sessions — only when user sends a prompt
  },

  forkSession: async (sessionId: string) => {
    const { cwd, client: currentClient } = get();
    currentClient?.disconnect();
    const client = getClient();
    const result = await client.forkSession(sessionId, cwd);
    const messages = await client.getMessages(result.id, cwd);
    const blocks = convertHistoryToBlocks(messages);
    const index: Record<string, number> = {};
    blocks.forEach((b, i) => { index[b.id] = i; });
    client.connect(result.id);
    _registerEventListener(client);
    set({
      client,
      activeSessionId: result.id,
      thread: { blocks, index, loaded: true },
      working: false,
      status: "ready",
    });
    await loadSessionsInternal();
    return result.id;
  },

  createNewSession: async () => {
    const { cwd, client: currentClient, sessions } = get();
    // If there's already an empty "New Session", switch to it instead of creating another
    const existingEmpty = sessions.find((s: SessionInfo) => s.name === "New Session");
    if (existingEmpty) {
      set({ sessions: [existingEmpty, ...sessions.filter((s: SessionInfo) => s.id !== existingEmpty.id)], activeSessionId: existingEmpty.id });
      return existingEmpty.id;
    }

    currentClient?.disconnect();
    const client = getClient();
    const result = await client.createSession(cwd);
    client.connect(result.id);
    const newSession: SessionInfo = { id: result.id, cwd: cwd, name: "New Session" };
    set((s) => ({ sessions: [newSession, ...s.sessions].slice(0, 50) }));
    set({ client, activeSessionId: result.id, thread: emptyThread(), working: false });
    return result.id;
  },

  setDraft: (text: string) => set({ draft: text }),
}));

// ── Helpers ──

function _findLastAgentIdx(blocks: ThreadBlock[]): number {
  // Only insert before a PARTIAL agent (current turn), not completed ones
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "agent" && (blocks[i] as any).partial) return i;
  }
  return -1;
}

function convertHistoryToBlocks(messages: HistoryMessage[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  let pendingToolName = "";

  for (const msg of messages) {
    const role = msg.role;
    if (role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) blocks.push({ kind: "user", id: msg.id, text });
    } else if (role === "assistant") {
      // Check for toolCall (pi stores tool name here)
      const toolCall = msg.content.find((c: any) => c.type === "toolCall");
      if (toolCall) {
        pendingToolName = toolCall.name || toolCall.tool || "bash";
      }
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text) {
        blocks.push({ kind: "agent", id: msg.id, parts: [{ id: msg.id, text }] });
      }
    } else if (role === "toolResult") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      blocks.push({
        kind: "tool", id: msg.id, callId: msg.id,
        tool: pendingToolName || "unknown",
        status: "done" as const,
        output: text || undefined,
      });
      pendingToolName = "";
    }
  }
  return blocks;
}
