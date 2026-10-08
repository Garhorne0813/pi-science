import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "./index";
import { generations } from "./generations";
import { getClient } from "../client/pi-science-client";
import { reconcileAfterConnectionLoss, reconcileRestoredSession, reconcileWorkingState, rememberRuntimeState } from "./recovery";
import { installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const CWD = "/workspace";
const SESSION = "restore-authority";
const completedHistory: Array<Record<string, unknown>> = [
  { id: "old-user", role: "user", content: [{ type: "text", text: "old prompt" }] },
  { id: "old-final", role: "assistant", presentationRole: "final", content: [{ type: "text", text: "old answer" }] },
];

function rest(initial: Record<string, unknown>) {
  let snapshot = state(SESSION, initial);
  let messages = completedHistory;
  let failing = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages")) return jsonResponse({ messages });
    if (url.includes("/state")) return failing ? jsonResponse({ error: "temporarily unavailable" }, 503) : jsonResponse(snapshot);
    if (url.includes("/turn-artifacts")) return jsonResponse({ turns: [] });
    if (url.startsWith("/api/sessions?")) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    idle: () => { snapshot = state(SESSION); },
    /** The remote turn ended with no event of ours: only REST history carries
     *  its final. */
    settle: () => {
      snapshot = state(SESSION);
      messages = [...completedHistory, { id: "new-final", role: "assistant", presentationRole: "final", content: [{ type: "text", text: "new answer" }] }];
    },
    fail: (value: boolean) => { failing = value; },
    stateReads: () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/state")).length,
    messageReads: () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages")).length,
    artifactReads: () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/artifacts")).length,
  };
}

