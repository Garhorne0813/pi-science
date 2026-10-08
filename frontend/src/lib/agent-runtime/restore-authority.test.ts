import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "./index";
import { generations } from "./generations";
import { getClient } from "../client/pi-science-client";
import { reconcileWorkingState, rememberRuntimeState } from "./recovery";
import { installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";

installRuntimeTestEnvironment();
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const CWD = "/workspace";
const SESSION = "restore-authority";
const completedHistory = [
  { id: "old-user", role: "user", content: [{ type: "text", text: "old prompt" }] },
  { id: "old-final", role: "assistant", presentationRole: "final", content: [{ type: "text", text: "old answer" }] },
];

function rest(initial: Record<string, unknown>) {
  let snapshot = state(SESSION, initial);
  let failing = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages")) return jsonResponse({ messages: completedHistory });
    if (url.includes("/state")) return failing ? jsonResponse({ error: "temporarily unavailable" }, 503) : jsonResponse(snapshot);
    if (url.includes("/turn-artifacts")) return jsonResponse({ turns: [] });
    if (url.startsWith("/api/sessions?")) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    idle: () => { snapshot = state(SESSION); },
    fail: (value: boolean) => { failing = value; },
    stateReads: () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/state")).length,
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
    await vi.advanceTimersByTimeAsync(1_000);
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

  it("bounds failed recovery reads and leaves the composer guarded", async () => {
    const api = rest({});
    api.fail(true);
    await useRuntimeStore.getState().connect(CWD, SESSION);
    await vi.advanceTimersByTimeAsync(20_000);
    const reads = api.stateReads();
    expect(reads).toBe(17); // Initial read plus four rounds of four bounded retries.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.stateReads()).toBe(reads);
    expect(useRuntimeStore.getState()).toMatchObject({ working: true, status: "error" });
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
