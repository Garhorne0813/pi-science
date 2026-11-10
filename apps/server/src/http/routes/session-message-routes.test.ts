import Fastify from "fastify";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionMessageRoutes } from "./session-message-routes.js";
import { registerNodeSessionRoutes } from "./node-session-routes.js";
import { SessionQueueRepository } from "../../modules/session/session-queue-repository.js";
import { SessionQueueDispatcher } from "../../runtime/node/session-queue-dispatcher.js";
import { SteerRequestLedger } from "../../runtime/node/steer-request-ledger.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { SessionRepository } from "../../runtime/node/session-repository.js";

const cleanup: string[] = [];
const dispatchers: SessionQueueDispatcher[] = [];
const original = process.env.PI_SCIENCE_HOME;
const sessionId = "session-a";
const first = "8fd824aa-51d3-4f63-839c-09e021b7970b";
const second = "91d824aa-51d3-4f63-839c-09e021b7970b";
let cwd: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-message-routes-"));
  cleanup.push(root);
  process.env.PI_SCIENCE_HOME = join(root, "data");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".pi-science"), { recursive: true });
  cwd = await realpath(workspace);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A queued drain may still be writing when the test ends; let it settle
  // before the temporary workspace is removed.
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.stopAndDrain()));
  if (original === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = original;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function harness(
  options: {
    streaming?: boolean;
    pending?: number;
    command?: { success: boolean; code?: string };
    nodeRoutes?: boolean;
    stateError?: Error;
    commandThrows?: boolean;
  } = {},
) {
  const queue = new SessionQueueRepository();
  const steers = new SteerRequestLedger("server-1");
  const facts = {
    is_streaming: options.streaming ?? true,
    is_compacting: false,
    pending_message_count: options.pending ?? 0,
  };
  const command = vi.fn(async (_sessionId: string, _cwd: string, type: string) => {
    // A real stop ends the running turn; the session reports idle right after.
    if (type === "abort") facts.is_streaming = false;
    if (type === "steer" && options.commandThrows) throw new Error("ipc down");
    return options.command ?? { success: true };
  });
  const dispatcher = new SessionQueueDispatcher({ state: async () => facts, command }, queue, 1000);
  dispatchers.push(dispatcher);
  const sessions = {
    state: async () => {
      if (options.stateError) throw options.stateError;
      return facts;
    },
    command,
    liveSessions: () => [{ id: sessionId, cwd }],
  } as unknown as NodeSessionService;
  const repository = { findPath: async () => "/tmp/session.jsonl" } as unknown as SessionRepository;
  const app = Fastify({ logger: false });
  registerSessionMessageRoutes(app, sessions, repository, { queue, steers, dispatcher });
  if (options.nodeRoutes) registerNodeSessionRoutes(app, sessions, repository);
  return { app, queue, command, dispatcher, steers };
}

describe("steer route", () => {
  it("delivers a message to the running turn", async () => {
    const { app, command } = harness({ streaming: true });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/steer?cwd=${encodeURIComponent(cwd)}`,
      payload: { message: "focus on the data", client_message_id: first },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "accepted",
      client_message_id: first,
    });
    expect(command).toHaveBeenCalledWith(sessionId, cwd, "steer", { message: "focus on the data" });
  });

  it("refuses to steer an idle session instead of turning it into a prompt", async () => {
    const { app, command } = harness({ streaming: false });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/steer?cwd=${encodeURIComponent(cwd)}`,
      payload: { message: "too late", client_message_id: first },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, code: "not_running", status: "rejected" });
    expect(command).not.toHaveBeenCalled();
  });

  it("answers a repeated request id without delivering twice", async () => {
    const { app, command } = harness({ streaming: true });
    const payload = { message: "focus", client_message_id: first };
    const url = `/api/sessions/${sessionId}/steer?cwd=${encodeURIComponent(cwd)}`;
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(202);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused request id with different content", async () => {
    const { app } = harness({ streaming: true });
    const url = `/api/sessions/${sessionId}/steer?cwd=${encodeURIComponent(cwd)}`;
    await app.inject({
      method: "POST",
      url,
      payload: { message: "focus", client_message_id: first },
    });
    const response = await app.inject({
      method: "POST",
      url,
      payload: { message: "other", client_message_id: first },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "client_message_id_conflict" });
  });
});

