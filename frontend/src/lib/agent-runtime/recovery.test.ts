import { describe, expect, it, vi } from "vitest";

import { getClient } from "../client/pi-science-client";
import { generations } from "./generations";
import { useRuntimeStore } from "./index";
import { reconcileAfterConnectionLoss, reconcilePromptAfterLateStream } from "./recovery";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";


installRuntimeTestEnvironment();


describe("runtime conversation recovery", () => {
  it.each([
    "session not found in this workspace",
    "session is not active in this workspace",
    "session not active in this workspace",
  ])("recovers a missing session response (%s) to a ready blank conversation", async (message) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) {
        return jsonResponse({ ok: false, error: message }, 404);
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

  it.each([
    "session not found in this workspace",
    "session is not active in this workspace",
    "session not active in this workspace",
  ])("clears the active session when SSE reports terminal missing-session error: %s", async (message) => {
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
      message,
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

  it("settles stale working after a closed stream from the authoritative idle state", async () => {
    let stateReads = 0;
    let messageReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        messageReads += 1;
        return jsonResponse({ messages: [] });
      }
      if (url.includes("/state")) {
        stateReads += 1;
        return jsonResponse(state("session-a", { is_streaming: stateReads === 1 }));
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    expect(useRuntimeStore.getState().working).toBe(true);
    // This is the transport's closed notification, not the store disconnect
    // action, so the listener must perform bounded authoritative recovery.
    useRuntimeStore.getState().client?.disconnect();

    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false));
    expect(messageReads).toBeGreaterThanOrEqual(2);
    expect(stateReads).toBeGreaterThanOrEqual(2);
  });

  it("retries a failed reconnect state read before settling idle", async () => {
    let stateReads = 0;
    let recoveryStateFailures = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) {
        stateReads += 1;
        if (stateReads === 2) {
          recoveryStateFailures += 1;
          return jsonResponse({ error: "temporary state failure" }, 503);
        }
        return jsonResponse(state("session-a", { is_streaming: stateReads === 1 }));
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    expect(useRuntimeStore.getState().working).toBe(true);
    const source = FakeEventSource.instances[0];
    source.readyState = FakeEventSource.CONNECTING;
    source.onerror?.({} as Event);

    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false));
    expect(recoveryStateFailures).toBe(1);
    expect(stateReads).toBeGreaterThanOrEqual(3);
  });

  it("does not clear working when every recovery state read fails", async () => {
    let stateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) {
        stateReads += 1;
        if (stateReads > 1) return jsonResponse({ error: "state unavailable" }, 503);
        return jsonResponse(state("session-a", { is_streaming: true }));
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.readyState = FakeEventSource.CONNECTING;
    source.onerror?.({} as Event);

    await vi.waitFor(() => expect(useRuntimeStore.getState().status).toBe("error"), { timeout: 5_000 });
    expect(stateReads).toBeGreaterThanOrEqual(5);
    expect(useRuntimeStore.getState().working).toBe(true);
  });

  it("uses state idle to settle a turn when agent_settled was missed", async () => {
    let stateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [
        { id: "user-1", role: "user", content: [{ type: "text", text: "previous" }] },
        { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "finished" }] },
      ] });
      if (url.includes("/state")) {
        stateReads += 1;
        return jsonResponse(state("session-a", { is_streaming: stateReads === 1 }));
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    expect(useRuntimeStore.getState().working).toBe(true);
    // No agent_settled is emitted. Reconnect recovery must use the persisted
    // messages plus the authoritative idle state instead.
    const source = FakeEventSource.instances[0];
    source.readyState = FakeEventSource.CONNECTING;
    source.onerror?.({} as Event);

    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false));
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "assistant-1" }),
    );
  });

  it("keeps working and rejects a prompt when reconnect state is explicitly busy", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a", { is_streaming: true }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.readyState = FakeEventSource.CONNECTING;
    source.onerror?.({} as Event);
    await vi.waitFor(() => expect(useRuntimeStore.getState().status).toBe("ready"));

    expect(useRuntimeStore.getState().working).toBe(true);
    await expect(useRuntimeStore.getState().sendPrompt("must not overlap")).rejects.toThrow(
      "The current conversation is still running",
    );
  });

  it("drops a stale connection recovery after switching sessions", async () => {
    let recovery = false;
    let releaseMessages!: (response: Response) => void;
    let releaseState!: (response: Response) => void;
    const delayedMessages = new Promise<Response>((resolve) => { releaseMessages = resolve; });
    const delayedState = new Promise<Response>((resolve) => { releaseState = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("session-a/messages")) return recovery ? delayedMessages : jsonResponse({ messages: [] });
      if (url.includes("session-a/state")) return recovery ? delayedState : jsonResponse(state("session-a"));
      if (url.includes("session-b/messages")) return jsonResponse({ messages: [] });
      if (url.includes("session-b/state")) return jsonResponse(state("session-b", { is_streaming: true }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await useRuntimeStore.getState().connect("/workspace", "session-a");
    recovery = true;
    const client = getClient();
    const staleConnectionGeneration = generations.connection;
    const staleActivityGeneration = generations.activity;
    const reconnecting = reconcileAfterConnectionLoss(
      client,
      "session-a",
      "/workspace",
      staleConnectionGeneration,
      staleActivityGeneration,
    );

    await useRuntimeStore.getState().connect("/workspace", "session-b");
    releaseMessages(jsonResponse({ messages: [] }));
    releaseState(jsonResponse(state("session-a")));
    await reconnecting;

    expect(useRuntimeStore.getState().activeSessionId).toBe("session-b");
    expect(useRuntimeStore.getState().working).toBe(true);
  });

  it("rebuilds conversation history when the durable SSE cursor has expired", async () => {
    let messageReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        messageReads += 1;
        return jsonResponse({ messages: messageReads === 1 ? [] : [{
          id: "assistant-snapshot",
          role: "assistant",
          content: [{ type: "text", text: "durable snapshot" }],
        }] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("stream.gap", {
      type: "stream.gap", sessionId: "session-a", missingCursor: "expired",
    });

    await vi.waitFor(() => expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "assistant-snapshot" }),
    ));
    expect(useRuntimeStore.getState().status).toBe("ready");
  });

  it("keeps Send disabled after a gap when the backend is still busy", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: [{ id: "u", role: "user", content: [{ type: "text", text: "hi" }] }] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a", { is_streaming: true }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].open();
    expect(useRuntimeStore.getState().working).toBe(true);

    FakeEventSource.instances[0].emit("stream.gap", { type: "stream.gap", sessionId: "session-a" });
    await vi.waitFor(() => expect(useRuntimeStore.getState().status).toBe("ready"));

    // The authoritative state read reported the backend still streaming, so
    // working must stay true — Send must not be re-enabled mid-turn.
    expect(useRuntimeStore.getState().working).toBe(true);
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "user", text: "hi" }),
    );
  });

  it("merges history with live output that arrives while gap recovery is in flight", async () => {
    let gapRead = false;
    let releaseMessages: (() => void) | undefined;
    const delayedMessages = new Promise<Response>((resolve) => { releaseMessages = () => resolve(jsonResponse({ messages: [
      { id: "durable", role: "assistant", content: [{ type: "text", text: "durable" }] },
    ] })); });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        if (gapRead) return delayedMessages;
        return jsonResponse({ messages: [] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a", { is_streaming: true }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    gapRead = true;
    const source = FakeEventSource.instances[0];
    source.emit("stream.gap", { type: "stream.gap", sessionId: "session-a" });
    FakeEventSource.instances.at(-1)!.emit("text.updated", { type: "text.updated", sessionId: "session-a", partId: "live", text: "live" });
    releaseMessages!();

    await vi.waitFor(() => expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "durable" }),
    ));
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", parts: [expect.objectContaining({ id: "live", text: "live" })] }),
    );
    expect(useRuntimeStore.getState().working).toBe(true);
  });

  it("does not report ready when gap snapshot requests fail", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        reads += 1;
        if (reads > 1) return jsonResponse({ error: "unavailable" }, 503);
        return jsonResponse({ messages: [] });
      }
      if (url.includes("/state")) {
        if (reads > 1) return jsonResponse({ error: "unavailable" }, 503);
        return jsonResponse(state("session-a"));
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("stream.gap", { type: "stream.gap", sessionId: "session-a" });
    await vi.waitFor(() => expect(useRuntimeStore.getState().status).toBe("error"));
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

  it("settles a fast response that completed before the SSE stream opened", async () => {
    let stateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        return jsonResponse({ messages: stateReads > 1 ? [
          { id: "user-fast", role: "user", content: [{ type: "text", text: "fast" }], timestamp: new Date(Date.now() - 60_000).toISOString() },
          { id: "agent-fast", role: "assistant", content: [{ type: "text", text: "done" }], timestamp: new Date(Date.now() + 60_000).toISOString() },
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

  it("replaces the thread with the settle-time snapshot without duplicating the live turn", async () => {
    let messagesReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        messagesReads += 1;
        // Complete authoritative snapshot: JSONL ids that never match the live
        // block ids (user-<ts> / SSE partId).
        return jsonResponse({ messages: [
          { id: "user-durable", role: "user", content: [{ type: "text", text: "hello" }], timestamp: "2026-01-01T00:00:00Z" },
          { id: "agent-durable", role: "assistant", content: [{ type: "text", text: "world" }], timestamp: "2026-01-01T00:00:01Z" },
        ] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].open();

    await useRuntimeStore.getState().sendPrompt("hello");
    // Live turn: user block id is user-<ts>; agent block id is the SSE partId.
    FakeEventSource.instances.at(-1)!.emit("text.updated", { type: "text.updated", sessionId: "session-a", partId: "live-part", text: "world" });
    expect(useRuntimeStore.getState().thread.blocks.some((b) => b.kind === "user")).toBe(true);
    expect(useRuntimeStore.getState().thread.blocks.some((b) => b.kind === "agent" && (b as { parts?: Array<{ id: string }> }).parts?.some((p) => p.id === "live-part"))).toBe(true);

    FakeEventSource.instances.at(-1)!.emit("session.idle", { type: "session.idle", sessionId: "session-a" });
    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false));
    await vi.waitFor(() => {
      const ids = useRuntimeStore.getState().thread.blocks.map((b) => b.id);
      expect(ids).toEqual(["user-durable", "agent-durable"]);
    });

    const blocks = useRuntimeStore.getState().thread.blocks;
    // Exactly the snapshot content: one user + one agent, no live duplicates.
    expect(blocks.filter((b) => b.kind === "user").map((b) => b.id)).toEqual(["user-durable"]);
    expect(blocks.filter((b) => b.kind === "agent").map((b) => b.id)).toEqual(["agent-durable"]);
    expect(blocks.some((b) => (b as { parts?: Array<{ id: string }> }).parts?.some((p) => p.id === "live-part"))).toBe(false);
  });

  it("keeps monitoring when the runtime is idle but this turn has no reply yet", async () => {
    let reads = 0;
    const oldMessages = () => [
      { id: "user-old", role: "user", content: [{ type: "text", text: "previous" }], timestamp: new Date(Date.now() - 7_200_000).toISOString() },
      { id: "agent-old", role: "assistant", content: [{ type: "text", text: "old reply" }], timestamp: new Date(Date.now() - 7_200_000 + 1_000).toISOString() },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        reads += 1;
        // History already contains an OLD assistant message; the late reply
        // only appears once reads >= 3 (after the monitor's first idle check).
        return jsonResponse({ messages: reads >= 3 ? [...oldMessages(), {
          id: "agent-new", role: "assistant", content: [{ type: "text", text: "late reply" }], timestamp: new Date(Date.now() + 60_000).toISOString(),
        }] : oldMessages() });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    await useRuntimeStore.getState().sendPrompt("late stream");

    // Old-history assistant + idle runtime must NOT settle the monitor: the
    // reply belongs to a previous turn, so Send stays disabled.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(useRuntimeStore.getState().working).toBe(true);

    // Once the reply for THIS turn lands in the persisted history, the
    // monitor settles and resyncs the conversation.
    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false), { timeout: 5_000 });
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "agent-new" }),
    );
  });

  it("settles when a reply written after the prompt is already visible", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        reads += 1;
        return jsonResponse({ messages: reads > 1 ? [
          { id: "user-1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date(Date.now() - 60_000).toISOString() },
          { id: "agent-1", role: "assistant", content: [{ type: "text", text: "done" }], timestamp: new Date(Date.now() + 60_000).toISOString() },
        ] : [] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    await useRuntimeStore.getState().sendPrompt("hi");

    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false), { timeout: 4_000 });
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "agent-1" }),
    );
  });

  it("keeps monitoring with a baseline when the latest assistant message has no timestamp (idle cap settles)", async () => {
    let stateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        // The latest assistant message carries no parseable timestamp: it
        // cannot be attributed to this turn, so the baseline path must NOT
        // settle — monitoring continues until the idle cap.
        return jsonResponse({ messages: [
          { id: "user-1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date(Date.now() - 60_000).toISOString() },
          { id: "agent-nots", role: "assistant", content: [{ type: "text", text: "no timestamp" }] },
        ] });
      }
      if (url.includes("/state")) {
        stateReads += 1;
        return jsonResponse(state("session-a"));
      }
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "session-a",
      working: true,
      status: "connecting",
      thread: { blocks: [], index: {}, loaded: false },
    });
    const monitorGeneration = generations.promptMonitor;
    // Baseline IS provided, but the assistant message has no timestamp →
    // reply unconfirmed → the monitor must keep polling (no early settle).
    void reconcilePromptAfterLateStream(getClient(), "session-a", "/workspace", monitorGeneration, Date.now(), 3);

    // Well past several REST rounds the monitor is still polling.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(useRuntimeStore.getState().working).toBe(true);
    expect(stateReads).toBeGreaterThan(0);

    // The idle cap (3 idle rounds) eventually settles the monitor.
    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false), { timeout: 10_000 });
    expect(useRuntimeStore.getState().status).toBe("ready");
  });

  it("settles via the idle cap when no reply can be confirmed (no baseline, no timestamps)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) {
        // Assistant message without a parseable timestamp: cannot be
        // attributed to this turn — conservative path keeps monitoring.
        return jsonResponse({ messages: [{ id: "old-a", role: "assistant", content: [{ type: "text", text: "old" }] }] });
      }
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: "session-a",
      working: true,
      status: "connecting",
      thread: { blocks: [], index: {}, loaded: false },
    });
    const monitorGeneration = generations.promptMonitor;
    void reconcilePromptAfterLateStream(getClient(), "session-a", "/workspace", monitorGeneration, undefined, 2);

    await vi.waitFor(() => expect(useRuntimeStore.getState().working).toBe(false), { timeout: 5_000 });
    expect(useRuntimeStore.getState().status).toBe("ready");
  });
});
