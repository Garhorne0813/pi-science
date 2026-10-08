import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../client/query-client";
import { runsKey } from "../runs";
import { useRuntimeStore } from "./index";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  useRuntimeStore.getState().disconnect();
  vi.useRealTimers();
});

const CWD = "/workspace";
const SESSION = "session-runs";

async function connectStream() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages")) return jsonResponse({ messages: [] });
    if (url.includes("/state")) return jsonResponse(state(SESSION));
    if (url.startsWith("/api/sessions?")) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  }));
  await useRuntimeStore.getState().connect(CWD, SESSION);
  const source = FakeEventSource.instances.at(-1)!;
  source.open();
  return source;
}

/** The invalidate is debounced, so nothing observable happens until the clock
 *  passes the coalescing window. */
async function flushSignal() {
  await vi.advanceTimersByTimeAsync(500);
}

describe("execution invalidation on the conversation stream", () => {
  it("invalidates each boundary in a versioned operation/tool sequence", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const events = [
      { type: "operation.started" },
      { type: "tool.started", callId: "call-1", itemId: "call-1", tool: "bash", input: {}, status: "running", startedAt: "2026-10-08T00:00:00.000Z" },
      { type: "tool.completed", callId: "call-1", itemId: "call-1", tool: "bash", status: "done", output: "ok", endedAt: "2026-10-08T00:00:01.000Z" },
      { type: "operation.settled", status: "completed", outcome: "ok" },
    ];
    for (const [index, event] of events.entries()) {
      const payload = { ...event, sessionId: SESSION, turnId: "turn-1", runId: "run-1", turnOrdinal: 1 };
      source.emit(event.type, {
        ...payload, payload,
        schemaVersion: 3, workspaceId: CWD, streamEpoch: "epoch",
        eventId: `epoch:${index + 1}`, seq: index + 1,
        occurredAt: "2026-10-08T00:00:00.000Z",
      }, `epoch:${index + 1}`);
      await vi.advanceTimersByTimeAsync(150);
      const runsCalls = invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(runsKey(CWD)));
      expect(runsCalls).toHaveLength(index + 1);
    }
  });

  it("invalidates the workspace runs key when a tool execution starts", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    source.emit("tool.started", {
      type: "tool.started",
      sessionId: SESSION,
      callId: "call-1",
      tool: "bash",
      status: "running",
      startedAt: "2026-09-25T00:00:00.000Z",
    });
    await flushSignal();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runsKey(CWD) });
  });

  it("invalidates when a tool execution settles", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    source.emit("tool.completed", {
      type: "tool.completed",
      sessionId: SESSION,
      callId: "call-1",
      tool: "bash",
      status: "done",
      endedAt: "2026-09-25T00:00:01.000Z",
    });
    await flushSignal();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates on operation.settled, the SSE v3 turn boundary", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    source.emit("operation.settled", { type: "operation.settled", sessionId: SESSION, status: "completed", outcome: "ok" });
    await flushSignal();
    // Settling a turn also invalidates the workspace file list, so this pins the
    // runs key itself rather than the total number of invalidations.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runsKey(CWD) });
  });

  it("does not invalidate for the streaming updates between those boundaries", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    for (let index = 0; index < 5; index += 1) {
      source.emit("tool.updated", {
        type: "tool.updated",
        sessionId: SESSION,
        callId: "call-1",
        tool: "bash",
        status: "running",
        partialOutput: `chunk ${index}\n`,
      });
    }
    await flushSignal();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates once for a burst of parallel tool starts", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    source.emit("operation.started", { type: "operation.started", sessionId: SESSION, turnId: "turn-1" });
    for (const callId of ["a", "b", "c"]) {
      source.emit("tool.started", {
        type: "tool.started",
        sessionId: SESSION,
        callId,
        tool: "bash",
        status: "running",
        startedAt: "2026-09-25T00:00:00.000Z",
      });
    }
    await flushSignal();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates when a hidden tab resumes but not on the first attach", async () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    // The first attach already fetched on mount; it must not invalidate again.
    await flushSignal();
    expect(invalidate).not.toHaveBeenCalled();

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    FakeEventSource.instances.at(-1)!.open();
    await flushSignal();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runsKey(CWD) });
  });

  it("invalidates after a server-declared stream gap", async () => {
    const source = await connectStream();
    vi.spyOn(useRuntimeStore.getState().client!, "getSessionState").mockResolvedValue(state(SESSION));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    source.emit("stream.gap", { type: "stream.gap", sessionId: SESSION });
    await flushSignal();
    expect(invalidate).toHaveBeenCalled();
  });

  it("ignores boundaries belonging to another session", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    source.emit("tool.completed", {
      type: "tool.completed",
      sessionId: "session-other",
      callId: "call-1",
      tool: "bash",
      status: "done",
    });
    await flushSignal();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the workspace on screen when a switch lands inside the debounce window", async () => {
    const otherCwd = "/workspace-b";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state(url.includes("session-b") ? "session-b" : "session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect(CWD, "session-a");
    FakeEventSource.instances.at(-1)!.open();
    FakeEventSource.instances.at(-1)!.emit("operation.started", { type: "operation.started", sessionId: "session-a", turnId: "turn-a" });

    queryClient.setQueryData(runsKey(otherCwd), []);
    await useRuntimeStore.getState().connect(otherCwd, "session-b");
    FakeEventSource.instances.at(-1)!.open();

    await flushSignal();
    expect(queryClient.getQueryState(runsKey(otherCwd))?.isInvalidated).toBe(true);
  });
});
