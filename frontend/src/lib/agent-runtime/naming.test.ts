import { describe, expect, it, vi } from "vitest";

import { getSessionName, setSessionName } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
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
});
