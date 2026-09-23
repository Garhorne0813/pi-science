import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";
import { generations } from "./generations";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  // Disarm the watchdog before removing its clock; disconnect alone preserves busy.
  useRuntimeStore.getState().disconnect();
  useRuntimeStore.setState({ working: false });
  await vi.advanceTimersByTimeAsync(5_000);
  vi.useRealTimers();
});

async function startProbe() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages")) return jsonResponse({ messages: [] });
    if (url.includes("/state")) return jsonResponse(state("session-a"));
    if (url.startsWith("/api/sessions?")) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  }));
  await useRuntimeStore.getState().connect("/workspace", "session-a");
  const client = useRuntimeStore.getState().client!;
  const source = FakeEventSource.instances.at(-1)!;
  source.open();
  source.emit("agent_start", { type: "agent_start", sessionId: "session-a", turnId: "turn-1", runId: "run-1" });
  // Isolate watchdog probing from transport recovery. Individual tests deliver
  // the events that a recovered SSE connection would send while REST is pending.
  const reconnect = vi.spyOn(client, "reconnect").mockImplementation(() => {});
  let resolve!: (value: SessionState) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<SessionState>((res, rej) => { resolve = res; reject = rej; });
  const probe = vi.spyOn(client, "getSessionState").mockReturnValue(response);
  await vi.advanceTimersByTimeAsync(25_000);
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledTimes(1);
  return { source, probe, reconnect, resolve, reject };
}

describe("live-turn watchdog response ownership", () => {
  it.each([
    { type: "text.updated", partId: "answer", text: "Still working", turnId: "turn-1", runId: "run-1" },
    { type: "agent_start", turnId: "turn-2", runId: "run-2" },
    { type: "session.stats", stats: {} },
  ])("does not publish a transient settled state after $type arrives during the probe", async (event) => {
    const { source, resolve } = await startProbe();
    const lifecycles: string[] = [];
    const unsubscribe = useRuntimeStore.subscribe((value) => { lifecycles.push(value.turnLifecycle); });
    const revision = useRuntimeStore.getState().fileRevision;
    try {
      source.emit(event.type, { ...event, sessionId: "session-a" });
      // Both callbacks can happen in the same millisecond: a timestamp alone
      // cannot tell this response predates the newly received event.
      resolve(state("session-a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "active", fileRevision: revision });
      expect(lifecycles).not.toContain("settled");
    } finally {
      unsubscribe();
    }
  });

  it("does not clear a permission request that arrived during the probe", async () => {
    const { source, resolve } = await startProbe();
    source.emit("permission.asked", { type: "permission.asked", sessionId: "session-a", requestId: "permission-1", title: "Allow write?" });
    const waiting = useRuntimeStore.getState();
    resolve(state("session-a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRuntimeStore.getState()).toMatchObject({ working: waiting.working, turnLifecycle: "waiting", pendingInteraction: waiting.pendingInteraction });
  });

  it.each(["connection", "activity", "localMutation"] as const)("discards a response after the %s generation changes in the same session", async (generation) => {
    const { resolve } = await startProbe();
    generations[generation] += 1;
    if (generation === "localMutation") useRuntimeStore.setState({ turnLifecycle: "stopping" });
    resolve(state("session-a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: generation === "localMutation" ? "stopping" : "active" });
  });

  it("does not overlap slow state probes on later ticks", async () => {
    const { probe, resolve } = await startProbe();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(1);
    resolve(state("session-a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: "settled" });
  });

  it("keeps the next turn's watchdog armed when an older probe finishes", async () => {
    const { source, probe, reconnect, resolve } = await startProbe();
    source.emit("error", { type: "error", sessionId: "session-a", message: "run failed" });
    source.emit("agent_start", { type: "agent_start", sessionId: "session-a", turnId: "turn-2", runId: "run-2" });
    probe.mockResolvedValue(state("session-a"));
    resolve(state("session-a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "active" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: "settled" });
  });

  it("retries a failed probe instead of treating failure as idle", async () => {
    const { probe, reject } = await startProbe();
    reject(new Error("network unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "active" });
    probe.mockResolvedValue(state("session-a"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: "settled" });
  });
});
