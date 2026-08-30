import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { createServerModules } from "./server-modules.js";
import type { ServerConfig } from "../config/config.js";
import type { KernelExecuteOptions, NodeKernelManager } from "../runtime/kernel/node-kernel-manager.js";
import { InMemorySqliteStateStore } from "../storage/sqlite/state-store.js";
import { FakeExecutor } from "../scheduled-tasks/executor.js";

const openApps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
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
  return { ...createServerModules(config("http://127.0.0.1:1")), kernels: fakeKernels };
}


describe("Node control plane", () => {
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
    expect(response.json()).toEqual({ status: "ok", service: "pi-science-server", control_plane: "node", active_pi_processes: 0, active_kernels: 0 });
  });

  it("protects the control-plane API when a per-launch token is configured", async () => {
    const app = buildApp(config("http://127.0.0.1:1", { internalToken: "test-control-token", requireInternalToken: true }));
    openApps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { "x-pi-science-internal-token": "test-control-token" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { cookie: "pi-science-internal=test-control-token" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "OPTIONS", url: "/api/health" })).statusCode).not.toBe(401);
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
    expect(response.json()).toMatchObject({ ok: true, artifact_publish_errors: [{ path: "cell-output.csv", code: "EISDIR" }] });
    expect(execution.json()).toMatchObject({ status: "succeeded", result: { artifact_publish_errors: [{ path: "cell-output.csv", code: "EISDIR" }] } });
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

  it("serves the scheduled tasks API end-to-end when SQLite is enabled", async () => {
    const previousFlag = process.env.PI_SCIENCE_SCHEDULED_TASKS;
    process.env.PI_SCIENCE_SCHEDULED_TASKS = "1";
    const workspace = await mkdtemp(join(tmpdir(), "pi-science-scheduled-app-"));
    try {
      const store = new InMemorySqliteStateStore();
      await store.start();
      const modules = createServerModules(config("http://127.0.0.1:1"), { sqliteEnabled: true, stateStore: store });
      await modules.workspaces.rememberWorkspace(workspace);
      // Hermetic swap: a claimed attempt must never reach providers or Pi from this test.
      modules.scheduled.registry!.register(new FakeExecutor());
      const app = buildApp(config("http://127.0.0.1:1"), modules);
      openApps.push(app);
      const cwd = encodeURIComponent(workspace);

      const created = await app.inject({
        method: "POST",
        url: `/api/scheduled-tasks?cwd=${cwd}`,
        payload: {
          name: "Daily digest",
          schedule: { type: "interval", every_seconds: 3600, anchor_at: "2026-01-01T00:00:00Z", timezone: "UTC" },
          executor: { kind: "literature_digest", config: { query: "single-cell RNA sequencing quality control", providers: ["pubmed"], max_results: 30, language: "zh-CN" } },
          output: { relative_root: "outputs/digest" },
        },
      });
      expect(created.statusCode).toBe(201);
      const taskId = created.json().task_id;

      const listed = await app.inject({ method: "GET", url: `/api/scheduled-tasks?cwd=${cwd}` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items.map((item: { task_id: string }) => item.task_id)).toEqual([taskId]);

      const run = await app.inject({ method: "POST", url: `/api/scheduled-tasks/${taskId}/run?cwd=${cwd}` });
      expect(run.statusCode).toBe(202);
      expect(String(run.headers.location)).toContain(`/api/scheduled-tasks/${taskId}/runs/`);
      const located = await app.inject({ method: "GET", url: String(run.headers.location) });
      expect(located.statusCode).toBe(200);
      expect(located.json()).toMatchObject({ task_id: taskId, trigger_source: "manual" });

      const diagnostics = await app.inject({ method: "GET", url: "/internal/diagnostics" });
      expect(diagnostics.json().scheduled_tasks).toMatchObject({ feature_enabled: true, sqlite_ready: true });
    } finally {
      if (previousFlag === undefined) delete process.env.PI_SCIENCE_SCHEDULED_TASKS;
      else process.env.PI_SCIENCE_SCHEDULED_TASKS = previousFlag;
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it("settles scheduled runtimes before closing SQLite on shutdown (docs §11.5)", async () => {
    const previousFlag = process.env.PI_SCIENCE_SCHEDULED_TASKS;
    process.env.PI_SCIENCE_SCHEDULED_TASKS = "1";
    try {
      const store = new InMemorySqliteStateStore();
      await store.start();
      const modules = createServerModules(config("http://127.0.0.1:1"), { sqliteEnabled: true, stateStore: store });
      const order: string[] = [];
      const realSchedulerStop = modules.scheduled.scheduler!.stop.bind(modules.scheduled.scheduler!);
      vi.spyOn(modules.scheduled.scheduler!, "stop").mockImplementation(async () => { order.push("scheduler.stop"); await realSchedulerStop(); });
      const realDispatcherShutdown = modules.scheduled.dispatcher!.shutdown.bind(modules.scheduled.dispatcher!);
      vi.spyOn(modules.scheduled.dispatcher!, "shutdown").mockImplementation(async () => { order.push("dispatcher.shutdown"); await realDispatcherShutdown(); });
      const realStoreClose = modules.stateStore.close.bind(modules.stateStore);
      vi.spyOn(modules.stateStore, "close").mockImplementation(async () => { order.push("stateStore.close"); await realStoreClose(); });
      const app = buildApp(config("http://127.0.0.1:1"), modules);
      openApps.push(app);
      await app.inject({ method: "GET", url: "/internal/live" });
      await app.close();
      expect(order).toEqual(["scheduler.stop", "dispatcher.shutdown", "stateStore.close"]);
    } finally {
      if (previousFlag === undefined) delete process.env.PI_SCIENCE_SCHEDULED_TASKS;
      else process.env.PI_SCIENCE_SCHEDULED_TASKS = previousFlag;
    }
  });

  it("answers scheduled task routes with uniform 503s when SQLite is disabled", async () => {
    const previousFlag = process.env.PI_SCIENCE_SCHEDULED_TASKS;
    process.env.PI_SCIENCE_SCHEDULED_TASKS = "1";
    try {
      const modules = createServerModules(config("http://127.0.0.1:1"), { sqliteEnabled: false });
      expect(modules.scheduled.scheduler).toBeNull();
      const app = buildApp(config("http://127.0.0.1:1"), modules);
      openApps.push(app);
      const response = await app.inject({ method: "GET", url: "/api/scheduled-tasks?cwd=." });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "SCHEDULED_TASKS_SQLITE_DISABLED", request_id: expect.any(String) });
      // The feature flag alone also disables every route.
      process.env.PI_SCIENCE_SCHEDULED_TASKS = "0";
      const flaggedOff = await app.inject({ method: "GET", url: "/api/scheduled-tasks?cwd=." });
      expect(flaggedOff.statusCode).toBe(503);
      expect(flaggedOff.json().code).toBe("SCHEDULED_TASKS_DISABLED");
    } finally {
      if (previousFlag === undefined) delete process.env.PI_SCIENCE_SCHEDULED_TASKS;
      else process.env.PI_SCIENCE_SCHEDULED_TASKS = previousFlag;
    }
  });
});
