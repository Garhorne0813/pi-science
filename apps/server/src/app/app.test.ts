import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { createServerModules } from "./server-modules.js";
import type { ServerConfig } from "../config/config.js";

const openApps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function startUpstream() {
  const upstream = Fastify();
  upstream.get("/api/health", async () => ({ status: "ok", active_pi_processes: 3, active_kernels: 2 }));
  upstream.get("/api/kernels/status", async () => ({ active: 2 }));
  upstream.get("/api/kernels/request-id", async (request) => ({ request_id: request.headers["x-request-id"] ?? null }));
  upstream.get("/api/kernels/slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ok: true };
  });
  upstream.post("/api/kernels/execute", async (request) => {
    const cwd = String((request.query as { cwd?: unknown }).cwd ?? "");
    const body = request.body as { code?: string };
    if (body.code === "write-output") await writeFile(join(cwd, "cell-output.csv"), "value\n42\n", "utf8");
    if (body.code === "kernel-error") return { ok: false, stdout: "before failure\n", result: null, error: "cell failed" };
    try { await access(join(cwd, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")); return { isolated: true }; }
    catch { return { isolated: false }; }
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
    expect(ready.json()).toMatchObject({ status: "ready", scientific_runtime: { state: "external", managed: false } });
  });

  it("owns health while retaining scientific runtime fields", async () => {
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "pi-science-server", control_plane: "node", scientific_runtime: "external", active_pi_processes: 0, active_kernels: 0 });
  });

  it("stays healthy when the scientific worker is unavailable or idle", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", scientific_runtime: "external" });
  });

  it("proxies scientific routes and request IDs", async () => {
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);
    const scientific = await app.inject({ method: "GET", url: "/api/kernels/status" });
    expect(scientific.json()).toEqual({ active: 2 });
    expect(scientific.headers["x-pi-science-runtime"]).toBe("python-scientific-runtime");

    const requestId = await app.inject({ method: "GET", url: "/api/kernels/request-id", headers: { "x-request-id": "smoke-123" } });
    expect(requestId.json()).toEqual({ request_id: "smoke-123" });
  });

  it("provisions the workspace environment before forwarding kernel execution", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-environment-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/kernels/execute?cwd=${encodeURIComponent(workspace)}`, payload: { language: "python", code: "1+1" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ isolated: true, execution_id: expect.stringMatching(/^exec_/) });
    const executions = await app.inject({ method: "GET", url: `/api/executions?cwd=${encodeURIComponent(workspace)}` });
    expect(executions.json().executions).toEqual([
      expect.objectContaining({
        execution_id: response.json().execution_id,
        kind: "kernel_cell",
        surface: "python",
        status: "succeeded",
        request: expect.objectContaining({ code: "1+1", notebook_id: "default" }),
      }),
    ]);
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("detects files written by a kernel cell as execution evidence", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-output-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/kernels/execute?cwd=${encodeURIComponent(workspace)}`,
      payload: { language: "r", code: "write-output", notebook_id: "analysis", session_id: "session-notebook" },
    });
    const executionId = response.json().execution_id;
    const execution = await app.inject({ method: "GET", url: `/api/executions/${executionId}?cwd=${encodeURIComponent(workspace)}` });

    expect(response.statusCode).toBe(200);
    expect(execution.json()).toMatchObject({
      kind: "kernel_cell",
      surface: "r",
      status: "succeeded",
      request: { notebook_id: "analysis", code: "write-output" },
      correlation: { session_id: "session-notebook" },
      files: { written: [{ path: "cell-output.csv", detection: "snapshot" }] },
    });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("records a kernel-level cell error as a failed execution", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config(await startUpstream()));
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/kernels/execute?cwd=${encodeURIComponent(workspace)}`,
      payload: { language: "python", code: "kernel-error" },
    });
    const execution = await app.inject({
      method: "GET",
      url: `/api/executions/${response.json().execution_id}?cwd=${encodeURIComponent(workspace)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, error: "cell failed" });
    expect(execution.json()).toMatchObject({
      status: "failed",
      result: { error: "cell failed", stdout_preview: "before failure\n" },
    });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("returns a bounded gateway timeout for an unavailable upstream", async () => {
    const app = buildApp(config(await startUpstream(), { upstreamTimeoutMs: 20 }));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/kernels/slow" });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: "scientific runtime unavailable" });
  });

  it("tears down the shared Pi runtime manager on close even when nodePiManager is off", async () => {
    const modules = createServerModules(config("http://127.0.0.1:1", { nodePiManager: false }));
    const shutdownSpy = vi.spyOn(modules.piManager, "shutdownAll").mockResolvedValue(undefined);
    const app = buildApp(config("http://127.0.0.1:1", { nodePiManager: false }), modules);
    openApps.push(app);

    await app.close();

    // The node session service hook is gated on nodePiManager, but the shared
    // manager also owns research/review subagent runtimes, so its onClose hook
    // must run unconditionally exactly once.
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it("calls the shared Pi runtime manager teardown exactly twice when nodePiManager is on (idempotent no-ops)", async () => {
    const modules = createServerModules(config("http://127.0.0.1:1", { nodePiManager: true }));
    const shutdownSpy = vi.spyOn(modules.piManager, "shutdownAll").mockResolvedValue(undefined);
    const app = buildApp(config("http://127.0.0.1:1", { nodePiManager: true }), modules);
    openApps.push(app);

    await app.close();

    // One call from the session service (nodePiManager on) and one from the
    // unconditional hook; the second is a no-op because the maps were cleared.
    expect(shutdownSpy).toHaveBeenCalledTimes(2);
  });

  it("survives a refused upstream connection instead of replying twice", async () => {
    // Bind and immediately release a port so the proxy connection is refused.
    const closed = Fastify();
    await closed.listen({ host: "127.0.0.1", port: 0 });
    const origin = closed.listeningOrigin;
    await closed.close();

    const app = buildApp(config(origin));
    openApps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });

    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    try {
      // /api/bookmarks is a declared boundary with no native handler, so it
      // falls through to the proxy without passing the scientific-runtime gate
      // that would answer 503 before any upstream connection is attempted.
      const response = await fetch(`${app.listeningOrigin}/api/bookmarks`);
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ error: "scientific runtime unavailable" });
      // The duplicate onError lands a tick after the first reply is flushed.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    }
    expect(uncaught).toEqual([]);
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
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.skipIf(process.platform === "win32")("enforces workspace boundaries for native file reads", async () => {
    const workspace = join(tmpdir(), `pi-science-files-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "demo"), { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "hello", "utf8");
    await writeFile(join(workspace, "pic.webp"), "RIFF\\x00\\x00\\x00\\x00WEBPVP8 ", "utf8");
    const outside = `${workspace}-outside.txt`;
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, join(workspace, "escape.txt"));
    const app = buildApp(config("http://127.0.0.1:1", { nodeFiles: true }));
    openApps.push(app);
    const listed = await app.inject({ method: "GET", url: `/api/files?cwd=${encodeURIComponent(workspace)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notes.txt", isDir: false })]));
    expect(listed.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "node_modules" })]));
    const served = await app.inject({ method: "GET", url: `/api/files/serve/notes.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe("hello");
    const servedWebp = await app.inject({ method: "GET", url: `/api/files/serve/pic.webp?cwd=${encodeURIComponent(workspace)}` });
    expect(servedWebp.statusCode).toBe(200);
    expect(servedWebp.headers["content-type"]).toBe("image/webp");
    const read = await app.inject({ method: "GET", url: `/api/files/notes.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ path: "notes.txt", encoding: "utf8", data: "hello", size: 5 });
    const base64 = await app.inject({ method: "GET", url: `/api/files/notes.txt?cwd=${encodeURIComponent(workspace)}&format=base64` });
    expect(base64.json()).toMatchObject({ encoding: "base64", data: "aGVsbG8=" });
    const escaped = await app.inject({ method: "GET", url: `/api/files/serve/../outside.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(escaped.statusCode).toBeGreaterThanOrEqual(400);
    const symlinkEscape = await app.inject({ method: "GET", url: `/api/files/serve/escape.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(symlinkEscape.statusCode).toBeGreaterThanOrEqual(400);
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("saves text edits through the content route and records provenance", async () => {
    const workspace = join(tmpdir(), `pi-science-content-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "hello", "utf8");
    const app = buildApp(config("http://127.0.0.1:1", { nodeFiles: true }));
    openApps.push(app);
    const save = await app.inject({
      method: "POST",
      url: `/api/files/content?cwd=${encodeURIComponent(workspace)}`,
      payload: { path: "notes.txt", content: "updated" },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ ok: true, path: "notes.txt", size: 7 });
    const readBack = await app.inject({ method: "GET", url: `/api/files/notes.txt?cwd=${encodeURIComponent(workspace)}` });
    expect(readBack.json()).toMatchObject({ path: "notes.txt", encoding: "utf8", data: "updated", size: 7 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("rejects binary files and path escapes on the content route", async () => {
    const workspace = join(tmpdir(), `pi-science-content-bin-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await writeFile(join(workspace, "blob.bin"), Buffer.from([0, 159, 146, 150]), "utf8");
    const app = buildApp(config("http://127.0.0.1:1", { nodeFiles: true }));
    openApps.push(app);
    const binary = await app.inject({
      method: "POST",
      url: `/api/files/content?cwd=${encodeURIComponent(workspace)}`,
      payload: { path: "blob.bin", content: "tampered" },
    });
    expect(binary.statusCode).toBe(400);
    expect(binary.json()).toMatchObject({ error: expect.stringContaining("binary") });
    const escape = await app.inject({
      method: "POST",
      url: `/api/files/content?cwd=${encodeURIComponent(workspace)}`,
      payload: { path: "../outside.txt", content: "x" },
    });
    expect(escape.statusCode).toBe(403);
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});
