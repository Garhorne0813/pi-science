import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clampThinkingLevel, getSessionName, moveSessionName, PiScienceClient, setSessionName } from "./pi-science-client";
import { readSettingsResponse } from "./settings-api";
import { useRuntimeStore } from "./runtime-store";


class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private handlers = new Map<string, Array<(event: { data?: string; lastEventId?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const callback = typeof handler === "function"
      ? handler as unknown as (event: { data?: string; lastEventId?: string }) => void
      : (event: { data?: string; lastEventId?: string }) => handler.handleEvent(event as unknown as Event);
    this.handlers.set(type, [...(this.handlers.get(type) || []), callback]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({} as Event);
  }

  emit(type: string, payload: unknown, lastEventId?: string): void {
    const event = { data: JSON.stringify(payload), lastEventId };
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
}


beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  // Provide a minimal localStorage mock so message cache tests work in jsdom.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe("PiScienceClient conversation transport", () => {
  it("clamps Think to the nearest level supported by the selected model", () => {
    expect(clampThinkingLevel("max", ["off", "minimal", "low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(clampThinkingLevel("high", ["minimal", "low", "medium", "high", "xhigh"])).toBe("high");
    expect(clampThinkingLevel("high", ["off"])).toBe("off");
    expect(clampThinkingLevel("unknown", ["minimal", "low"])).toBe("minimal");
  });

  it("keeps listeners across reconnects and drops stale or cross-session events", () => {
    const client = new PiScienceClient();
    const events: string[] = [];
    client.onEvent((event) => events.push(`${event.type}:${event.sessionId}`));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    client.connect("session-a", "/workspace");
    const first = FakeEventSource.instances[0];
    first.open();
    client.connect("session-b", "/workspace");
    const second = FakeEventSource.instances[1];
    second.open();

    first.emit("text.updated", { type: "text.updated", sessionId: "session-a", text: "stale" });
    second.emit("text.updated", { type: "text.updated", sessionId: "session-a", text: "wrong" });
    second.emit("text.updated", { type: "text.updated", sessionId: "session-b", text: "current" });
    second.onerror?.({ data: "application error event" } as unknown as Event);

    expect(events).toContain("connection.open:session-a");
    expect(events).toContain("connection.open:session-b");
    expect(events.filter((entry) => entry === "text.updated:session-b")).toHaveLength(1);
    expect(events).not.toContain("text.updated:session-a");
    expect(events).not.toContain("connection.reconnecting:session-b");
    expect(client.connectedSessionId).toBe("session-b");
  });

  it("inherits backend model settings when creating a session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "session-luna",
      cwd: "/workspace",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PiScienceClient();

    await client.createSession("/workspace");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ cwd: "/workspace", config: {} });
  });

  it("does not relabel an existing SSE transport before the new session connects", async () => {
    const client = new PiScienceClient();
    client.connect("session-a", "/workspace");
    FakeEventSource.instances[0].open();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "session-b",
      cwd: "/workspace",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await client.createSession("/workspace");

    expect(client.connectedSessionId).toBe("session-a");
  });

  it("surfaces delete failures instead of silently removing the UI entry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "cannot delete a conversation while it is running",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));
    const client = new PiScienceClient();

    await expect(client.deleteSession("session-a", "/workspace"))
      .rejects.toThrow("cannot delete");
  });

  it("preserves backend detail errors across conversation endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "session index unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Invalid API key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new PiScienceClient();

    await expect(client.listSessions("/workspace")).rejects.toThrow("session index unavailable");
    await expect(client.sendPrompt("session-a", "hello", "/workspace")).rejects.toThrow("Invalid API key");
  });

  it("closes a terminal missing-session stream without reconnecting", () => {
    const client = new PiScienceClient();
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    client.connect("missing", "/workspace");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("error", {
      type: "error",
      sessionId: "missing",
      message: "session not found in this workspace",
      terminal: true,
    });

    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(client.connectedSessionId).toBeNull();
    expect(events).toContain("error");
    source.onerror?.({} as Event);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("forwards a terminal runtime error once and closes the transport", () => {
    const client = new PiScienceClient();
    const events: Array<{ type: string; message?: unknown }> = [];
    client.onEvent((event) => events.push(event));

    client.connect("session-a", "/workspace");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("error", {
      type: "error",
      sessionId: "session-a",
      message: "OpenAI API error (401): Invalid API key",
      terminal: true,
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("Invalid API key"),
    }));
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(client.connectedSessionId).toBeNull();
    source.onerror?.({} as Event);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("settings response handling", () => {
  it("accepts successful JSON responses", async () => {
    await expect(readSettingsResponse<{ ok: boolean }>(new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }), "fallback")).resolves.toEqual({ ok: true });
  });

  it("uses the backend error field before detail or fallback", async () => {
    await expect(readSettingsResponse(new Response(JSON.stringify({
      error: "custom provider could not be saved",
      detail: "less specific detail",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }), "fallback")).rejects.toThrow("custom provider could not be saved");
  });

  it("supports detail and fallback errors for compatibility responses", async () => {
    await expect(readSettingsResponse(new Response('{"detail":"invalid provider URL"}', {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }), "fallback")).rejects.toThrow("invalid provider URL");

    await expect(readSettingsResponse(new Response("not json", { status: 502 }), "settings unavailable"))
      .rejects.toThrow("settings unavailable");
  });

  it("applies REST session replacements from successful settings responses", async () => {
    useRuntimeStore.setState({
      cwd: "/workspace",
      activeSessionId: null,
      sessions: [{ id: "old", cwd: "/workspace", name: "Named conversation" }],
    });

    await readSettingsResponse(new Response(JSON.stringify({
      ok: true,
      session_replacements: [{ cwd: "/workspace", oldId: "old", newId: "new" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }), "fallback");

    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "new", name: "Named conversation" }),
    );
  });
});

describe("PiScienceClient SSE cursor resumption", () => {
  it("passes the last known event id as a query parameter on reconnect", () => {
    const client = new PiScienceClient();
    client.connect("session-a", "/workspace");
    const source = FakeEventSource.instances[0];
    source.open();

    // Simulate the backend sending an event with an id.
    source.emit("text.updated", { type: "text.updated", sessionId: "session-a", text: "hello" }, "epoch:42");

    // Disconnect and reconnect to the same session.
    client.disconnect();
    client.connect("session-a", "/workspace");

    const reconnectUrl = FakeEventSource.instances[1].url;
    expect(reconnectUrl).toContain("lastEventId=epoch%3A42");
  });

  it("does not pass lastEventId on the first connection (no cursor yet)", () => {
    const client = new PiScienceClient();
    client.connect("session-fresh", "/workspace");
    const url = FakeEventSource.instances[0].url;
    expect(url).not.toContain("lastEventId");
  });

  it("clears the cursor when a session is deleted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const client = new PiScienceClient();
    client.connect("session-del", "/workspace");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("text.updated", { type: "text.updated", sessionId: "session-del", text: "data" }, "epoch:5");

    await client.deleteSession("session-del", "/workspace");

    // Disconnect and reconnect — should not include the old cursor.
    client.disconnect();
    client.connect("session-del", "/workspace");
    const url = FakeEventSource.instances[1].url;
    expect(url).not.toContain("lastEventId");
  });

  it("isolates SSE cursor by workspace — same sessionId different cwd", () => {
    const client = new PiScienceClient();

    // Connect to session-A in workspace-A, receive an event with id
    client.connect("same-id", "/workspace-A");
    const sourceA = FakeEventSource.instances[0];
    sourceA.open();
    sourceA.emit("text.updated", { type: "text.updated", sessionId: "same-id", text: "A" }, "epochA:9");

    // Connect to same-id in workspace-B
    client.disconnect();
    client.connect("same-id", "/workspace-B");
    const sourceB = FakeEventSource.instances[1];
    sourceB.open();

    // workspace-B must NOT carry workspace-A's cursor
    expect(sourceB.url).not.toContain("epochA");
    expect(sourceB.url).not.toContain("lastEventId");
  });

  it("does not advance cursor for events belonging to a different session", () => {
    const client = new PiScienceClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    client.connect("session-b", "/workspace");
    const source = FakeEventSource.instances[0];
    source.open();

    // Simulate a foreign event arriving on session-b's stream
    source.emit("text.updated", { type: "text.updated", sessionId: "session-a", text: "foreign" }, "foreign:99");

    // Disconnect and reconnect — must NOT carry the foreign cursor
    client.disconnect();
    client.connect("session-b", "/workspace");
    const reconnectUrl = FakeEventSource.instances[1].url;
    expect(reconnectUrl).not.toContain("foreign");
    expect(reconnectUrl).not.toContain("lastEventId");
  });

  it("rebuilds the EventSource without a cursor after stream.gap", () => {
    const client = new PiScienceClient();
    client.connect("session-gap", "/workspace");
    const first = FakeEventSource.instances[0];
    first.open();

    // First receive a valid event to set the cursor
    first.emit("text.updated", { type: "text.updated", sessionId: "session-gap", text: "ok" }, "epoch:10");

    // stream.gap must clear the cursor AND proactively rebuild the transport
    // without it, so the browser's native EventSource auto-reconnect cannot
    // re-send the stale cursor (which would re-trigger the gap in a loop).
    first.emit("stream.gap", { type: "stream.gap", sessionId: "session-gap" }, undefined);

    const reconnect = FakeEventSource.instances[1];
    expect(reconnect).toBeDefined();
    expect(reconnect.url).not.toContain("lastEventId");
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(client.isConnectedTo("session-gap", "/workspace")).toBe(true);
  });

  it("does not reconnect after a gap if a listener disconnected during emit", () => {
    const client = new PiScienceClient();
    // A listener that reacts to the gap by disconnecting the client must
    // prevent the proactive reconnect — otherwise we would forcibly re-open a
    // stream to a session the user just left.
    client.onEvent((event) => {
      if (event.type === "stream.gap") client.disconnect();
    });
    client.connect("session-gap-dc", "/workspace");
    const first = FakeEventSource.instances[0];
    first.open();
    first.emit("stream.gap", { type: "stream.gap", sessionId: "session-gap-dc" }, undefined);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(client.connectedSessionId).toBeNull();
  });
});

describe("PiScienceClient session name migration and storage resilience", () => {
  it("migrates a v2 single-key session name to the composite (cwd, sessionId) key", () => {
    // Simulate a v2 payload stored before the composite-key change.
    localStorage.setItem("pi-science.session-names", JSON.stringify({ "legacy-id": "Old Name" }));
    expect(getSessionName("/workspace", "legacy-id")).toBe("Old Name");
    // The store should now hold the migrated composite key, not the bare id.
    const migrated = JSON.parse(localStorage.getItem("pi-science.session-names")!);
    expect(migrated["/workspace\0legacy-id"]).toBe("Old Name");
    expect(migrated["legacy-id"]).toBeUndefined();
  });

  it("returns an empty string (never an object) for a corrupt object name value", () => {
    localStorage.setItem("pi-science.session-names", JSON.stringify({ "/workspace\0bad": { bad: true } }));
    const value = getSessionName("/workspace", "bad");
    expect(typeof value).toBe("string");
    expect(value).toBe("");
  });

  it("moves a legacy name without restoring the bare legacy key", () => {
    localStorage.setItem("pi-science.session-names", JSON.stringify({ "legacy-id": "Legacy" }));
    expect(moveSessionName("/workspace", "legacy-id", "new-id")).toBe("Legacy");
    const stored = JSON.parse(localStorage.getItem("pi-science.session-names")!);
    expect(stored["/workspace\0new-id"]).toBe("Legacy");
    expect(stored["legacy-id"]).toBeUndefined();
  });

  it("never returns an object when the destination name is corrupt", () => {
    localStorage.setItem("pi-science.session-names", JSON.stringify({
      "/workspace\0old": "Old",
      "/workspace\0new": { bad: true },
    }));
    expect(moveSessionName("/workspace", "old", "new")).toBe("Old");
    expect(typeof getSessionName("/workspace", "new")).toBe("string");
  });

  it("drops a cached message entry that is missing a finite cachedAt", () => {
    localStorage.setItem("pi-science.msg-cache", JSON.stringify({
      "/workspace\0s": { messages: [{ id: "m", role: "user", content: [{ type: "text", text: "hi" }] }] },
    }));
    const client = new PiScienceClient();
    expect(client.getCachedMessages("s", "/workspace")).toBeNull();
    // The bad entry must be evicted from storage, not merely ignored.
    const stored = JSON.parse(localStorage.getItem("pi-science.msg-cache")!);
    expect(stored["/workspace\0s"]).toBeUndefined();
  });

  it("does not throw and sanitizes messages containing null or malformed entries", () => {
    localStorage.setItem("pi-science.msg-cache", JSON.stringify({
      "/workspace\0s": {
        cachedAt: Date.now(),
        messages: [
          null,
          { role: "user" }, // missing id
          { id: "m1", role: "user", content: [{ type: "text", text: "ok" }, null] },
          { id: "m2", role: "assistant", content: "not-an-array" },
        ],
      },
    }));
    const client = new PiScienceClient();
    expect(() => client.getCachedMessages("s", "/workspace")).not.toThrow();
    const cached = client.getCachedMessages("s", "/workspace");
    expect(cached).not.toBeNull();
    // Every surviving message is well-formed: string id/role and an array
    // content with no null elements.
    expect(cached!.every(
      (m) => typeof m.id === "string" && typeof m.role === "string" && Array.isArray(m.content),
    )).toBe(true);
    // The null content element in m1 is dropped; m2 keeps an empty array.
    const m1 = cached!.find((m) => m.id === "m1")!;
    expect(m1.content).toHaveLength(1);
  });
});

describe("PiScienceClient cache storage resilience", () => {
  it("does not throw when the cached message store holds a non-object value", async () => {
    // A corrupt or legacy entry could store the literal "null"; JSON.parse
    // returns null, which must not crash the cache read/write path.
    localStorage.setItem("pi-science.msg-cache", "null");
    const client = new PiScienceClient();
    expect(() => client.getCachedMessages("session-x", "/workspace")).not.toThrow();
    expect(client.getCachedMessages("session-x", "/workspace")).toBeNull();

    // A subsequent successful load must overwrite the corrupt entry.
    const messages = [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await client.getMessages("session-x", "/workspace");
    expect(client.getCachedMessages("session-x", "/workspace")).toHaveLength(1);
  });

  it("does not throw when the session-name store holds a non-object value", () => {
    localStorage.setItem("pi-science.session-names", "null");
    expect(() => setSessionName("/workspace", "session-x", "My chat")).not.toThrow();
    expect(getSessionName("/workspace", "session-x")).toBe("My chat");
  });
});

describe("PiScienceClient message cache", () => {
  it("caches messages after getMessages and serves them on getCachedMessages", async () => {
    const messages = [
      { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const client = new PiScienceClient();

    // Before the first fetch, no cache.
    expect(client.getCachedMessages("session-x", "/workspace")).toBeNull();

    await client.getMessages("session-x", "/workspace");

    const cached = client.getCachedMessages("session-x", "/workspace");
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);
    expect(cached![0].content[0]?.text).toBe("hi");
  });

  it("returns null for a session that has never been fetched", () => {
    const client = new PiScienceClient();
    expect(client.getCachedMessages("never-fetched", "/workspace")).toBeNull();
  });

  it("isolates cache by workspace — same sessionId different cwd", async () => {
    const messagesA = [{ id: "m1", role: "user", content: [{ type: "text", text: "secret-A" }] }];
    const messagesB = [{ id: "m1", role: "user", content: [{ type: "text", text: "secret-B" }] }];
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      const messages = callCount === 1 ? messagesA : messagesB;
      return Promise.resolve(new Response(JSON.stringify({ messages }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    const client = new PiScienceClient();

    // Fetch session-x in workspace-A
    await client.getMessages("same-id", "/workspace-A");
    // Fetch session-x in workspace-B
    await client.getMessages("same-id", "/workspace-B");

    // Cache must be isolated — A must not leak into B
    const cachedA = client.getCachedMessages("same-id", "/workspace-A");
    const cachedB = client.getCachedMessages("same-id", "/workspace-B");
    expect(cachedA![0].content[0]?.text).toBe("secret-A");
    expect(cachedB![0].content[0]?.text).toBe("secret-B");
  });

  it("removes all expired entries when any cache entry is read", () => {
    const now = Date.now();
    localStorage.setItem("pi-science.msg-cache", JSON.stringify({
      "/workspace\0expired": {
        cachedAt: now - 31 * 60 * 1000,
        messages: [{ id: "old", role: "user", content: [] }],
      },
      "/workspace\0future": {
        cachedAt: now + 60 * 60 * 1000,
        messages: [{ id: "future", role: "user", content: [] }],
      },
    }));
    const client = new PiScienceClient();
    expect(client.getCachedMessages("missing", "/workspace")).toBeNull();
    const stored = JSON.parse(localStorage.getItem("pi-science.msg-cache")!);
    expect(stored).toEqual({});
  });
});
