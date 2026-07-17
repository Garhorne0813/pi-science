import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiScienceClient } from "./pi-science-client";


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


beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe("PiScienceClient conversation transport", () => {
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
});
