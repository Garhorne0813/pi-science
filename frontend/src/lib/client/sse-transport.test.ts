import { describe, expect, it, vi } from "vitest";

import { PiScienceClient } from "./pi-science-client";
import { FakeEventSource, installClientTestEnvironment } from "./test-helpers";


installClientTestEnvironment();


describe("PiScienceClient conversation transport", () => {
  it("releases a hidden tab's stream and resumes from the applied cursor", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const client = new PiScienceClient();
    client.connect("session-a", "/workspace");
    const first = FakeEventSource.instances[0];
    first.open();
    first.emit("text.updated", { type: "text.updated", sessionId: "session-a", text: "before" }, "epoch:42");

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    client.reconnect("session-a", "/workspace");
    expect(FakeEventSource.instances).toHaveLength(1);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances[1].url).toContain("lastEventId=epoch%3A42");
    client.disconnect();
  });

  it("requests gap recovery when a hidden stream has no applied cursor", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const client = new PiScienceClient();
    client.connect("session-a", "/workspace");
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances[1].url).toContain("lastEventId=pi-recovery-sentinel%3A0");
    client.disconnect();
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

  it("forwards the named session.stats event to listeners", () => {
    const client = new PiScienceClient();
    const stats: unknown[] = [];
    client.onEvent((event) => { if (event.type === "session.stats") stats.push(event); });

    client.connect("session-a", "/workspace");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("session.stats", {
      type: "session.stats",
      sessionId: "session-a",
      stats: { userMessages: 3, toolCalls: 7, tokens: { input: 10, output: 20 } },
    });

    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual(expect.objectContaining({ type: "session.stats", sessionId: "session-a" }));
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
  it("forcibly rebuilds an open stream while preserving its resume cursor", () => {
    const client = new PiScienceClient();
    client.connect("session-a", "/workspace");
    const first = FakeEventSource.instances[0];
    first.open();
    first.emit("text.updated", { type: "text.updated", sessionId: "session-a", text: "hello" }, "epoch:42");

    client.reconnect("session-a", "/workspace");

    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("lastEventId=epoch%3A42");
  });

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

  it("keeps the registered gap stream as a live fence until a new event advances the applied cursor", () => {
    const client = new PiScienceClient();
    client.connect("session-gap", "/workspace");
    const first = FakeEventSource.instances[0];
    first.open();

    // This is the last event that the reducer definitely applied before the
    // server reports that the requested replay can no longer be satisfied.
    first.emit("text.updated", { type: "text.updated", sessionId: "session-gap", text: "ok" }, "epoch:10");
    first.emit("stream.gap", { type: "stream.gap", sessionId: "session-gap" }, undefined);

    // The server registers the subscriber before generating stream.gap, so
    // this exact source is already a live fence. Recovery must not tear it down.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.readyState).not.toBe(FakeEventSource.CLOSED);
    expect(client.isConnectedTo("session-gap", "/workspace")).toBe(true);

    // Existing recovery/watchdog reconnect calls are suppressed while the
    // fence is active; otherwise they would recreate the subscribe blind spot.
    client.reconnect("session-gap", "/workspace");
    expect(FakeEventSource.instances).toHaveLength(1);

    // Once a post-gap event is successfully applied, its id becomes the safe
    // replay point and normal reconnect behavior resumes.
    first.emit("text.updated", { type: "text.updated", sessionId: "session-gap", text: "after gap" }, "epoch-new:11");
    client.reconnect("session-gap", "/workspace");

    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("lastEventId=epoch-new%3A11");
  });

  it("uses the last applied cursor for recovery instead of the newest received cursor", async () => {
    const client = new PiScienceClient();
    client.onEvent((event) => event.type === "text.updated" ? false : undefined);
    client.connect("session-rejected", "/workspace");
    const source = FakeEventSource.instances[0];
    source.open();

    // The transport receives an id, but the reducer rejects the event. That id
    // must never become a resume cursor because doing so could skip the event.
    source.emit("text.updated", { type: "text.updated", sessionId: "session-rejected", text: "not applied" }, "epoch:9");

    await expect(client.getConversationResumeCursor("session-rejected", "/workspace"))
      .resolves.toBe("pi-recovery-sentinel:0");
  });

  it("forces a server-declared gap when recovery has no applied cursor", async () => {
    const client = new PiScienceClient();

    // A non-empty, valid cursor shape is intentional: an empty/no-cursor SSE
    // is future-only on the server. The missing sentinel makes readAfter()
    // return stream.gap after the live subscriber is already registered.
    await expect(client.getConversationResumeCursor("session-fresh", "/workspace"))
      .resolves.toBe("pi-recovery-sentinel:0");
  });

  it("does not reconnect after a gap if a listener disconnected during emit", () => {
    const client = new PiScienceClient();
    // A listener that reacts to the gap by disconnecting the client must
    // prevent any recovery reconnect — otherwise we would forcibly re-open a
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
