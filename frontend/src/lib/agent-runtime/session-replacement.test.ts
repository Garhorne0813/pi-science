import { describe, expect, it, vi } from "vitest";

import { getSessionName, setSessionName } from "../client/pi-science-client";
import { applySessionReplacements, useRuntimeStore } from "./index";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";


installRuntimeTestEnvironment();


describe("session replacement", () => {
  it("moves to a replacement session emitted after a runtime configuration reload", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state(url.includes("replacement") ? "replacement" : "original"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([{ id: "replacement", cwd: "/workspace" }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "original");
    FakeEventSource.instances[0].emit("session.replaced", {
      type: "session.replaced",
      sessionId: "original",
      replacementSessionId: "replacement",
    });
    await vi.waitFor(() => expect(useRuntimeStore.getState().activeSessionId).toBe("replacement"));
    expect(FakeEventSource.instances.at(-1)?.url).toContain("/api/sessions/replacement/events");
    await vi.waitFor(() => expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "replacement" }),
    ));
    expect(useRuntimeStore.getState().working).toBe(false);
  });

  it("preserves custom names when REST replaces the active session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("replacement/messages")) return jsonResponse({ messages: [] });
      if (url.startsWith("/api/sessions?")) return jsonResponse([{ id: "replacement", cwd: "/workspace" }]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    setSessionName("/workspace", "original", "My experiment");
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "original",
      sessions: [{ id: "original", cwd: "/workspace", name: "My experiment" }],
      thread: { blocks: [], index: {}, loaded: true },
      status: "ready",
    });

    expect(applySessionReplacements([
      { cwd: "/workspace", oldId: "original", newId: "replacement" },
    ])).toBe("replacement");

    expect(useRuntimeStore.getState().activeSessionId).toBe("replacement");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "replacement", name: "My experiment" }),
    );
    expect(getSessionName("/workspace", "replacement")).toBe("My experiment");
    expect(getSessionName("/workspace", "original")).toBe("");
    expect(FakeEventSource.instances.at(-1)?.url).toContain("/api/sessions/replacement/events");
  });
});
