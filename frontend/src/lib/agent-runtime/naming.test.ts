import { describe, expect, it, vi } from "vitest";

import { getSessionName, hasAiTitle, markAiTitle, normalizeSessionTitle, noteManualTitleWrite, setSessionName, titleWriteEpoch } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
import { applyAiSessionName, regenerateSessionTitle, renameSession } from "./naming";
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

  it("keeps the automatic early return but lets a manual regenerate replace a titled session", () => {
    setSessionName("/workspace", "session-c", "Existing AI title");
    markAiTitle("/workspace", "session-c");

    applyAiSessionName("/workspace", "session-c", "Late automatic result");
    expect(getSessionName("/workspace", "session-c")).toBe("Existing AI title");

    applyAiSessionName("/workspace", "session-c", "User regenerated", "manual");
    expect(getSessionName("/workspace", "session-c")).toBe("User regenerated");
    expect(hasAiTitle("/workspace", "session-c")).toBe(true);
  });

  it("never touches the store for another workspace", () => {
    useRuntimeStore.setState({ cwd: "/other", sessions: [{ id: "session-d", cwd: "/workspace", name: "Old" }] });
    applyAiSessionName("/workspace", "session-d", "Scoped title", "manual");
    expect(getSessionName("/workspace", "session-d")).toBe("Scoped title");
    expect(useRuntimeStore.getState().sessions[0].name).toBe("Old");
  });
});

describe("title request results", () => {
  it("applies a generated title for a session in the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, title: "Generated title", revision: 1 })));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-e", cwd: "/workspace" }] });

    expect(await regenerateSessionTitle("/workspace", "session-e", "manual")).toBe("applied");
    expect(getSessionName("/workspace", "session-e")).toBe("Generated title");
    expect(useRuntimeStore.getState().sessions[0].name).toBe("Generated title");
  });

  it("drops a generation whose manual rename landed while it was in flight", async () => {
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { release = done; })));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-f", cwd: "/workspace" }] });

    const pending = regenerateSessionTitle("/workspace", "session-f", "manual");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    noteManualTitleWrite("/workspace", "session-f");
    release(jsonResponse({ ok: true, title: "Stale title", revision: 1 }));

    expect(await pending).toBe("superseded");
    expect(getSessionName("/workspace", "session-f")).toBe("");
  });

  it("reports a failed request and a rejected title as failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-g", cwd: "/workspace" }] });
    expect(await regenerateSessionTitle("/workspace", "session-g", "manual")).toBe("failed");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, title: null })));
    expect(await regenerateSessionTitle("/workspace", "session-g", "manual")).toBe("failed");
    expect(getSessionName("/workspace", "session-g")).toBe("");
  });

  it("tells the server a user-requested regenerate is manual so a running session is refused", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, title: "Generated title", revision: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-l", cwd: "/workspace" }] });

    await regenerateSessionTitle("/workspace", "session-l", "manual");

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ manual: true });
  });

  it("keeps the settled-turn regenerate unguarded so a live busy table cannot block it", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, title: "Generated title", revision: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-m", cwd: "/workspace" }] });

    await regenerateSessionTitle("/workspace", "session-m", "automatic");

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ manual: false });
  });

  it("reports gone when the session left the list during generation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, title: "Generated title", revision: 2 })));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [] });

    expect(await regenerateSessionTitle("/workspace", "session-h", "manual")).toBe("gone");
    expect(getSessionName("/workspace", "session-h")).toBe("");
  });

  it("reports a cancelled generation as superseded or gone, not as a failure", async () => {
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-n", cwd: "/workspace" }] });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, title: null, superseded: true })));
    expect(await regenerateSessionTitle("/workspace", "session-n", "manual")).toBe("superseded");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, title: null, deleted: true })));
    expect(await regenerateSessionTitle("/workspace", "session-n", "manual")).toBe("gone");
  });
});

