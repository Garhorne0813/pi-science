import Fastify from "fastify";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionMessageRoutes } from "./session-message-routes.js";
import { SessionQueueRepository } from "../../modules/session/session-queue-repository.js";
import { SessionQueueDispatcher } from "../../runtime/node/session-queue-dispatcher.js";
import { SteerRequestLedger } from "../../runtime/node/steer-request-ledger.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { SessionRepository } from "../../runtime/node/session-repository.js";

const cleanup: string[] = [];
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
  if (original === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = original;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function harness(
  options: {
    streaming?: boolean;
    pending?: number;
    command?: { success: boolean; code?: string };
  } = {},
) {
  const queue = new SessionQueueRepository();
  const steers = new SteerRequestLedger("server-1");
  const facts = {
    is_streaming: options.streaming ?? true,
    is_compacting: false,
    pending_message_count: options.pending ?? 0,
  };
  const command = vi.fn(async () => options.command ?? { success: true });
  const dispatcher = new SessionQueueDispatcher({ state: async () => facts, command }, queue, 1000);
  const sessions = {
    state: async () => facts,
    command,
    liveSessions: () => [{ id: sessionId, cwd }],
  } as unknown as NodeSessionService;
  const repository = { findPath: async () => "/tmp/session.jsonl" } as unknown as SessionRepository;
  const app = Fastify({ logger: false });
  registerSessionMessageRoutes(app, sessions, repository, { queue, steers, dispatcher });
  return { app, queue, command, dispatcher };
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

  it("reports the queue without dispatching it while stopped", async () => {
    const { app, queue, command } = harness({ streaming: false });
    await queue.enqueue(cwd, sessionId, { id: first, text: "after the stop" });
    await queue.pauseAfterStop(cwd, sessionId);
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/queue?cwd=${encodeURIComponent(cwd)}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(response.json()).toMatchObject({
      ok: true,
      queue: { paused: true, paused_reason: "stop", entries: [{ id: first, status: "queued" }] },
    });
    expect(command).not.toHaveBeenCalled();
  });

  it("continues the queue only after an explicit resume", async () => {
    const { app, queue, command } = harness({ streaming: false });
    await queue.enqueue(cwd, sessionId, { id: first, text: "after the stop" });
    await queue.pauseAfterStop(cwd, sessionId);
    const params = `?cwd=${encodeURIComponent(cwd)}`;
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
