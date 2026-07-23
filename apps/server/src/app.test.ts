import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import type { ServerConfig } from "./config.js";
import { durableEventStore } from "./event-store.js";

const openApps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function startUpstream() {
  const upstream = Fastify();
  upstream.get("/api/health", async () => ({ status: "ok", active_pi_processes: 3, active_kernels: 2 }));
  upstream.get("/api/kernels/status", async () => ({ active: 2 }));
  upstream.get("/api/request-id", async (request) => ({ request_id: request.headers["x-request-id"] ?? null }));
  upstream.get("/api/slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ok: true };
  });
  upstream.post<{ Body: { cwd: string } }>("/api/sessions", async (request, reply) => reply.code(201).send({ id: "session-created", cwd: request.body.cwd }));
  upstream.get("/api/sessions/:id/events", async (request, reply) => {
    const lastEventId = request.headers["last-event-id"] ?? "";
    return reply.type("text/event-stream").send(`id: 8\nevent: session.idle\ndata: {"cursor":"${lastEventId}"}\n\n`);
  });
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  openApps.push(upstream);
  return upstream.listeningOrigin;
}

function config(pythonOrigin: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    pythonOrigin,
    corsOrigins: ["http://127.0.0.1:5173"],
    maxBodyBytes: 10 * 1024 * 1024,
    upstreamTimeoutMs: 30_000,
    nodeSessions: false,
    nodeSse: false,
    nodeFiles: false,
    nodePiManager: false,
    logLevel: "silent",
    ...overrides,
  };
}

describe("Node control plane", () => {
  it("exposes liveness and readiness separately", async () => {
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);
    expect((await app.inject({ method: "GET", url: "/internal/live" })).statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/internal/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready", scientific_runtime: { status: "ok" } });
  });

  it("owns health while retaining scientific runtime fields", async () => {
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "pi-science-server", control_plane: "node", scientific_runtime: "ok", active_pi_processes: 3, active_kernels: 2 });
  });

  it("reports degraded health when Python is unavailable", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded", scientific_runtime: "unavailable" });
  });

  it("proxies JSON, scientific routes, and Last-Event-ID", async () => {
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);
    const scientific = await app.inject({ method: "GET", url: "/api/kernels/status" });
    expect(scientific.json()).toEqual({ active: 2 });
    expect(scientific.headers["x-pi-science-runtime"]).toBe("python-scientific-runtime");

    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: "/tmp/project" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: "session-created", cwd: "/tmp/project" });

    const events = await app.inject({ method: "GET", url: "/api/sessions/session-1/events", headers: { "last-event-id": "7" } });
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain('"cursor":"7"');

    const requestId = await app.inject({ method: "GET", url: "/api/request-id", headers: { "x-request-id": "smoke-123" } });
    expect(requestId.json()).toEqual({ request_id: "smoke-123" });
  });

  it("returns a bounded gateway timeout for an unavailable upstream", async () => {
    const app = buildApp(config(await startUpstream(), { upstreamTimeoutMs: 20 }));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/slow" });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: "scientific runtime unavailable" });
  });

  it("can serve read-only session data from the existing JSONL format", async () => {
    const workspace = join(tmpdir(), `pi-science-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionDir = join(workspace, ".pi-science", "sessions", "encoded");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session-1.jsonl"),
      [
        JSON.stringify({ type: "session", id: "session-1", cwd: workspace, timestamp: "2026-07-23T00:00:00.000Z" }),
        JSON.stringify({ type: "message", id: "m1", timestamp: "2026-07-23T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "message", id: "m2", timestamp: "2026-07-23T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const app = buildApp(config("http://127.0.0.1:1", { nodeSessions: true }));
    openApps.push(app);
    const listed = await app.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(workspace)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject([{ id: "session-1", cwd: workspace }]);
    const messages = await app.inject({ method: "GET", url: `/api/sessions/session-1/messages?cwd=${encodeURIComponent(workspace)}` });
    expect(messages.json()).toMatchObject({ messages: [{ id: "m1", role: "user" }, { id: "m2", role: "assistant" }] });
    await rm(workspace, { recursive: true, force: true });
  });

  it("can bridge SSE through Node and preserve framing", async () => {
    const workspace = join(tmpdir(), `pi-science-sse-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config(await startUpstream(), { nodeSse: true }));
    openApps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/session-1/events?cwd=${encodeURIComponent(workspace)}`,
      headers: { "last-event-id": "7" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["x-pi-science-sse"]).toBe("node");
    expect(response.body).toContain('"cursor":"7"');
    await rm(workspace, { recursive: true, force: true });
  });

  it("replays durable SSE events when the scientific runtime is unavailable", async () => {
    const workspace = join(tmpdir(), `pi-science-sse-replay-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await durableEventStore.append(workspace, "session-1", { event: "text.updated", id: "1", data: '{"text":"hello"}', created_at: new Date().toISOString() });
    await durableEventStore.append(workspace, "session-1", { event: "session.idle", id: "2", data: '{"sessionId":"session-1"}', created_at: new Date().toISOString() });
    const app = buildApp(config("http://127.0.0.1:1", { nodeSse: true }));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/sessions/session-1/events?cwd=${encodeURIComponent(workspace)}`, headers: { "last-event-id": "1" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-pi-science-sse"]).toBe("node-replay");
    expect(response.body).toContain("id: 2");
    expect(response.body).not.toContain('"text":"hello"');
    await rm(workspace, { recursive: true, force: true });
  });

  it("enforces workspace boundaries for native file reads", async () => {
    const workspace = join(tmpdir(), `pi-science-files-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "hello", "utf8");
    const outside = `${workspace}-outside.txt`;
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, join(workspace, "escape.txt"));
    const app = buildApp(config("http://127.0.0.1:1", { nodeFiles: true }));
    openApps.push(app);
    const listed = await app.inject({ method: "GET", url: `/api/files?cwd=${encodeURIComponent(workspace)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notes.txt", isDir: false })]));
    const served = await app.inject({ method: "GET", url: `/api/files/serve/notes.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe("hello");
    const escaped = await app.inject({ method: "GET", url: `/api/files/serve/../outside.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(escaped.statusCode).toBeGreaterThanOrEqual(400);
    const symlinkEscape = await app.inject({ method: "GET", url: `/api/files/serve/escape.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(symlinkEscape.statusCode).toBeGreaterThanOrEqual(400);
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { force: true });
  });

  it("fails closed when Node Pi management has no runtime configured", async () => {
    const workspace = join(tmpdir(), `pi-science-pi-route-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1", { nodePiManager: true }));
    openApps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: workspace } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "spawn_failed" });
    await rm(workspace, { recursive: true, force: true });
  });
});
