import { describe, expect, it, vi } from "vitest";

import { useRuntimeStore } from "./index";
import { emptyThread } from "./event-fold";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";


installRuntimeTestEnvironment();


describe("runtime session actions", () => {
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

  it("shares concurrent initial reads for the same session", async () => {
    let resolveMessages!: (response: Response) => void;
    const messages = new Promise<Response>((resolve) => { resolveMessages = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return messages;
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = useRuntimeStore.getState().connect("/workspace", "session-a");
    const second = useRuntimeStore.getState().connect("/workspace", "session-a");
    resolveMessages(jsonResponse({ messages: [] }));
    await Promise.all([first, second]);

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/state"))).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("shares concurrent older-page loads and advances the current cursor", async () => {
    useRuntimeStore.setState({
      activeSessionId: "session-a",
      cwd: "/workspace",
      thread: {
        blocks: [{ kind: "agent", id: "agent-new", parts: [{ id: "agent-new", text: "newest" }] }],
        index: { "agent-new": 0 },
        loaded: true,
      },
      historyCursor: "cursor-newest",
      historyHasMore: true,
      historyLoading: false,
    });
    let resolvePage!: (response: Response) => void;
    const page = new Promise<Response>((resolve) => { resolvePage = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages?")) return page;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = useRuntimeStore.getState().loadOlderMessages();
    const second = useRuntimeStore.getState().loadOlderMessages();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvePage(jsonResponse({ messages: [
      { id: "user-old", role: "user", content: [{ type: "text", text: "older prompt" }] },
      { id: "agent-old", role: "assistant", content: [{ type: "text", text: "older answer" }] },
    ], next_cursor: "cursor-older", has_more: true, snapshot_version: "v2" }));

    await expect(Promise.all([first, second])).resolves.toEqual([2, 2]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-a/messages?cwd=%2Fworkspace&before=cursor-newest", expect.anything());
    expect(useRuntimeStore.getState().thread.blocks.map((block) => block.id)).toEqual(["user-old", "agent-old", "agent-new"]);
    expect(useRuntimeStore.getState().historyCursor).toBe("cursor-older");
    expect(useRuntimeStore.getState().historyHasMore).toBe(true);
  });

  it("restores persisted session titles before slow session activation finishes", async () => {
    let resolveMessages!: (response: Response) => void;
    let resolveState!: (response: Response) => void;
    const messages = new Promise<Response>((resolve) => { resolveMessages = resolve; });
    const runtimeState = new Promise<Response>((resolve) => { resolveState = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return messages;
      if (url.includes("/state")) return runtimeState;
      if (url.startsWith("/api/sessions?")) {
        return jsonResponse([{
          id: "session-a",
          cwd: "/workspace",
          name: "Persisted experiment title",
          updated_at: "2026-01-01T00:00:00Z",
        }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const connecting = useRuntimeStore.getState().connect("/workspace", "session-a");

    // The activation requests are deliberately still pending. The session
    // list must already carry the server-persisted title after a page refresh.
    await vi.waitFor(() => {
      expect(useRuntimeStore.getState().sessions).toContainEqual(
        expect.objectContaining({ id: "session-a", name: "Persisted experiment title" }),
      );
    });

    resolveMessages(jsonResponse({ messages: [] }));
    resolveState(jsonResponse(state("session-a")));
    await connecting;
  });

  it("keeps a tail-only history page contiguous until older pagination runs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: [{ id: "agent-old", role: "assistant", content: [{ type: "text", text: "tail answer" }] }], next_cursor: "tail-cursor", has_more: true, snapshot_version: "v1" });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");

    expect(useRuntimeStore.getState().thread.blocks).toEqual([
      { kind: "agent", id: "agent-old", parts: [{ id: "agent-old", text: "tail answer" }], timestamp: undefined },
    ]);
    expect(useRuntimeStore.getState().historyCursor).toBe("tail-cursor");
    expect(useRuntimeStore.getState().historyHasMore).toBe(true);
    expect(fetch).not.toHaveBeenCalledWith("/api/sessions/session-a/messages/index?cwd=%2Fworkspace", expect.anything());
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
    expect(current.contextTokens).toBe(24000);
    expect(current.contextWindow).toBe(128000);
    expect(current.contextPercent).toBe(18.75);
    expect(current.compactionThresholdPercent).toBe(85);
    expect(current.thread.blocks[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(current.status).toBe("ready");
  });

  it("keeps a partial questionnaire busy until its bridge request arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "session-a",
      working: true,
      pendingQuestionnaire: { toolCallId: "call-q1", questions: [] },
    });

    await useRuntimeStore.getState().connect("/workspace", "session-a");

    expect(useRuntimeStore.getState().working).toBe(true);
    expect(useRuntimeStore.getState().pendingQuestionnaire?.toolCallId).toBe("call-q1");
    await expect(useRuntimeStore.getState().sendPrompt("do not interrupt")).rejects.toThrow(
      "The current conversation is still running",
    );
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
      expect.objectContaining({ kind: "user", text: "first question", timestamp: expect.any(String) }),
    );
    expect(current.sessions).toContainEqual(expect.objectContaining({ id: "session-first", name: "first question" }));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/sessions")).toHaveLength(1);
  });

  it("keeps independent blank conversations when another blank conversation is created", async () => {
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
    expect(useRuntimeStore.getState().sessions.map((session) => session.id)).toEqual(["blank-2", "blank-1"]);
  });

  it("settles a new conversation after the route reuses an already-open SSE connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/sessions" && init?.method === "POST") {
        return jsonResponse({ id: "blank-route", cwd: "/workspace" });
      }
      if (url.includes("blank-route/messages")) return jsonResponse({ messages: [] });
      if (url.includes("blank-route/state")) return jsonResponse(state("blank-route"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", status: "ready" });

    const createPromise = useRuntimeStore.getState().createNewSession();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.instances[0].open();
    await expect(createPromise).resolves.toBe("blank-route");

    // LiveSessionPage calls connect again after navigation to the new route.
    await useRuntimeStore.getState().connect("/workspace", "blank-route");

    expect(useRuntimeStore.getState().status).toBe("ready");
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

  it("switches to another session while the previous session keeps running", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-b"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "session-a",
      status: "ready",
      working: true,
    });

    await useRuntimeStore.getState().connect("/workspace", "session-b");

    expect(useRuntimeStore.getState().activeSessionId).toBe("session-b");
    expect(useRuntimeStore.getState().working).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
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
    await expect(sending).resolves.toBeNull();

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

  it("clears active conversation state when deleting the active session", async () => {
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "active-to-delete",
      sessions: [{ id: "active-to-delete", cwd: "/workspace", created_at: "2026-01-01T00:00:00Z" }],
      historyCursor: "cursor-123",
      historyHasMore: true,
      thread: { blocks: [{ id: "b1", kind: "text", text: "draft" } as never], index: { b1: 0 }, loaded: true },
      pendingQuestionnaire: { id: "q1", questions: [] } as never,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions/active-to-delete")) return jsonResponse({ ok: true });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().deleteSession("active-to-delete");

    const state = useRuntimeStore.getState();
    expect(state.activeSessionId).toBeNull();
    expect(state.sessions).toEqual([]);
    expect(state.historyCursor).toBeNull();
    expect(state.historyHasMore).toBe(false);
    expect(state.thread).toEqual(emptyThread());
    expect(state.pendingQuestionnaire).toBeNull();
    expect(state.status).toBe("ready");
    vi.unstubAllGlobals();
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
