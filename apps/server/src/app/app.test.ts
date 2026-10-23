import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { createServerModules } from "./server-modules.js";
import type { ServerConfig } from "../config/config.js";
import type { KernelExecuteOptions, NodeKernelManager } from "../runtime/kernel/node-kernel-manager.js";
import { modelConfigSnapshotSchema } from "@pi-science/contracts";
import { ModelConfigService } from "../model-config/model-config-service.js";
import { InMemorySqliteStateStore } from "../storage/sqlite/state-store.js";

const openApps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

function config(_pythonOrigin: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
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

const fakeKernels = {
  async execute(options: KernelExecuteOptions) {
    if (options.code === "write-output") await writeFile(join(options.cwd, "cell-output.csv"), "value\n42\n", "utf8");
    if (options.code === "kernel-error") return { ok: false, stdout: "before failure\n", stderr: "", result: null, error: "cell failed", interrupted: false, mime: {} };
    if (options.code === "kernel-interrupted") return { ok: false, stdout: "partial\n", stderr: "", result: null, error: "KeyboardInterrupt", interrupted: true, mime: {} };
    if (options.code === "stream-output" && options.onEvent) {
      options.onEvent({ type: "stream", stream: "stdout", text: "first\n" });
      options.onEvent({ type: "stream", stream: "stdout", text: "second\n" });
    }
    if (options.code === "rich-output") {
      return {
        ok: true,
        stdout: "",
        stderr: "",
        result: "figure",
        error: null,
        interrupted: false,
        mime: {},
        outputs: [
          { output_type: "display_data", data: { "text/plain": "shown" } },
          { output_type: "execute_result", data: { "image/png": "encoded-image", "text/plain": "figure" } },
        ],
      };
    }
    const streaming = options.code === "stream-output";
    return {
      ok: true,
      stdout: streaming ? "first\nsecond\n" : "",
      stderr: "",
      result: "42",
      error: null,
      interrupted: false,
      mime: streaming ? { "application/json": "42" } : {},
      isolated: true,
    };
  },
  async shutdownAll() {},
} as unknown as NodeKernelManager;

function kernelModules() {
  // This fake does not start an OS sandbox; characterize native gateway evidence.
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
  return { ...createServerModules(config("http://127.0.0.1:1")), kernels: fakeKernels };
}


describe("Node control plane", () => {
  it("allows composer skill discovery through the global API boundary without opening a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-composer-app-"));
    vi.stubEnv("PI_SCIENCE_HOME", join(root, "state"));
    const cwd = join(root, "workspace");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1", { nodeSessions: true, nodePiManager: true }));
    openApps.push(app);
    try {
      const response = await app.inject({ method: "GET", url: `/api/composer/commands?${new URLSearchParams({ cwd })}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-pi-science-runtime"]).toBe("node-control-plane");
      expect(response.json().commands).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "skill:literature-review", source: "skill" }),
      ]));
      expect((await app.inject({ method: "GET", url: "/api/health" })).json().active_agent_workers).toBe(0);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("exposes liveness and readiness separately", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);
    expect((await app.inject({ method: "GET", url: "/internal/live" })).statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/internal/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready", control_plane: "node" });
  });

  it("becomes unready if the SQLite worker exits after startup", async () => {
    const stateStore = new InMemorySqliteStateStore();
    const modules = createServerModules(config("http://127.0.0.1:1"), { sqliteEnabled: true, stateStore });
    const app = buildApp(config("http://127.0.0.1:1"), modules);
    openApps.push(app);

    expect((await app.inject({ method: "GET", url: "/internal/ready" })).statusCode).toBe(200);
    await stateStore.crashForTest();
    await vi.waitFor(() => expect(stateStore.diagnostics().status).toBe("failed"));

    const response = await app.inject({ method: "GET", url: "/internal/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not_ready", sqlite: { status: "failed" } });
  });

  it("owns health without a Python scientific worker", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "pi-science-server", control_plane: "node", active_agent_workers: 0, active_kernels: 0 });
  });

  it("does not expose the removed literature HTTP endpoints", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);
    for (const route of ["/api/literature/search", "/api/literature/approve"]) {
      const response = await app.inject({ method: "POST", url: route, payload: {} });
      expect(response.statusCode).toBe(404);
    }
  });

  it("protects the control-plane API when a per-launch token is configured", async () => {
    const app = buildApp(config("http://127.0.0.1:1", { internalToken: "test-control-token", requireInternalToken: true }));
    openApps.push(app);

    expect((await app.inject({ method: "POST", url: "/api/settings/network", payload: { profile: "analysis", domain: "example.org", decision: "allow" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { "x-pi-science-internal-token": "test-control-token" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { cookie: "pi-science-internal=test-control-token" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "OPTIONS", url: "/api/health" })).statusCode).not.toBe(401);
  });

  it("rate-limits diagnostics before reading model configuration while keeping health probes available", async () => {
    const app = buildApp(config("http://127.0.0.1:1", { internalToken: "diagnostics-token", requireInternalToken: true }));
    openApps.push(app);
    await app.ready();
    const read = vi.spyOn(ModelConfigService.prototype, "readSync").mockReturnValue(modelConfigSnapshotSchema.parse({ revision: 7 }));
    const headers = { "x-pi-science-internal-token": "diagnostics-token" };
    try {
      expect((await app.inject({ method: "GET", url: "/internal/diagnostics" })).statusCode).toBe(401);
      expect(read).not.toHaveBeenCalled();
      for (let index = 0; index < 30; index++) {
        const response = await app.inject({ method: "GET", url: "/internal/diagnostics", headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ model_resources: { revision: 7, provider_count: 0, model_count: 0 } });
      }
      const blocked = await app.inject({ method: "GET", url: "/internal/diagnostics?retry=1", headers });
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(read).toHaveBeenCalledTimes(30);
      const otherClient = await app.inject({ method: "GET", url: "/internal/diagnostics", headers, remoteAddress: "127.0.0.2" });
      expect(otherClient.statusCode).toBe(200);
      expect(read).toHaveBeenCalledTimes(31);
      for (const url of ["/internal/live", "/internal/ready", "/api/health"]) {
        expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
      }
    } finally { read.mockRestore(); }
  });

  it("rate-limits job submission before arbitrary commands are launched", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);

    const responses = [];
    for (let index = 0; index < 31; index += 1) {
      responses.push(await app.inject({
        method: "POST",
        url: "/api/jobs?cwd=.",
        payload: { command: [] },
      }));
    }

    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
  });

  it("stays healthy without any upstream runtime", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("serves kernel and notebook routes from the Node manager", async () => {
    const app = buildApp(config("http://127.0.0.1:1"));
    openApps.push(app);
    const status = await app.inject({ method: "GET", url: "/api/kernels/status" });
    expect(status.json()).toMatchObject({ native: true, active_count: 0, interpreters: { python: expect.any(Boolean), r: expect.any(Boolean) } });
  });

  it("provisions the workspace environment before forwarding kernel execution", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-environment-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1"), kernelModules());
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

  it("returns and records rich kernel outputs", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-rich-output-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1"), kernelModules());
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/kernels/execute?cwd=${encodeURIComponent(workspace)}`,
      payload: { language: "python", code: "rich-output", notebook_id: "rich-notebook", session_id: "session-rich" },
    });
    const execution = await app.inject({ method: "GET", url: `/api/executions/${response.json().execution_id}?cwd=${encodeURIComponent(workspace)}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outputs: [
      { output_type: "display_data", data: { "text/plain": "shown" } },
      { output_type: "execute_result", data: { "image/png": "encoded-image" } },
    ] });
    expect(execution.json()).toMatchObject({ result: { outputs: [
      { output_type: "display_data", data: { "text/plain": "shown" } },
      { output_type: "execute_result", data: { "image/png": "encoded-image" } },
    ] } });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("detects files written by a kernel cell as execution evidence", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-output-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1"), kernelModules());
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

  it("exposes artifact publication failures without hiding a successful kernel result", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-artifact-warning-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science", "artifacts.jsonl"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1"), kernelModules());
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/kernels/execute?cwd=${encodeURIComponent(workspace)}`,
      payload: { language: "python", code: "write-output" },
    });
    const execution = await app.inject({ method: "GET", url: `/api/executions/${response.json().execution_id}?cwd=${encodeURIComponent(workspace)}` });

    expect(response.statusCode).toBe(200);
    const code = process.platform === "win32" ? expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/) : "EISDIR";
    expect(response.json()).toMatchObject({ ok: true, artifact_publish_errors: [{ path: "cell-output.csv", code }] });
    expect(execution.json()).toMatchObject({ status: "succeeded", result: { artifact_publish_errors: response.json().artifact_publish_errors } });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("records a kernel-level cell error as a failed execution", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1"), kernelModules());
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

  it("records an intentional kernel interruption separately from failure", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-interrupted-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1"), kernelModules());
    openApps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/kernels/execute?cwd=${encodeURIComponent(workspace)}`, payload: { language: "python", code: "kernel-interrupted" } });
    const execution = await app.inject({ method: "GET", url: `/api/executions/${response.json().execution_id}?cwd=${encodeURIComponent(workspace)}` });

    expect(response.json()).toMatchObject({ ok: false, interrupted: true, error: "KeyboardInterrupt" });
    expect(execution.json()).toMatchObject({ status: "interrupted", result: { error: "KeyboardInterrupt", stdout_preview: "partial\n" } });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("forwards streaming kernel chunks and records the final result", async () => {
    const workspace = join(tmpdir(), `pi-science-kernel-stream-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const app = buildApp(config("http://127.0.0.1:1"), kernelModules());
    openApps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/kernels/execute-stream?cwd=${encodeURIComponent(workspace)}`, payload: { language: "python", code: "stream-output", notebook_id: "stream-test", session_id: "session-1" } });
    const events = response.body.trim().split("\n").map((line) => JSON.parse(line));
    const executionId = events.find((event) => event.type === "started").execution_id;
    const execution = await app.inject({ method: "GET", url: `/api/executions/${executionId}?cwd=${encodeURIComponent(workspace)}` });

    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(events.filter((event) => event.type === "stream").map((event) => event.text)).toEqual(["first\n", "second\n"]);
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true, result: "42", execution_id: executionId });
    expect(execution.json()).toMatchObject({ status: "succeeded", result: { stdout_preview: "first\nsecond\n", mime: { "application/json": "42" } } });
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  // App setup and execution-evidence I/O need the same 30 s budget as neighboring integration cases.
  // The asserted 1,000 ms kernel deadline remains independent of the test runner timeout.
  it.each(["execute", "execute-stream"])("enforces the requested kernel time limit for %s independently of gateway grace", async (endpoint) => {
    const workspace = join(tmpdir(), `pi-kernel-budget-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const execute = vi.spyOn(fakeKernels, "execute");
    try {
      const app = buildApp(config("http://127.0.0.1:1", { upstreamTimeoutMs: 600_000 }), kernelModules()); openApps.push(app);
      const response = await app.inject({ method: "POST", url: `/api/kernels/${endpoint}?cwd=${encodeURIComponent(workspace)}`, payload: { language: "python", code: "1+1", timeout_seconds: 1 } });
      expect(response.statusCode).toBe(200); expect(execute).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
    } finally { execute.mockRestore(); await rm(workspace, { recursive: true, force: true }); }
  }, 30_000);

  it("shuts down core sessions on close even when session routes are off", async () => {
    const modules = createServerModules(config("http://127.0.0.1:1", { nodePiManager: false }));
    const shutdownSpy = vi.spyOn(modules.sessions, "shutdownAll").mockResolvedValue(undefined);
    const app = buildApp(config("http://127.0.0.1:1", { nodePiManager: false }), modules);
    openApps.push(app);

    await app.close();

    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it("shuts down core sessions once when session routes are enabled", async () => {
    const modules = createServerModules(config("http://127.0.0.1:1", { nodePiManager: true }));
    const shutdownSpy = vi.spyOn(modules.sessions, "shutdownAll").mockResolvedValue(undefined);
    const app = buildApp(config("http://127.0.0.1:1", { nodePiManager: true }), modules);
    openApps.push(app);

    await app.close();

    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it("can serve read-only session data from the existing JSONL format", async () => {
    const workspace = join(tmpdir(), `pi-science-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionDir = join(workspace, ".pi-science", "sessions", "encoded");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session-1.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: workspace, timestamp: "2026-07-23T00:00:00.000Z" }),
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-07-23T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-07-23T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const app = buildApp(config("http://127.0.0.1:1", { nodeSessions: true }));
    openApps.push(app);
    const listed = await app.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(workspace)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject([{ id: "session-1", cwd: workspace }]);
    const messages = await app.inject({ method: "GET", url: `/api/sessions/session-1/messages?cwd=${encodeURIComponent(workspace)}` });
    expect(messages.json()).toMatchObject({ messages: [{ id: expect.any(String), role: "user", content: [{ type: "text", text: "hello" }] }, { id: expect.any(String), role: "assistant", content: [{ type: "text", text: "hi" }] }] });
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

  it("requires a model before creating a core session", async () => {
    const workspace = join(tmpdir(), `pi-science-pi-route-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    vi.stubEnv("PI_SCIENCE_HOME", join(workspace, "empty-home"));
    const app = buildApp(config("http://127.0.0.1:1", { nodePiManager: true }));
    openApps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: workspace } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "invalid_model" });
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
