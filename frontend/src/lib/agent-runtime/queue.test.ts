import { describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "./index";
import { installRuntimeTestEnvironment, jsonResponse } from "./test-helpers";

installRuntimeTestEnvironment();

const first = "8fd824aa-51d3-4f63-839c-09e021b7970b";
const queued = (overrides: Record<string, unknown> = {}) => ({
  id: first, text: "then summarize", status: "queued", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...overrides,
});
const queueResponse = (entries: Array<Record<string, unknown>>, paused = false, pausedReason?: string) => jsonResponse({
  ok: true,
  queue: { session_id: "session-1", paused, ...(pausedReason ? { paused_reason: pausedReason } : {}), entries, updated_at: "2026-01-01T00:00:00.000Z" },
});

function ready(overrides: Record<string, unknown> = {}) {
  useRuntimeStore.setState({ cwd: "/workspace", activeSessionId: "session-1", status: "ready", working: true, ...overrides });
}

describe("follow-up queue actions", () => {
  it("applies the queue the server reports for the active session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/queue?")) return queueResponse([queued()]);
      return jsonResponse({});
    }));
    ready();
    await useRuntimeStore.getState().loadQueue();
    expect(useRuntimeStore.getState()).toMatchObject({ queueSessionId: "session-1", queuePaused: false });
    expect(useRuntimeStore.getState().queuedMessages).toEqual([queued()]);
  });

  it("drops a queue reply for a conversation the user already left", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/queue?")) return pending;
      return jsonResponse({});
    }));
    ready();
    const loading = useRuntimeStore.getState().loadQueue();
    useRuntimeStore.setState({ activeSessionId: "session-2" });
    release(queueResponse([queued()]));
    await loading;
    expect(useRuntimeStore.getState().queuedMessages).toEqual([]);
    expect(useRuntimeStore.getState().queueSessionId).toBeNull();
  });

  it("sends a steer once with its request id and surfaces a finished turn", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("/steer")) return jsonResponse({ ok: false, code: "not_running", status: "rejected" }, 409);
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    ready();
    await expect(useRuntimeStore.getState().sendSteer("focus on the data")).rejects.toMatchObject({ code: "not_running" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ message: "focus on the data" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues a follow-up and refreshes the authoritative queue", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).includes("/queue?") && init?.method === "POST") return jsonResponse({ ok: true, created: true, entry: queued() }, 201);
      if (String(input).includes("/queue?")) return queueResponse([queued()]);
      return jsonResponse({});
    }));
    ready();
    await useRuntimeStore.getState().enqueueMessage("then summarize", first);
    expect(calls).toEqual([`POST /api/sessions/session-1/queue?cwd=%2Fworkspace`, `GET /api/sessions/session-1/queue?cwd=%2Fworkspace`]);
    expect(useRuntimeStore.getState().queuedMessages).toHaveLength(1);
  });

  it("delivers one queued message immediately and refreshes the queue", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes(`/queue/${first}/dispatch`)) return jsonResponse({ ok: true, status: "accepted", entry: queued({ status: "dispatched" }) });
      if (url.includes("/queue?")) return queueResponse([queued({ status: "dispatched" })]);
      return jsonResponse({});
    }));
    ready();
    await expect(useRuntimeStore.getState().dispatchQueuedMessage(first)).resolves.toBe("accepted");
    expect(calls).toEqual([
      `POST /api/sessions/session-1/queue/${first}/dispatch?cwd=%2Fworkspace`,
      `GET /api/sessions/session-1/queue?cwd=%2Fworkspace`,
    ]);
    expect(useRuntimeStore.getState().queuedMessages[0]).toMatchObject({ status: "dispatched" });
  });

  it("reports an unconfirmed delivery instead of a silent success", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/queue/${first}/dispatch`))
        return jsonResponse({ ok: true, status: "indeterminate", error_code: "steer_unconfirmed", entry: queued({ status: "dispatched", error_code: "indeterminate" }) });
      if (url.includes("/queue?")) return queueResponse([queued({ status: "dispatched", error_code: "indeterminate" })]);
      return jsonResponse({});
    }));
    ready();
    await expect(useRuntimeStore.getState().dispatchQueuedMessage(first)).resolves.toBe("indeterminate");
    expect(useRuntimeStore.getState().queuedMessages[0]).toMatchObject({ status: "dispatched", error_code: "indeterminate" });
  });

  it("retries a failed message and refreshes the queue", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes(`/queue/${first}/retry`)) return jsonResponse({ ok: true, entry: queued() });
      if (url.includes("/queue?")) return queueResponse([queued()]);
      return jsonResponse({});
    }));
    ready();
    await useRuntimeStore.getState().retryQueuedMessage(first);
    expect(calls).toEqual([
      `POST /api/sessions/session-1/queue/${first}/retry?cwd=%2Fworkspace`,
      `GET /api/sessions/session-1/queue?cwd=%2Fworkspace`,
    ]);
  });

  it("edits, cancels and resumes through the server and refreshes each time", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/queue/resume")) return queueResponse([queued()], false);
      if (url.includes("/queue/") && (init?.method === "PATCH" || init?.method === "DELETE")) return jsonResponse({ ok: true, entry: queued() });
      if (url.includes("/queue?")) return queueResponse([queued()]);
      return jsonResponse({});
    }));
    ready();
    await useRuntimeStore.getState().editQueuedMessage(first, "edited");
    await useRuntimeStore.getState().cancelQueuedMessage(first);
    await useRuntimeStore.getState().resumeQueue();
    expect(seen[0]).toBe(`PATCH /api/sessions/session-1/queue/${first}?cwd=%2Fworkspace`);
    expect(seen[2]).toBe(`DELETE /api/sessions/session-1/queue/${first}?cwd=%2Fworkspace`);
    expect(seen[4]).toBe("POST /api/sessions/session-1/queue/resume?cwd=%2Fworkspace");
  });
});
