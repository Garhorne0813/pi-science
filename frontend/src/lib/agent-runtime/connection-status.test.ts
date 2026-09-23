/** Foreground availability vs. transport repair.
 *
 *  A working conversation repairs its SSE stream routinely (watchdog, late
 *  stream probe, gap recovery). Those repairs belong to transport diagnostics;
 *  the user-facing status may only change for a foreground attach, an explicit
 *  detach, or an authoritative recovery that gave up. */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { getClient } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
import { getMessagesPage } from "../client/rest";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";
import { resetTransportDiagnostics, transportDiagnostics, type TransportStatus } from "./transport-status";

installRuntimeTestEnvironment();

/** Record every store change so a test can assert on the transitions the user
 *  would actually see, not just the settled end state. */
function recordStatus(): { foreground: string[]; transport: TransportStatus[]; stop: () => void } {
  const foreground: string[] = [];
  const transport: TransportStatus[] = [];
  const stop = useRuntimeStore.subscribe((current) => {
    foreground.push(current.status);
    transport.push(current.transportStatus);
  });
  return { foreground, transport, stop };
}

function stubFetch(overrides: { messages?: () => unknown; runtimeState?: () => unknown } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages")) return jsonResponse(overrides.messages?.() ?? { messages: [] });
    if (url.includes("/state")) return jsonResponse(overrides.runtimeState?.() ?? state("session-a"));
    if (url.includes("/artifacts")) return jsonResponse([]);
    if (url.startsWith("/api/sessions?")) return jsonResponse([]);
    if (url.includes("/prompt")) return jsonResponse({ ok: true, id: "session-a" });
    throw new Error(`Unexpected request: ${url}`);
  }));
}

describe("conversation connection status", () => {
  beforeEach(() => {
    resetTransportDiagnostics();
  });

  it("shows connecting for a foreground attach and ready once the stream opens", async () => {
    stubFetch();
    const seen = recordStatus();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    expect(useRuntimeStore.getState()).toMatchObject({ status: "connecting", transportStatus: "connecting" });

    FakeEventSource.instances[0].open();
    seen.stop();
    expect(useRuntimeStore.getState()).toMatchObject({ status: "ready", transportStatus: "open" });
    expect(seen.foreground).toContain("connecting");
  });

  it("shows connecting while switching to another session", async () => {
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].open();
    expect(useRuntimeStore.getState().status).toBe("ready");

    await useRuntimeStore.getState().connect("/workspace", "session-b");
    expect(useRuntimeStore.getState().status).toBe("connecting");
    FakeEventSource.instances.at(-1)!.open();
    expect(useRuntimeStore.getState()).toMatchObject({ status: "ready", transportStatus: "open" });
  });

  it("keeps a ready conversation ready while its stream is rebuilt in the background", async () => {
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].open();
    const seen = recordStatus();

    getClient().reconnect("session-a", "/workspace", "turn_watchdog");
    FakeEventSource.instances.at(-1)!.open();
    seen.stop();

    expect(seen.foreground).not.toContain("connecting");
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(transportDiagnostics().counters).toMatchObject({ reconnects: 1, foregroundDemotions: 0 });
    expect(transportDiagnostics().counters.byReason.turn_watchdog).toBe(1);
  });

  it("keeps ready when the browser reports the stream reconnecting", async () => {
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    const seen = recordStatus();

    source.onerror?.({} as Event);
    await vi.waitFor(() => expect(useRuntimeStore.getState().transportStatus).toBe("open"), { timeout: 5_000 });
    seen.stop();

    expect(seen.foreground).not.toContain("connecting");
    expect(seen.foreground).not.toContain("error");
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(transportDiagnostics().counters.foregroundDemotions).toBe(0);
  });

  it("rebases after a stream gap without a visible connection phase", async () => {
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    const seen = recordStatus();

    source.emit("stream.gap", { type: "stream.gap", sessionId: "session-a" });
    expect(useRuntimeStore.getState().transportStatus).toBe("recovering");
    expect(useRuntimeStore.getState().status).toBe("ready");

    await vi.waitFor(() => expect(useRuntimeStore.getState().transportStatus).toBe("open"), { timeout: 5_000 });
    seen.stop();

    expect(seen.foreground).not.toContain("connecting");
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(transportDiagnostics().log.some((entry) => entry.reason === "stream_gap" && entry.nextTransport === "recovering")).toBe(true);
  });

  it("surfaces error only after gap recovery is exhausted", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      return jsonResponse({ error: "unavailable" }, 503);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();

    source.emit("stream.gap", { type: "stream.gap", sessionId: "session-a" });
    await vi.waitFor(() => expect(useRuntimeStore.getState().status).toBe("error"), { timeout: 10_000 });
    expect(useRuntimeStore.getState().transportStatus).toBe("error");
  });

  it("reports offline for an explicit detach", async () => {
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].open();

    useRuntimeStore.getState().disconnect();
    expect(useRuntimeStore.getState()).toMatchObject({ status: "offline", transportStatus: "closed" });
  });

  it("attributes a session switch to the transport log", async () => {
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].open();
    await useRuntimeStore.getState().connect("/workspace", "session-b");
    FakeEventSource.instances.at(-1)!.open();

    const { log } = transportDiagnostics();
    expect(log.some((entry) => entry.reason === "session_switch")).toBe(true);
    expect(log.every((entry) => typeof entry.previousTransport === "string")).toBe(true);
  });

  it("keeps the applied cursor semantics for background repairs", async () => {
    // Regression guard for the transport change: reconnecting must not drop the
    // session's resume cursor, otherwise a repair would replay the whole log.
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("text.updated", { type: "text.updated", sessionId: "session-a", partId: "p-1", text: "hi" }, "epoch-1:7");

    getClient().reconnect("session-a", "/workspace", "late_stream_probe");
    const reconnected = FakeEventSource.instances.at(-1)!;
    expect(reconnected.url).toContain("lastEventId=epoch-1%3A7");
  });
});

