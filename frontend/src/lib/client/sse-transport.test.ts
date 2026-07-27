import { describe, expect, it, vi } from "vitest";

import { PiScienceClient } from "../pi-science-client";
import { FakeEventSource, installClientTestEnvironment } from "./test-helpers";


installClientTestEnvironment();


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