describe("restored session authority", () => {
  it.each(["failed", "aborted"] as const)("preserves %s when retries fall back to a known idle snapshot", async (outcome) => {
    const client = getClient();
    useRuntimeStore.setState({ activeSessionId: SESSION, cwd: CWD, working: true, turnLifecycle: outcome });
    rememberRuntimeState(client, SESSION, CWD, state(SESSION));
    vi.spyOn(client, "getSessionState").mockRejectedValue(new Error("unavailable"));
    const recovery = reconcileWorkingState(client, SESSION, CWD, generations.connection, generations.activity);
    await vi.advanceTimersByTimeAsync(1_000);
    await recovery;
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: outcome });
  });

  it("drops a working-state probe superseded by a local mutation", async () => {
    const client = getClient();
    useRuntimeStore.setState({ activeSessionId: SESSION, cwd: CWD, working: true, turnLifecycle: "queued" });
    let resolve!: (value: ReturnType<typeof state>) => void;
    vi.spyOn(client, "getSessionState").mockReturnValue(new Promise((done) => { resolve = done; }));
    const recovery = reconcileWorkingState(client, SESSION, CWD, generations.connection, generations.activity);
    generations.localMutation += 1;
    resolve(state(SESSION));
    await recovery;
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "queued" });
  });

  it.each([
    ["streaming", { is_streaming: true }, "active"],
    ["compacting", { is_compacting: true }, "active"],
    ["queued", { pending_message_count: 1 }, "queued"],
  ] as const)("keeps an old final from unlocking a newer %s task", async (_name, busy, lifecycle) => {
    rest(busy);
    await useRuntimeStore.getState().connect(CWD, SESSION);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: lifecycle });
    const send = vi.spyOn(useRuntimeStore.getState().client!, "sendPrompt");
    await expect(useRuntimeStore.getState().sendPrompt("another prompt")).rejects.toThrow("still running");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps blocking a stale busy snapshot until a later authoritative idle", async () => {
    const api = rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useRuntimeStore.getState().working).toBe(true);
    api.idle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: "settled", status: "ready" });
  });

  it("repairs a failed state read without using the old final to unlock", async () => {
    const api = rest({});
    api.fail(true);
    await useRuntimeStore.getState().connect(CWD, SESSION);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, status: "error" });
    api.fail(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: "settled", status: "ready" });
  });

  it("reads the history once while a busy restore keeps watching the state", async () => {
    const api = rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    const messagesAfterConnect = api.messageReads();
    const artifactsAfterConnect = api.artifactReads();
    await vi.advanceTimersByTimeAsync(40_000);
    // The whole four-probe budget ran against an unchanged busy snapshot.
    expect(api.stateReads()).toBe(5);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, status: "ready", turnLifecycle: "active" });
    // Only the state is worth re-reading while the turn is still running.
    expect(api.messageReads() - messagesAfterConnect).toBe(1);
    expect(api.artifactReads() - artifactsAfterConnect).toBe(1);
  });

  it("repairs a terminal outcome no event carried when the busy snapshot turns idle", async () => {
    const api = rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useRuntimeStore.getState().working).toBe(true);
    api.settle();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, status: "ready" });
    expect(useRuntimeStore.getState().thread.blocks.map((block) => block.id)).toContain("new-final");
  });

  it("probes a connection loss without waiting out a pending restore backoff", async () => {
    const api = rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    expect(api.stateReads()).toBe(1);
    const connection = reconcileAfterConnectionLoss(getClient(), SESSION, CWD, generations.connection, generations.activity);
    await vi.advanceTimersByTimeAsync(0);
    // The loss is verified inside the restore backoff window, not after it.
    expect(api.stateReads()).toBe(2);
    expect(useRuntimeStore.getState().transportStatus).toBe("open");
    await vi.advanceTimersByTimeAsync(20_000);
    await connection;
  });

  it("verifies a connection loss the pending restore run would have skipped", async () => {
    const api = rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    // The stream was down: this tab still believes the previous turn settled
    // while another tab has already started a newer one.
    useRuntimeStore.setState({ working: false, turnLifecycle: "settled" });
    const connection = reconcileAfterConnectionLoss(getClient(), SESSION, CWD, generations.connection, generations.activity);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.stateReads()).toBe(2);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "active" });
    await vi.advanceTimersByTimeAsync(20_000);
    await connection;
  });

  it("bounds failed recovery reads and leaves the composer guarded", async () => {
    const api = rest({});
    api.fail(true);
    await useRuntimeStore.getState().connect(CWD, SESSION);
    expect(api.stateReads()).toBe(1);
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      const before = api.stateReads();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api.stateReads()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.stateReads()).toBe(before + 1);
    }
    const reads = api.stateReads();
    expect(reads).toBe(5); // Initial read plus one shared budget of four probes.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.stateReads()).toBe(reads);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, status: "error" });
  });

  it("bounds successful busy probes without releasing the composer", async () => {
    const api = rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(api.stateReads()).toBe(5);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, status: "ready", turnLifecycle: "active" });
    await expect(useRuntimeStore.getState().sendPrompt("another prompt")).rejects.toThrow("still running");
  });

  it("shares restore and connection-loss triggers while a probe is in flight", async () => {
    const api = rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    const client = getClient();
    let resolve!: (value: ReturnType<typeof state>) => void;
    const read = vi.spyOn(client, "getSessionState").mockReturnValue(new Promise((done) => { resolve = done; }));
    const first = reconcileRestoredSession(client, SESSION, CWD, generations.connection, generations.activity, generations.localMutation);
    const duplicate = reconcileRestoredSession(client, SESSION, CWD, generations.connection, generations.activity, generations.localMutation);
    const connection = reconcileAfterConnectionLoss(client, SESSION, CWD, generations.connection, generations.activity);
    expect(duplicate).toBe(first);
    expect(connection).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledOnce();
    expect(api.stateReads()).toBe(1);
    resolve(state(SESSION));
    await first;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledOnce();
    expect(useRuntimeStore.getState().working).toBe(false);
  });

  it.each([0, 1])("jitters restore delays between tabs (random=%s)", async (random) => {
    vi.mocked(Math.random).mockReturnValue(random);
    const api = rest({});
    api.fail(true);
    await useRuntimeStore.getState().connect(CWD, SESSION);
    const firstDelay = 1_000 * (0.8 + random * 0.4);
    await vi.advanceTimersByTimeAsync(firstDelay - 1);
    expect(api.stateReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.stateReads()).toBe(2);
    expect(useRuntimeStore.getState().working).toBe(true);
  });

  it.each(["connection", "activity", "localMutation", "session"] as const)("cancels a scheduled retry after %s ownership changes", async (fence) => {
    const api = rest({});
    api.fail(true);
    await useRuntimeStore.getState().connect(CWD, SESSION);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.stateReads()).toBe(2);
    if (fence === "session") useRuntimeStore.setState({ activeSessionId: "new-session", cwd: "/new-workspace" });
    else generations[fence] += 1;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.stateReads()).toBe(2);
    expect(useRuntimeStore.getState().working).toBe(true);
  });

  it.each(["connection", "activity", "localMutation", "session"] as const)("drops an idle response after %s ownership changes", async (fence) => {
    rest({ is_streaming: true });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    let resolve!: (value: ReturnType<typeof state>) => void;
    const pending = new Promise<ReturnType<typeof state>>((done) => { resolve = done; });
    vi.spyOn(useRuntimeStore.getState().client!, "getSessionState").mockReturnValue(pending);
    await vi.advanceTimersByTimeAsync(1_000);
    if (fence === "session") useRuntimeStore.setState({ activeSessionId: "new-session", cwd: "/new-workspace" });
    else generations[fence] += 1;
    useRuntimeStore.setState({ working: true, turnLifecycle: "queued" });
    resolve(state(SESSION));
    await vi.advanceTimersByTimeAsync(0);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, turnLifecycle: "queued" });
  });

  it.each(["active", "queued"] as const)("settles an idle restored %s lifecycle without a final", async (lifecycle) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state(SESSION));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(url);
    }));
    useRuntimeStore.setState({ cwd: CWD, activeSessionId: SESSION, working: true, turnLifecycle: lifecycle });
    await useRuntimeStore.getState().connect(CWD, SESSION);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: "settled" });
  });

  it.each(["failed", "aborted"] as const)("preserves a confirmed %s outcome on idle restore", async (outcome) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [{ id: "user", role: "user", turnStatus: outcome, content: [{ type: "text", text: "prompt" }] }] });
      if (url.includes("/state")) return jsonResponse(state(SESSION));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(url);
    }));
    await useRuntimeStore.getState().connect(CWD, SESSION);
    expect(useRuntimeStore.getState()).toMatchObject({ working: false, turnLifecycle: outcome });
  });
});
