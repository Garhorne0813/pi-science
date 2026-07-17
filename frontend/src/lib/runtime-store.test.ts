import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "./pi-science-client";
import { convertHistoryToBlocks, useRuntimeStore } from "./runtime-store";


class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  private handlers = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const callback = typeof handler === "function"
      ? handler as unknown as (event: { data?: string }) => void
      : (event: { data?: string }) => handler.handleEvent(event as unknown as Event);
    this.handlers.set(type, [...(this.handlers.get(type) || []), callback]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({} as Event);
  }

  emit(type: string, payload: unknown): void {
    const event = { data: JSON.stringify(payload) };
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
}


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function state(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    id: sessionId,
    cwd: "/workspace",
    is_streaming: false,
    is_compacting: false,
    pending_message_count: 0,
    model: "custom-custom-api/gpt-5.6-luna",
    thinking: "max",
    ...overrides,
  };
}


beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  createClient("");
  useRuntimeStore.setState({
    status: "offline",
    client: null,
    sessions: [],
    activeSessionId: null,
    cwd: ".",
    thread: { blocks: [], index: {}, loaded: false },
    working: false,
    model: null,
    thinking: null,
    pendingInteraction: null,
    draft: "",
  });
});

afterEach(() => {
  useRuntimeStore.getState().disconnect();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe("runtime conversation state", () => {
  it("does not create ghost sessions when StrictMode reopens a workspace route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await useRuntimeStore.getState().connect("/workspace");
    useRuntimeStore.getState().disconnect();
    await useRuntimeStore.getState().connect("/workspace");

    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/sessions")).toBe(false);
    expect(useRuntimeStore.getState().activeSessionId).toBeNull();
    expect(useRuntimeStore.getState().status).toBe("ready");
  });

  it("restores authoritative running, model, thinking and history state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: [{
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        }] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a", { is_streaming: true }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].open();

    const current = useRuntimeStore.getState();
    expect(current.activeSessionId).toBe("session-a");
    expect(current.working).toBe(true);
    expect(current.model).toBe("custom-custom-api/gpt-5.6-luna");
    expect(current.thinking).toBe("max");
    expect(current.thread.blocks[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(current.status).toBe("ready");
  });

  it("recovers a missing session to a ready blank conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) {
        return jsonResponse({ ok: false, error: "session not found in this workspace" }, 404);
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "stale-session");

    const current = useRuntimeStore.getState();
    expect(current.activeSessionId).toBeNull();
    expect(current.thread.blocks).toHaveLength(0);
    expect(current.working).toBe(false);
    expect(current.status).toBe("ready");
    expect(FakeEventSource.instances[0].readyState).toBe(FakeEventSource.CLOSED);
  });

  it("clears the active session when SSE reports a terminal missing-session error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("stale-session"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "stale-session");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("error", {
      type: "error",
      sessionId: "stale-session",
      message: "session not found in this workspace",
      terminal: true,
    });

    expect(useRuntimeStore.getState().activeSessionId).toBeNull();
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("clears a stale session when the prompt request itself returns not found", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/prompt")) {
        return jsonResponse({ ok: false, error: "session not found in this workspace" }, 404);
      }
      if (url.includes("/state")) {
        return jsonResponse({ ok: false, error: "session not found in this workspace" }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", activeSessionId: "stale-session", status: "ready" });

    await expect(useRuntimeStore.getState().sendPrompt("hello")).rejects.toThrow(
      "session not found in this workspace",
    );

    const current = useRuntimeStore.getState();
    expect(current.activeSessionId).toBeNull();
    expect(current.thread.blocks).toHaveLength(0);
    expect(current.status).toBe("ready");
  });

  it("ignores a stale history response after switching sessions", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstMessages = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("session-a/messages")) return firstMessages;
      if (url.includes("session-a/state")) return jsonResponse(state("session-a"));
      if (url.includes("session-b/messages")) {
        return jsonResponse({ messages: [{
          id: "user-b",
          role: "user",
          content: [{ type: "text", text: "session B" }],
        }] });
      }
      if (url.includes("session-b/state")) return jsonResponse(state("session-b"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    const firstConnect = useRuntimeStore.getState().connect("/workspace", "session-a");
    await Promise.resolve();
    await useRuntimeStore.getState().connect("/workspace", "session-b");
    resolveFirst(jsonResponse({ messages: [{
      id: "user-a",
      role: "user",
      content: [{ type: "text", text: "stale A" }],
    }] }));
    await firstConnect;

    const current = useRuntimeStore.getState();
    expect(current.activeSessionId).toBe("session-b");
    expect(current.thread.blocks).toHaveLength(1);
    expect(current.thread.blocks[0]).toMatchObject({ kind: "user", text: "session B" });
  });

  it("shows work immediately, handles extension questions, and settles on idle", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.includes("/interactions/")) return jsonResponse({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();

    const sending = useRuntimeStore.getState().sendPrompt("research this");
    expect(useRuntimeStore.getState().working).toBe(true);
    await sending;
    source.emit("question.asked", {
      type: "question.asked",
      sessionId: "session-a",
      requestId: "question-1",
      method: "select",
      title: "Choose scope",
      options: ["A", "B"],
    });
    expect(useRuntimeStore.getState().pendingInteraction?.requestId).toBe("question-1");

    await useRuntimeStore.getState().respondToInteraction({ value: "B" });
    expect(useRuntimeStore.getState().pendingInteraction).toBeNull();
    source.emit("session.idle", { type: "session.idle", sessionId: "session-a" });
    expect(useRuntimeStore.getState().working).toBe(false);
    expect(useRuntimeStore.getState().status).toBe("ready");
  });

  it("keeps a locally rendered command when an extension handles it without an agent turn", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");

    await useRuntimeStore.getState().sendPrompt("/handled-command");
    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
      handledWithoutTurn: true,
    });
    await Promise.resolve();

    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "user", text: "/handled-command" }),
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages"))).toHaveLength(1);
  });

  it("creates exactly one conversation on the first message from an empty workspace", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/sessions" && init?.method === "POST") {
        return jsonResponse({ id: "session-first", cwd: "/workspace" });
      }
      if (url.includes("session-first/prompt")) return jsonResponse({ ok: true, id: "session-first" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    useRuntimeStore.setState({ cwd: "/workspace", status: "ready" });

    await useRuntimeStore.getState().sendPrompt("first question");

    const current = useRuntimeStore.getState();
    expect(current.activeSessionId).toBe("session-first");
    expect(current.working).toBe(true);
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "user", text: "first question" }),
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/sessions")).toHaveLength(1);
  });

  it("removes an older unpersisted blank when another blank conversation is created", async () => {
    let counter = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/sessions" && init?.method === "POST") {
        counter += 1;
        return jsonResponse({ id: `blank-${counter}`, cwd: "/workspace" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", status: "ready" });

    await useRuntimeStore.getState().createNewSession();
    await useRuntimeStore.getState().createNewSession();

    expect(useRuntimeStore.getState().activeSessionId).toBe("blank-2");
    expect(useRuntimeStore.getState().sessions.map((session) => session.id)).toEqual(["blank-2"]);
  });

  it("keeps durable history visible when runtime activation is busy", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: [{
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: "saved history" }],
        }] });
      }
      if (url.includes("/state")) {
        return jsonResponse({ ok: false, code: "busy", error: "another conversation is running" }, 409);
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-b");

    const current = useRuntimeStore.getState();
    expect(current.status).toBe("error");
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "user", text: "saved history" }),
    );
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "status-line", text: "another conversation is running" }),
    );
  });

  it("does not let an initial history snapshot erase a prompt sent during connect", async () => {
    let resolveMessages!: (response: Response) => void;
    let resolveState!: (response: Response) => void;
    const messages = new Promise<Response>((resolve) => { resolveMessages = resolve; });
    const runtimeState = new Promise<Response>((resolve) => { resolveState = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return messages;
      if (url.includes("/state")) return runtimeState;
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    const connecting = useRuntimeStore.getState().connect("/workspace", "session-a");
    await Promise.resolve();
    await useRuntimeStore.getState().sendPrompt("do not disappear");
    resolveMessages(jsonResponse({ messages: [] }));
    resolveState(jsonResponse(state("session-a")));
    await connecting;

    const current = useRuntimeStore.getState();
    expect(current.working).toBe(true);
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "user", text: "do not disappear" }),
    );
  });

  it("merges durable user history with replayed live output during a mid-turn reload", async () => {
    let resolveMessages!: (response: Response) => void;
    let resolveState!: (response: Response) => void;
    const messages = new Promise<Response>((resolve) => { resolveMessages = resolve; });
    const runtimeState = new Promise<Response>((resolve) => { resolveState = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return messages;
      if (url.includes("/state")) return runtimeState;
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    const connecting = useRuntimeStore.getState().connect("/workspace", "session-a");
    await Promise.resolve();
    FakeEventSource.instances[0].emit("text.updated", {
      type: "text.updated",
      sessionId: "session-a",
      partId: "assistant-live",
      text: "live answer",
    });
    resolveMessages(jsonResponse({ messages: [{
      id: "user-persisted",
      role: "user",
      content: [{ type: "text", text: "persisted question" }],
    }] }));
    resolveState(jsonResponse(state("session-a", { is_streaming: true })));
    await connecting;

    const blocks = useRuntimeStore.getState().thread.blocks;
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "user", text: "persisted question" }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "assistant-live" }),
    );
  });

  it("does not let a stale state snapshot clear live working activity", async () => {
    let resolveMessages!: (response: Response) => void;
    let resolveState!: (response: Response) => void;
    const messages = new Promise<Response>((resolve) => { resolveMessages = resolve; });
    const runtimeState = new Promise<Response>((resolve) => { resolveState = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return messages;
      if (url.includes("/state")) return runtimeState;
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    const connecting = useRuntimeStore.getState().connect("/workspace", "session-a");
    await Promise.resolve();
    FakeEventSource.instances[0].emit("agent_start", {
      type: "agent_start",
      sessionId: "session-a",
    });
    FakeEventSource.instances[0].emit("text.updated", {
      type: "text.updated",
      sessionId: "session-a",
      partId: "assistant-live",
      text: "still working",
    });
    resolveMessages(jsonResponse({ messages: [] }));
    resolveState(jsonResponse(state("session-a")));
    await connecting;

    const current = useRuntimeStore.getState();
    expect(current.working).toBe(true);
    expect(current.status).toBe("ready");
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "assistant-live", partial: true }),
    );
  });

  it("keeps the stop state and shows an inline error when the SSE transport closes", async () => {
    let stateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) {
        stateReads += 1;
        return jsonResponse(state("session-a", { is_streaming: stateReads > 1 }));
      }
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    await useRuntimeStore.getState().sendPrompt("keep running");

    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.({} as Event);
    await Promise.resolve();
    await Promise.resolve();

    const current = useRuntimeStore.getState();
    expect(current.working).toBe(true);
    expect(current.status).toBe("error");
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "status-line", text: "Conversation stream closed" }),
    );
  });

  it("does not mark a running backend turn idle when the conversation view unmounts", () => {
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "session-a",
      status: "ready",
      working: true,
    });

    useRuntimeStore.getState().disconnect();

    expect(useRuntimeStore.getState().status).toBe("offline");
    expect(useRuntimeStore.getState().working).toBe(true);
  });

  it("refuses to detach from a running conversation in the same workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "session-a",
      status: "ready",
      working: true,
    });

    await useRuntimeStore.getState().connect("/workspace", "session-b");

    expect(useRuntimeStore.getState().activeSessionId).toBe("session-a");
    expect(useRuntimeStore.getState().working).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("treats live output as proof of acceptance when the prompt acknowledgement fails", async () => {
    let rejectPrompt!: (error: Error) => void;
    const promptResponse = new Promise<Response>((_resolve, reject) => { rejectPrompt = reject; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.includes("/prompt")) return promptResponse;
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");

    const sending = useRuntimeStore.getState().sendPrompt("accepted despite timeout");
    FakeEventSource.instances[0].emit("text.updated", {
      type: "text.updated",
      sessionId: "session-a",
      text: "answer started",
    });
    rejectPrompt(new Error("network timeout"));
    await expect(sending).resolves.toBeUndefined();

    const current = useRuntimeStore.getState();
    expect(current.working).toBe(true);
    expect(current.status).toBe("ready");
    expect(current.thread.blocks.some(
      (block) => block.kind === "status-line" && block.text.includes("network timeout"),
    )).toBe(false);
  });

  it("keeps Stop visible after an ambiguous prompt timeout until abort", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.includes("/prompt")) {
        return jsonResponse({ ok: false, code: "timeout", error: "request timeout after 30s" }, 504);
      }
      if (url.includes("/abort")) return jsonResponse({ ok: true });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");

    await expect(useRuntimeStore.getState().sendPrompt("ambiguous")).rejects.toThrow("request timeout");
    expect(useRuntimeStore.getState().working).toBe(true);
    expect(useRuntimeStore.getState().status).toBe("error");

    await useRuntimeStore.getState().abort();
    expect(useRuntimeStore.getState().working).toBe(false);
    expect(useRuntimeStore.getState().status).toBe("ready");
  });

  it("settles a fast response that completed before the SSE stream opened", async () => {
    let stateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: stateReads > 1 ? [
          { id: "user-fast", role: "user", content: [{ type: "text", text: "fast" }] },
          { id: "agent-fast", role: "assistant", content: [{ type: "text", text: "done" }] },
        ] : [] });
      }
      if (url.includes("/state")) {
        stateReads += 1;
        return jsonResponse(state("session-a"));
      }
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");

    await useRuntimeStore.getState().sendPrompt("fast");
    expect(FakeEventSource.instances[0].readyState).toBe(FakeEventSource.CONNECTING);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await Promise.resolve();

    const current = useRuntimeStore.getState();
    expect(current.working).toBe(false);
    expect(current.status).toBe("ready");
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "agent-fast" }),
    );
  });

  it("removes deleted durable sessions instead of resurrecting them as optimistic", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: null,
      sessions: [{
        id: "deleted-session",
        cwd: "/workspace",
        created_at: "2026-01-01T00:00:00Z",
      }],
    });

    await useRuntimeStore.getState().loadSessions();

    expect(useRuntimeStore.getState().sessions).toEqual([]);
  });

  it("preserves a tool name when update/end events omit it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.emit("tool.updated", {
      type: "tool.updated",
      sessionId: "session-a",
      callId: "call-1",
      tool: "bash",
      status: "running",
    });
    source.emit("tool.updated", {
      type: "tool.updated",
      sessionId: "session-a",
      callId: "call-1",
      tool: "",
      status: "done",
    });

    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "tool", callId: "call-1", tool: "bash", status: "done" }),
    );
  });

  it("adopts the replacement session ID when a stale blank runtime reloads a custom model", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("old-blank/messages")) return jsonResponse({ messages: [] });
      if (url.includes("old-blank/state")) return jsonResponse(state("old-blank"));
      if (url.includes("old-blank/model")) {
        return jsonResponse({
          ok: true,
          id: "new-blank",
          model: "custom-new/luna",
          thinking: "max",
          restarted: true,
          replaced_blank: true,
        });
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "old-blank");
    const replacementId = await useRuntimeStore.getState().setModel("custom-new/luna", "max");

    const current = useRuntimeStore.getState();
    expect(replacementId).toBe("new-blank");
    expect(current.activeSessionId).toBe("new-blank");
    expect(current.model).toBe("custom-new/luna");
    expect(current.thinking).toBe("max");
    expect(current.sessions[0]).toMatchObject({ id: "new-blank", cwd: "/workspace" });
    expect(FakeEventSource.instances.at(-1)?.url).toContain("/api/sessions/new-blank/events");
  });

  it("keeps a successful fork active when its first history read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("parent/fork")) return jsonResponse({ ok: true, id: "forked" });
      if (url.includes("forked/messages")) return jsonResponse({ error: "temporary read failure" }, 503);
      if (url.startsWith("/api/sessions?")) {
        return jsonResponse([{ id: "forked", cwd: "/workspace" }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "parent",
      status: "ready",
      sessions: [{ id: "parent", cwd: "/workspace" }],
    });

    await expect(useRuntimeStore.getState().forkSession("parent")).resolves.toBe("forked");

    const current = useRuntimeStore.getState();
    expect(current.activeSessionId).toBe("forked");
    expect(current.thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "status-line", text: "temporary read failure" }),
    );
  });
});


describe("conversation history conversion", () => {
  it("maps tool results by toolCallId instead of using the previous tool or unknown", () => {
    const blocks = convertHistoryToBlocks([
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-read", name: "read" },
          { type: "toolCall", id: "call-bash", name: "bash" },
        ],
      },
      {
        id: "result-bash",
        role: "toolResult",
        toolCallId: "call-bash",
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
      },
      {
        id: "result-read",
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: "content" }],
      },
    ]);

    expect(blocks).toEqual([
      expect.objectContaining({ kind: "tool", callId: "call-bash", tool: "bash" }),
      expect.objectContaining({ kind: "tool", callId: "call-read", tool: "read" }),
    ]);
  });
});