describe("history paging reads", () => {
  it("stays independent from the connection status model", async () => {
    // The status split must not change how history pages are fetched.
    stubFetch();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }] });
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      return jsonResponse({ error: "unexpected" }, 500);
    }));
    const page = await getMessagesPage("/workspace", "session-a");
    expect(page.messages).toHaveLength(1);
  });
});

describe("stream envelope completeness", () => {
  beforeEach(() => {
    resetTransportDiagnostics();
  });

  it("does not read a stats record as a hole in the stream", async () => {
    // Every published record carries its stream position, including records
    // without turn identity such as session stats. A missing one would be read
    // as a lost event and force an authoritative rebase of a healthy turn.
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("text.updated", { type: "text.updated", sessionId: "session-a", partId: "p-1", text: "hello", schemaVersion: 2, seq: 1, eventId: "epoch-1:1", streamEpoch: "epoch-1" }, "epoch-1:1");
    expect(useRuntimeStore.getState().thread.foldState?.reconciliationRequired).toBe(false);

    source.emit("session.stats", { type: "session.stats", sessionId: "session-a", schemaVersion: 2, seq: 2, eventId: "epoch-1:2", streamEpoch: "epoch-1", stats: { turns: 1 } }, "epoch-1:2");
    source.emit("text.updated", { type: "text.updated", sessionId: "session-a", partId: "p-1", text: " world", schemaVersion: 2, seq: 3, eventId: "epoch-1:3", streamEpoch: "epoch-1" }, "epoch-1:3");

    expect(useRuntimeStore.getState().thread.foldState?.reconciliationRequired).toBe(false);
    expect(transportDiagnostics().counters.byReason.stream_gap).toBeUndefined();
    const agent = useRuntimeStore.getState().thread.blocks.find((block) => block.kind === "agent");
    expect(agent && agent.kind === "agent" && agent.parts.map((part) => part.text).join("")).toBe("hello world");
  });

  it("still demands recovery for a genuinely missing sequence", async () => {
    stubFetch();
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.open();
    source.emit("text.updated", { type: "text.updated", sessionId: "session-a", partId: "p-1", text: "a", schemaVersion: 2, seq: 1, eventId: "epoch-1:1", streamEpoch: "epoch-1" }, "epoch-1:1");
    // Sequence 2 never arrives on this stream: the projection is provisional.
    source.emit("text.updated", { type: "text.updated", sessionId: "session-a", partId: "p-1", text: "c", schemaVersion: 2, seq: 3, eventId: "epoch-1:3", streamEpoch: "epoch-1" }, "epoch-1:3");

    expect(useRuntimeStore.getState().thread.foldState?.reconciliationRequired).toBe(true);
    expect(transportDiagnostics().log.some((entry) => entry.reason === "stream_gap" && entry.detail?.includes("discontinuity"))).toBe(true);
  });
});