describe("names a browser learns from the control plane", () => {
  it("keeps a title loaded from the control plane when this browser has no local name", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [
        { id: "user-1", role: "user", content: [{ type: "text", text: "derived from the message" }] },
      ] });
      if (url.includes("/state")) return jsonResponse(state("renamed-elsewhere"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([{ id: "renamed-elsewhere", cwd: "/workspace", name: "手写标题" }]);
      if (init?.method === "PUT") { writes.push(init.body); return jsonResponse({ ok: true, applied: true }); }
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "renamed-elsewhere", cwd: "/workspace", name: "手写标题" }] });

    await useRuntimeStore.getState().connect("/workspace", "renamed-elsewhere");

    // Empty localStorage is not proof that the session is unnamed.
    expect(writes).toEqual([]);
    expect(getSessionName("/workspace", "renamed-elsewhere")).toBe("");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "renamed-elsewhere", name: "手写标题" }),
    );
  });

  it("shows the title the control plane kept when only it knew the session was named", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [
        { id: "user-1", role: "user", content: [{ type: "text", text: "derived from the message" }] },
      ] });
      if (url.includes("/state")) return jsonResponse(state("listed-late"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      if (init?.method === "PUT") return jsonResponse({ ok: true, applied: false, title: "手写标题" });
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "listed-late", cwd: "/workspace" }] });

    await useRuntimeStore.getState().connect("/workspace", "listed-late");

    await vi.waitFor(() => expect(getSessionName("/workspace", "listed-late")).toBe("手写标题"));
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "listed-late", name: "手写标题" }),
    );
  });

  it("does not adopt a stored title over a name saved while the request was in flight", async () => {
    const releases: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { releases.push(done); })));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "race-name", cwd: "/workspace" }] });

    setSessionName("/workspace", "race-name", "Derived name");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // The user names it before the first initialize response arrives.
    setSessionName("/workspace", "race-name", "Typed name");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0](jsonResponse({ ok: true, applied: false, title: "Stored elsewhere" }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSessionName("/workspace", "race-name")).toBe("Typed name");
    releases[1](jsonResponse({ ok: true, applied: true, title: "Typed name" }));
  });
});

describe("manual rename", () => {
  it("sends one PUT and only then writes local state", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, title: "手写标题" }));
    vi.stubGlobal("fetch", fetchMock);
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-i", cwd: "/workspace", name: "Old" }] });
    const epoch = titleWriteEpoch("/workspace", "session-i");

    await renameSession("/workspace", "session-i", "  手写标题  ");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/sessions/session-i/title?cwd=%2Fworkspace");
    expect(getSessionName("/workspace", "session-i")).toBe("手写标题");
    expect(hasAiTitle("/workspace", "session-i")).toBe(true);
    expect(titleWriteEpoch("/workspace", "session-i")).toBe(epoch + 1);
    expect(useRuntimeStore.getState().sessions[0].name).toBe("手写标题");
  });

  it("leaves local state untouched when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "boom" }, 500)));
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-j", cwd: "/workspace", name: "Old" }] });
    const epoch = titleWriteEpoch("/workspace", "session-j");

    await expect(renameSession("/workspace", "session-j", "New name")).rejects.toThrow();

    expect(getSessionName("/workspace", "session-j")).toBe("");
    expect(hasAiTitle("/workspace", "session-j")).toBe(false);
    expect(titleWriteEpoch("/workspace", "session-j")).toBe(epoch);
    expect(useRuntimeStore.getState().sessions[0].name).toBe("Old");
  });

  it("normalizes before sending and refuses an unusable title", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true, title: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    useRuntimeStore.setState({ cwd: "/workspace", sessions: [{ id: "session-k", cwd: "/workspace" }] });

    await expect(renameSession("/workspace", "session-k", "   ")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    await renameSession("/workspace", "session-k", "  Two   words  ");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT", body: JSON.stringify({ title: "Two words", mode: "override" }) });
    expect(getSessionName("/workspace", "session-k")).toBe("Two words");
  });
});

describe("normalizeSessionTitle", () => {
  it("trims, collapses inner whitespace and rejects empty or over-long input", () => {
    expect(normalizeSessionTitle("  Two   words ")).toBe("Two words");
    expect(normalizeSessionTitle("  ")).toBe("");
    expect(normalizeSessionTitle("x".repeat(50))).toBe("x".repeat(50));
    expect(normalizeSessionTitle("x".repeat(51))).toBe("");
  });
});