describe("follow-up queue routes", () => {
  it("enqueues once per request id and replays the same entry", async () => {
    const { app, queue } = harness({ streaming: true });
    const url = `/api/sessions/${sessionId}/queue?cwd=${encodeURIComponent(cwd)}`;
    const payload = { message: "then summarize", client_message_id: first };
    const created = await app.inject({ method: "POST", url, payload });
    const replay = await app.inject({ method: "POST", url, payload });
    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      ok: true,
      created: false,
      entry: { id: first, text: "then summarize", status: "queued" },
    });
    expect((await queue.read(cwd, sessionId)).entries).toHaveLength(1);
  });

  it("conflicts when a request id is reused with different content", async () => {
    const { app } = harness();
    const url = `/api/sessions/${sessionId}/queue?cwd=${encodeURIComponent(cwd)}`;
    await app.inject({
      method: "POST",
      url,
      payload: { message: "one", client_message_id: first },
    });
    const response = await app.inject({
      method: "POST",
      url,
      payload: { message: "two", client_message_id: first },
    });
    expect(response.statusCode).toBe(409);
  });

  it("edits and cancels a queued entry, and refuses an entry that was dispatched", async () => {
    const { app, queue } = harness();
    const base = `/api/sessions/${sessionId}/queue`;
    const params = `?cwd=${encodeURIComponent(cwd)}`;
    await app.inject({
      method: "POST",
      url: `${base}${params}`,
      payload: { message: "one", client_message_id: first },
    });
    await app.inject({
      method: "POST",
      url: `${base}${params}`,
      payload: { message: "two", client_message_id: second },
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `${base}/${first}${params}`,
          payload: { message: "edited" },
        })
      ).json(),
    ).toMatchObject({ ok: true, entry: { text: "edited" } });
    expect(
      (await app.inject({ method: "DELETE", url: `${base}/${first}${params}` })).json(),
    ).toMatchObject({ ok: true, entry: { status: "cancelled" } });
    await queue.claimNext(cwd, sessionId);
    const refused = await app.inject({ method: "DELETE", url: `${base}/${second}${params}` });
    expect(refused.statusCode).toBe(409);
  });

  it("keeps draining the queue after a stop instead of pausing it", async () => {
    const { app, queue, command } = harness({ streaming: false });
    await queue.enqueue(cwd, sessionId, { id: first, text: "after the stop" });
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/queue?cwd=${encodeURIComponent(cwd)}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(response.json()).toMatchObject({ ok: true, queue: { paused: false } });
    expect(command).toHaveBeenCalledWith(sessionId, cwd, "prompt", {
      message: "after the stop",
      client_message_id: first,
    });
  });

  it("hands the queue head to the agent after the abort route stops a turn", async () => {
    const { app, queue, command, dispatcher } = harness({ streaming: true, nodeRoutes: true });
    await queue.enqueue(cwd, sessionId, { id: first, text: "carry on after the stop" });
    const params = `?cwd=${encodeURIComponent(cwd)}`;
    const abort = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/abort${params}`,
    });
    expect(abort.statusCode).toBe(200);
    expect(abort.json()).toMatchObject({ ok: true });
    // Stop no longer pauses the queue, so the next tick dispatches the head.
    expect((await queue.read(cwd, sessionId)).paused).toBe(false);
    expect(await dispatcher.tick(cwd, sessionId)).toBe("dispatched");
    expect(command).toHaveBeenCalledWith(sessionId, cwd, "prompt", {
      message: "carry on after the stop",
      client_message_id: first,
    });
    expect((await queue.read(cwd, sessionId)).entries[0]).toMatchObject({
      id: first,
      status: "dispatched",
    });
  });

  it("continues a manually paused queue only after an explicit resume", async () => {
    const { app, queue, command } = harness({ streaming: false });
    await queue.enqueue(cwd, sessionId, { id: first, text: "after the stop" });
    const snapshot = await queue.read(cwd, sessionId);
    await writeFile(queue.file(cwd, sessionId), JSON.stringify({ ...snapshot, paused: true }));
    const params = `?cwd=${encodeURIComponent(cwd)}`;
    await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/queue${params}` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(command).not.toHaveBeenCalled();
    const resumed = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/queue/resume${params}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resumed.json()).toMatchObject({ ok: true, queue: { paused: false } });
    expect(command).toHaveBeenCalledWith(sessionId, cwd, "prompt", {
      message: "after the stop",
      client_message_id: first,
    });
  });

  it("delivers a queued entry immediately as a steer", async () => {
    const { app, queue, command } = harness({ streaming: true });
    await queue.enqueue(cwd, sessionId, { id: first, text: "do this now" });
    const dispatch = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/queue/${first}/dispatch?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(dispatch.statusCode).toBe(202);
    expect(dispatch.json()).toMatchObject({
      ok: true,
      status: "accepted",
      entry: { id: first, status: "dispatched" },
    });
    expect(command).toHaveBeenCalledWith(sessionId, cwd, "steer", { message: "do this now" });
    // The entry is no longer queued, so a second click cannot deliver it twice.
    const again = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/queue/${first}/dispatch?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "not_queued" });
  });

  it("keeps a queued entry when the session is no longer running", async () => {
    const { app, queue, command } = harness({ streaming: false });
    await queue.enqueue(cwd, sessionId, { id: first, text: "for later" });
    const dispatch = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/queue/${first}/dispatch?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(dispatch.statusCode).toBe(409);
    expect(dispatch.json()).toMatchObject({ code: "not_running" });
    expect(command).not.toHaveBeenCalled();
    expect((await queue.read(cwd, sessionId)).entries[0]).toMatchObject({
      id: first,
      status: "queued",
      error_code: "not_running",
    });
  });

  it("answers 404 for a dispatch of a missing entry", async () => {
    const { app } = harness({ streaming: true });
    const dispatch = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/queue/${second}/dispatch?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(dispatch.statusCode).toBe(404);
    expect(dispatch.json()).toMatchObject({ code: "not_found" });
  });

  it("returns a claimed entry to the queue when the session state request fails", async () => {
    const { app, queue, command, dispatcher } = harness({
      streaming: false,
      stateError: new Error("ipc down"),
    });
    await queue.enqueue(cwd, sessionId, { id: first, text: "try again" });
    const dispatch = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/queue/${first}/dispatch?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(dispatch.statusCode).toBe(500);
    expect(dispatch.json()).toMatchObject({ ok: false, code: "state_failed" });
    // The stale claim is not left behind: the entry is reachable again.
    expect((await queue.read(cwd, sessionId)).entries[0]).toMatchObject({
      id: first,
      status: "queued",
      error_code: "state_failed",
    });
    expect(await dispatcher.tick(cwd, sessionId)).toBe("dispatched");
    expect(command).toHaveBeenCalledWith(sessionId, cwd, "prompt", {
      message: "try again",
      client_message_id: first,
    });
  });

  it("settles a steer whose transport threw as indeterminate instead of losing it", async () => {
    const { app, queue, command, steers } = harness({ streaming: true, commandThrows: true });
    await queue.enqueue(cwd, sessionId, { id: first, text: "do this now" });
    const url = `/api/sessions/${sessionId}/queue/${first}/dispatch?cwd=${encodeURIComponent(cwd)}`;
    const dispatch = await app.inject({ method: "POST", url });
    expect(dispatch.statusCode).toBe(202);
    expect(dispatch.json()).toMatchObject({
      ok: true,
      status: "indeterminate",
      error_code: "steer_unconfirmed",
      entry: { id: first, status: "dispatched", error_code: "indeterminate" },
    });
    expect(await steers.claim(cwd, sessionId, first, "do this now")).toMatchObject({
      dispatch: false,
      status: "indeterminate",
      error_code: "steer_unconfirmed",
    });
    // Replaying the same id is answered by the receipt, not by the worker.
    await queue.settle(cwd, sessionId, first, { status: "queued" });
    const retry = await app.inject({ method: "POST", url });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({
      status: "indeterminate",
      entry: { id: first, status: "dispatched", error_code: "indeterminate" },
    });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("returns a stale dispatching entry to the queue on the next read", async () => {
    const { queue, command, dispatcher } = harness({ streaming: false });
    await queue.enqueue(cwd, sessionId, { id: first, text: "recover me" });
    const snapshot = await queue.read(cwd, sessionId);
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await writeFile(
      queue.file(cwd, sessionId),
      JSON.stringify({
        ...snapshot,
        entries: snapshot.entries.map((entry) => ({
          ...entry,
          status: "dispatching",
          updated_at: stale,
        })),
      }),
    );
    const recovered = await queue.read(cwd, sessionId);
    expect(recovered.entries[0]).toMatchObject({
      id: first,
      status: "queued",
      error_code: "stale_claim",
    });
    expect(await dispatcher.tick(cwd, sessionId)).toBe("dispatched");
    expect(command).toHaveBeenCalledWith(sessionId, cwd, "prompt", {
      message: "recover me",
      client_message_id: first,
    });
  });

  it("lets only one of two concurrent dispatches claim an entry", async () => {
    const { app, queue, command } = harness({ streaming: true });
    await queue.enqueue(cwd, sessionId, { id: first, text: "do this now" });
    const url = `/api/sessions/${sessionId}/queue/${first}/dispatch?cwd=${encodeURIComponent(cwd)}`;
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url }),
      app.inject({ method: "POST", url }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("retries a failed entry but refuses a queued one", async () => {
    const { app, queue } = harness({ streaming: true });
    await queue.enqueue(cwd, sessionId, { id: first, text: "retry me" });
    const url = `/api/sessions/${sessionId}/queue/${first}/retry?cwd=${encodeURIComponent(cwd)}`;
    const refused = await app.inject({ method: "POST", url });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "not_retryable" });
    await queue.settle(cwd, sessionId, first, { status: "failed", error_code: "steer_failed" });
    const retried = await app.inject({ method: "POST", url });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ ok: true, entry: { id: first, status: "queued" } });
    const entry = (await queue.read(cwd, sessionId)).entries[0];
    expect(entry).toBeDefined();
    expect(entry?.error_code).toBeUndefined();
    const missing = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/queue/${second}/retry?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "not_found" });
  });

  it("refuses to touch a session that does not belong to the workspace", async () => {
    const sessions = {
      state: async () => ({ is_streaming: true }),
      command: vi.fn(),
      liveSessions: () => [],
    } as unknown as NodeSessionService;
    const repository = { findPath: async () => null } as unknown as SessionRepository;
    const isolated = Fastify({ logger: false });
    registerSessionMessageRoutes(isolated, sessions, repository);
    const response = await isolated.inject({
      method: "POST",
      url: `/api/sessions/missing/queue?cwd=${encodeURIComponent(cwd)}`,
      payload: { message: "hello", client_message_id: first },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found" });
  });
});
