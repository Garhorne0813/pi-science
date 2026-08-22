import { describe, expect, it, vi } from "vitest";

import { getSessionName } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";
import * as fileRevision from "./file-revision";


installRuntimeTestEnvironment();


describe("runtime event subscription", () => {
  it("renders a terminal runtime error and settles the active turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a", { is_streaming: true }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("error", {
      type: "error",
      sessionId: "session-a",
      message: "OpenAI API error (401): Invalid API key",
      terminal: true,
    });

    const current = useRuntimeStore.getState();
    expect(current.activeSessionId).toBe("session-a");
    expect(current.working).toBe(false);
    expect(current.status).toBe("error");
    expect(current.thread.blocks).toContainEqual(expect.objectContaining({
      kind: "status-line",
      level: "error",
      text: expect.stringContaining("Invalid API key"),
    }));
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("retries a failed transport state probe before settling an idle turn", async () => {
    let stateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) {
        stateReads += 1;
        if (stateReads === 2) return jsonResponse({ error: "state unavailable" }, 503);
        return jsonResponse(state("session-a", { is_streaming: stateReads === 1 }));
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.({} as Event);

    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false));
    expect(stateReads).toBeGreaterThanOrEqual(3);
  });

  it("bounded optimistic retry recovers a session that never materializes on disk", async () => {
    const { optimisticSessionIds } = await import("./sessions");
    optimisticSessionIds.add("optimistic-ghost");
    try {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/messages")) return jsonResponse({ messages: [] });
        if (url.includes("/state")) return jsonResponse(state("optimistic-ghost"));
        if (url.startsWith("/api/sessions?")) return jsonResponse([]);
        throw new Error(`Unexpected request: ${url}`);
      }));
      await useRuntimeStore.getState().connect("/workspace", "optimistic-ghost");
      const source = FakeEventSource.instances[0];
      source.open();

      const emitNotFound = () => source.emit("error", {
        type: "error",
        sessionId: "optimistic-ghost",
        message: "session not found in this workspace",
        terminal: true,
      });

      // First not-found: optimistic retry scheduled (connect count grows).
      emitNotFound();
      expect(useRuntimeStore.getState().status).toBe("connecting");
      await new Promise((resolve) => setTimeout(resolve, 850));
      const afterFirst = FakeEventSource.instances.length;
      expect(afterFirst).toBeGreaterThanOrEqual(2);

      // Second not-found: retry again (cap = 2).
      FakeEventSource.instances.at(-1)!.emit("error", {
        type: "error",
        sessionId: "optimistic-ghost",
        message: "session not found in this workspace",
        terminal: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 850));
      const afterSecond = FakeEventSource.instances.length;
      expect(afterSecond).toBeGreaterThan(afterFirst);

      // Third not-found: cap exhausted — recovery runs, no further connects.
      FakeEventSource.instances.at(-1)!.emit("error", {
        type: "error",
        sessionId: "optimistic-ghost",
        message: "session not found in this workspace",
        terminal: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 850));
      const afterThird = FakeEventSource.instances.length;
      expect(afterThird).toBe(afterSecond);
      expect(useRuntimeStore.getState().activeSessionId).toBeNull();
      expect(optimisticSessionIds.has("optimistic-ghost")).toBe(false);
    } finally {
      optimisticSessionIds.delete("optimistic-ghost");
    }
  });

  it("shows work immediately, handles extension questions, and settles on idle", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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

  it("routes the structured questionnaire request through the browser bridge", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-questionnaire"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      if (url.includes("/interactions/")) return jsonResponse({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-questionnaire");
    const source = FakeEventSource.instances[0];
    source.open();

    source.emit("questionnaire.asked", {
      type: "questionnaire.asked",
      sessionId: "session-questionnaire",
      toolCallId: "call-q1",
      questions: [{
        question: "Which mode?",
        header: "Mode",
        multiSelect: false,
        options: [{ label: "Fast", description: "Low latency", preview: "**fast**" }, { label: "Safe", description: "Conservative" }],
      }],
    });
    source.emit("question.asked", {
      type: "question.asked",
      sessionId: "session-questionnaire",
      requestId: "request-q1",
      method: "input",
      title: "Questionnaire",
      questionnaire: true,
      toolCallId: "call-q1",
    });

    expect(useRuntimeStore.getState().pendingQuestionnaire?.questions[0]?.options[0]?.preview).toBe("**fast**");
    expect(useRuntimeStore.getState().pendingInteraction).toMatchObject({ questionnaire: true, requestId: "request-q1" });

    await useRuntimeStore.getState().respondToInteraction({ value: JSON.stringify({ cancelled: false, answers: [{ questionIndex: 0, kind: "option", answer: "Fast" }] }) });
    const interactionCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/interactions/"));
    expect(JSON.parse(String(interactionCall?.[1]?.body))).toMatchObject({ value: expect.stringContaining('"Fast"') });

    source.emit("questionnaire.finished", { type: "questionnaire.finished", sessionId: "session-questionnaire", toolCallId: "call-q1" });
    expect(useRuntimeStore.getState().pendingQuestionnaire).toBeNull();
    expect(useRuntimeStore.getState().pendingInteraction).toBeNull();
  });

  it("clears an unresolved interaction when the runtime settles successfully", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.emit("question.asked", {
      type: "question.asked",
      sessionId: "session-a",
      requestId: "question-1",
      method: "input",
      title: "Question",
    });

    expect(useRuntimeStore.getState().pendingInteraction?.requestId).toBe("question-1");
    source.emit("session.idle", { type: "session.idle", sessionId: "session-a" });
    expect(useRuntimeStore.getState().pendingInteraction).toBeNull();
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

  it("increments the file revision when an agent turn settles", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");

    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
    });

    expect(useRuntimeStore.getState().fileRevision).toBe(1);
  });

  it("client generateSessionTitle path works", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/title")) return jsonResponse({ ok: true, title: "单细胞数据 QC 分析" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createClient } = await import("../client/pi-science-client");
    const title = await createClient("").generateSessionTitle("session-a", "/workspace");
    expect(title).toBe("单细胞数据 QC 分析");
  });

  it("generates an AI title on settle and applies it to the sidebar name", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      if (url.includes("/title")) return jsonResponse({ ok: true, title: "单细胞数据 QC 分析" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
    });

    await vi.waitFor(() => {
      const calls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(calls.some((url) => url.includes("/title"))).toBe(true);
    });
    await vi.waitFor(() => {
      const names = JSON.parse(localStorage.getItem("pi-science.session-names") ?? "{}") as Record<string, string>;
      expect(Object.values(names)).toContain("单细胞数据 QC 分析");
      expect(JSON.parse(localStorage.getItem("pi-science.session-names-ai") ?? "{}")).toMatchObject({
        "/workspace\u0000session-a": true,
      });
    });
  });

  it("keeps a persisted title and skips AI generation after an idle replay", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([{
        id: "session-a",
        cwd: "/workspace",
        name: "Persisted experiment title",
      }]);
      if (url.includes("/title")) return jsonResponse({ ok: true, title: "Unexpected replacement" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    await vi.waitFor(() => {
      expect(useRuntimeStore.getState().sessions).toContainEqual(
        expect.objectContaining({ id: "session-a", name: "Persisted experiment title" }),
      );
    });

    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/title"))).toBe(false);
    expect(getSessionName("/workspace", "session-a")).toBe("Persisted experiment title");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "session-a", name: "Persisted experiment title" }),
    );
  });

  it("skips the title request when the session is already marked AI-titled", async () => {
    localStorage.setItem(
      "pi-science.session-names-ai",
      JSON.stringify({ "/workspace\u0000session-a": true }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
    });

    await vi.waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/title"), expect.anything());
    });
  });

  it("records an attempt marker when title generation fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      if (url.includes("/title")) throw new Error("provider down");
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
    });

    await vi.waitFor(() => {
      const attempts = JSON.parse(localStorage.getItem("pi-science.session-names-ai-attempted") ?? "{}") as Record<string, number>;
      expect(attempts["/workspace\u0000session-a"]).toBeGreaterThan(0);
    });
  });

  it("skips the title request within the retry window after a failed attempt", async () => {
    localStorage.setItem(
      "pi-science.session-names-ai-attempted",
      JSON.stringify({ "/workspace\u0000session-a": Date.now() }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
    });

    await vi.waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/title"), expect.anything());
    });
  });

  it("silently ignores a failing title request and keeps the derived name", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      if (url.includes("/title")) return jsonResponse({ ok: false, error: "boom" }, 500);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("session.idle", {
      type: "session.idle",
      sessionId: "session-a",
    });

    // Wait a tick for the async title path, then assert nothing was stored.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(localStorage.getItem("pi-science.session-names-ai")).toBeNull();
    expect(JSON.parse(localStorage.getItem("pi-science.session-names") ?? "{}")).toEqual({});
  });

  it("skips AI title generation when the user switches away during the settle refresh", async () => {
    let armed = false;
    let releaseList!: (response: Response) => void;
    const delayedList = new Promise<Response>((resolve) => { releaseList = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) {
        // The initial activation refreshes the list immediately; only the
        // settle-time refresh is held open as the switch window.
        return armed ? delayedList : jsonResponse([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    armed = true;

    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("session.idle", { type: "session.idle", sessionId: "session-a" });
    // The user moves to another workspace/session while the settle-time list
    // refresh is still in flight.
    useRuntimeStore.setState({ cwd: "/workspace-b", activeSessionId: "session-b" });
    releaseList(jsonResponse([]));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/title"))).toBe(false);
  });

  it("refreshes the workspace file tree exactly once per settled turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a", { is_streaming: false }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const mark = vi.spyOn(fileRevision, "markWorkspaceFilesChanged");
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    mark.mockClear();
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    // The backend normalizes agent_settled into session.idle; that single
    // event must bump the tree revision exactly once.
    source.emit("session.idle", { type: "session.idle", sessionId: "session-a" });
    // The server publishes turn.artifacts from the settled observer; the
    // listener must NOT bump the tree revision a second time.
    source.emit("turn.artifacts", { type: "turn.artifacts", sessionId: "session-a", turnId: "t1", artifacts: [] });
    await vi.waitFor(() => expect(mark).toHaveBeenCalledTimes(1));
  });

  it("ignores session.stats events from non-active sessions and applies active ones", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-b"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-b");
    const source = FakeEventSource.instances[0];
    source.open();

    const baseline = {
      userMessages: 4,
      assistantMessages: 5,
      toolCalls: 9,
      toolResults: 8,
      totalMessages: 18,
      tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
    };
    useRuntimeStore.setState({ sessionStats: baseline });

    // A late stats event from a session the user already left must not
    // overwrite the active session's numbers.
    source.emit("session.stats", {
      type: "session.stats",
      sessionId: "session-a",
      stats: { ...baseline, userMessages: 99 },
    });
    expect(useRuntimeStore.getState().sessionStats).toEqual(baseline);

    // The active session's stats event replaces the baseline.
    const next = { ...baseline, userMessages: 5, toolCalls: 11, tokens: { ...baseline.tokens, output: 12000 } };
    source.emit("session.stats", { type: "session.stats", sessionId: "session-b", stats: next });
    expect(useRuntimeStore.getState().sessionStats).toEqual(next);
  });
});
