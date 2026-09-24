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
  it("invalidates the workspace runs key when a tool execution starts", async () => {
    const source = await connectStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    source.emit("tool.updated", {
      type: "tool.updated",
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
    source.emit("tool.updated", {
      type: "tool.updated",
      sessionId: SESSION,
      callId: "call-1",
      tool: "bash",
      status: "done",
      endedAt: "2026-09-25T00:00:01.000Z",
    });
    await flushSignal();
    expect(invalidate).toHaveBeenCalledTimes(1);
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
    source.emit("agent_start", { type: "agent_start", sessionId: SESSION, turnId: "turn-1" });
    for (const callId of ["a", "b", "c"]) {
      source.emit("tool.updated", {
        type: "tool.updated",
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
    source.emit("tool.updated", {
      type: "tool.updated",
      sessionId: "session-other",
      callId: "call-1",
      tool: "bash",
      status: "done",
    });
    await flushSignal();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
