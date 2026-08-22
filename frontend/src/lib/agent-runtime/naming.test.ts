import { describe, expect, it, vi } from "vitest";

import { getSessionName, hasAiTitle, hasDerivedSessionName, markAiTitle, markDerivedSessionName, setLocalSessionName, setSessionName } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
import { applyAiSessionName, applyPromptSessionName } from "./naming";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";


installRuntimeTestEnvironment();


describe("session naming", () => {
  it("clears the session name from local storage when a session is deleted", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/sessions/del-me")) return jsonResponse({ ok: true });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url} ${init?.method}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace" });
    setSessionName("/workspace", "del-me", "Secret experiment");
    expect(getSessionName("/workspace", "del-me")).toBe("Secret experiment");

    await useRuntimeStore.getState().deleteSession("del-me");

    expect(getSessionName("/workspace", "del-me")).toBe("");
  });

  it("clears the session name when a missing session is recovered", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) {
        return jsonResponse({ ok: false, error: "session not found in this workspace" }, 404);
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    setSessionName("/workspace", "gone", "Phantom");
    expect(getSessionName("/workspace", "gone")).toBe("Phantom");

    await useRuntimeStore.getState().connect("/workspace", "gone");

    expect(getSessionName("/workspace", "gone")).toBe("");
  });

  it("backfills the session name from loaded history when none is stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: [
          { id: "user-1", role: "user", content: [{ type: "text", text: "  Analyse   the\ndataset today" }] },
          { id: "agent-1", role: "assistant", content: [{ type: "text", text: "done" }] },
        ] });
      }
      if (url.includes("/state")) return jsonResponse(state("legacy-session"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([{ id: "legacy-session", cwd: "/workspace" }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "legacy-session", cwd: "/workspace" }] });

    await useRuntimeStore.getState().connect("/workspace", "legacy-session");

    expect(getSessionName("/workspace", "legacy-session")).toBe("Analyse the");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "legacy-session", name: "Analyse the" }),
    );
  });

  it("keeps an existing stored name when history loads", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: [
          { id: "user-1", role: "user", content: [{ type: "text", text: "totally different text" }] },
        ] });
      }
      if (url.includes("/state")) return jsonResponse(state("named-session"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([{ id: "named-session", cwd: "/workspace" }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    setSessionName("/workspace", "named-session", "My experiment");
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "named-session", cwd: "/workspace", name: "My experiment" }] });

    await useRuntimeStore.getState().connect("/workspace", "named-session");

    expect(getSessionName("/workspace", "named-session")).toBe("My experiment");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "named-session", name: "My experiment" }),
    );
  });

  it("keeps a server-provided title when history is loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: [
          { id: "user-1", role: "user", content: [{ type: "text", text: "totally different text" }] },
        ] });
      }
      if (url.includes("/state")) return jsonResponse(state("server-named-session"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([{
        id: "server-named-session",
        cwd: "/workspace",
        name: "Persisted experiment title",
      }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "server-named-session", cwd: "/workspace" }] });

    await useRuntimeStore.getState().connect("/workspace", "server-named-session");

    expect(getSessionName("/workspace", "server-named-session")).toBe("Persisted experiment title");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "server-named-session", name: "Persisted experiment title" }),
    );
  });

  it("backfills the name during gap recovery once history first contains a user block", async () => {
    let messageReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        messageReads += 1;
        return jsonResponse({ messages: messageReads === 1 ? [] : [
          { id: "user-1", role: "user", content: [{ type: "text", text: "recovered question" }] },
        ] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-gap"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-gap");
    // The empty-thread guard: no user block yet means no derived name.
    expect(getSessionName("/workspace", "session-gap")).toBe("");

    FakeEventSource.instances[0].emit("stream.gap", { type: "stream.gap", sessionId: "session-gap" });

    await vi.waitFor(() => expect(getSessionName("/workspace", "session-gap")).toBe("recovered question"));
  });

  it("truncates a very long first message when storing the session name", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/sessions" && init?.method === "POST") {
        return jsonResponse({ id: "session-long", cwd: "/workspace" });
      }
      if (url.includes("session-long/prompt")) return jsonResponse({ ok: true, id: "session-long" });
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", status: "ready" });

    await useRuntimeStore.getState().sendPrompt("x".repeat(100));

    expect(getSessionName("/workspace", "session-long")).toBe(`${"x".repeat(48)}…`);
  });

  it("keeps a derived fallback replaceable: persists it flagged and lets the AI title win", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/title")) {
        return jsonResponse({ ok: true, title: init ? (JSON.parse(String(init.body)) as { title: string }).title : "AI title" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-derived", cwd: "/workspace", name: "New Session" }] });

    applyPromptSessionName("/workspace", "session-derived", "First question");
    expect(getSessionName("/workspace", "session-derived")).toBe("First question");
    expect(hasDerivedSessionName("/workspace", "session-derived")).toBe(true);
    // The fallback is persisted fire-and-forget, flagged as derived so the
    // server-side AI title may still replace it (survives cache clears).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const derivedPut = fetchMock.mock.calls.find(([, init]) => String(init?.body ?? "").includes("derived"));
    expect(String(derivedPut?.[0])).toContain("session-derived/title");
    expect(JSON.parse(String(derivedPut?.[1]?.body))).toEqual({ title: "First question", derived: true });

    applyAiSessionName("/workspace", "session-derived", "AI title");
    expect(getSessionName("/workspace", "session-derived")).toBe("AI title");
    expect(hasDerivedSessionName("/workspace", "session-derived")).toBe(false);
  });

  it("does not overwrite a server title loaded while AI generation is in flight", () => {
    setLocalSessionName("/workspace", "session-inflight", "First question");
    markDerivedSessionName("/workspace", "session-inflight");
    useRuntimeStore.setState({ sessions: [{ id: "session-inflight", cwd: "/workspace", name: "Persisted title" }] });

    applyAiSessionName("/workspace", "session-inflight", "Late AI title");

    expect(getSessionName("/workspace", "session-inflight")).toBe("First question");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "session-inflight", name: "Persisted title" }),
    );
    expect(hasAiTitle("/workspace", "session-inflight")).toBe(false);
  });

  it("does not overwrite a name when the session is already AI-titled (in-flight guard)", () => {
    setSessionName("/workspace", "session-a", "Existing AI 标题");
    markAiTitle("/workspace", "session-a");
    applyAiSessionName("/workspace", "session-a", "Late result");
    expect(getSessionName("/workspace", "session-a")).toBe("Existing AI 标题");
    expect(hasAiTitle("/workspace", "session-a")).toBe(true);
  });

  it("applies and marks a fresh AI title", () => {
    applyAiSessionName("/workspace", "session-b", "Fresh title");
    expect(getSessionName("/workspace", "session-b")).toBe("Fresh title");
    expect(hasAiTitle("/workspace", "session-b")).toBe(true);
  });
});
