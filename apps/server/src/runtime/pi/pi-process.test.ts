import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiManager } from "./pi-manager.js";
import { buildPiProcessOptions, resetWebRuntimeAllocation } from "./pi-runtime-launch.js";

const managers: PiManager[] = [];

const originalDisposeTimeout = process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS;

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
  if (originalDisposeTimeout === undefined) delete process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS;
  else process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS = originalDisposeTimeout;
});

async function fakeRuntime(): Promise<{ cwd: string; command: string; args: string[] }> {
  const cwd = join(tmpdir(), `pi-science-pi-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(cwd, { recursive: true });
  const script = join(cwd, "fake-pi.mjs");
  await writeFile(script, [
    'import readline from "node:readline";',
    'const input = readline.createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  process.stdout.write(JSON.stringify({ id: request.id, success: true, data: { type: request.type } }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "session.idle", sessionId: "s1" }) + "\\n");',
    '});',
  ].join("\n"), "utf8");
  return { cwd, command: process.execPath, args: [script] };
}

async function fakeWebRuntime(
  createFailure = false,
  initialTrustDecision: boolean | null = null,
  busyGets = 0,
  deleteBusyTurns = 0,
  busyMs = 0,
  detachEventsOnResume = false,
): Promise<{
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  web: {
    baseUrl: string;
    authToken: string;
    runtime: { cwd: string; sessionDir: string };
  };
}> {
  const cwd = join(tmpdir(), `pi-science-pi-orbit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(cwd, { recursive: true });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("unable to allocate test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const script = join(cwd, "fake-pi-orbit.mjs");
  await writeFile(script, [
    'import http from "node:http";',
    'const token = process.env.FAKE_WEB_TOKEN;',
    'let counter = 0;',
    `let trustDecision = ${JSON.stringify(initialTrustDecision)};`,
    'const runtimes = new Map();',
    'const clients = new Map();',
    `let busyGets = ${busyGets};`,
    `let deleteBusyTurns = ${deleteBusyTurns};`,
    `const busyUntil = ${busyMs} > 0 ? Date.now() + ${busyMs} : 0;`,
    `const detachEventsOnResume = ${detachEventsOnResume};`,
    'let deleteCount = 0;',
    'import { writeFileSync } from "node:fs";',
    'function json(response, status, value) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }',
    'function event(runtimeId, value) { for (const response of clients.get(runtimeId) ?? []) response.write(`event: runtime_event\\nid: 1\\ndata: ${JSON.stringify({ sequence: 1, event: value })}\\n\\n`); }',
    'async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }',
    'const server = http.createServer(async (request, response) => {',
    '  if (request.headers.authorization !== `Bearer ${token}` && request.url !== "/api/health") return json(response, 401, { error: "Unauthorized" });',
    '  if (request.url === "/api/health") return json(response, 200, { status: "ok" });',
    '  if (request.url === "/api/capabilities") return json(response, 200, { protocolVersion: 1, isolationModel: "single-user-shared-process", features: { runtimeApi: true, eventReplay: true, browserSessionAuth: true, workspaceBinding: true, projectTrustApi: true, legacySessionApi: true } });',
    `  if (request.url?.startsWith("/api/project-trust?") && request.method === "GET") return json(response, 200, { cwd: ${JSON.stringify(cwd)}, required: true, decision: trustDecision });`,
    '  if (request.url === "/api/project-trust" && request.method === "PUT") { const value = await body(request); trustDecision = value.decision; return json(response, 200, { cwd: value.cwd, required: true, decision: trustDecision }); }',
    `  if (request.url === "/api/runtimes" && request.method === "POST") { const value = await body(request); if (trustDecision !== true) return json(response, 409, { error: "Trust required", code: "project_trust_required" }); ${createFailure ? 'return json(response, 422, { error: "Runtime initialization failed", code: "runtime_initialization_failed", diagnostics: [{ type: "error", message: "broken skill" }] });' : 'const runtimeId = `runtime-${++counter}`; const piSessionId = `session-${counter}`; const runtime = { runtimeId, piSessionId, sessionPath: `${value.sessionDir}/${piSessionId}.jsonl`, sessionDir: value.sessionDir, workspaceCwd: value.cwd, persisted: true, diagnostics: [] }; runtimes.set(runtimeId, runtime); return json(response, 201, runtime);'} }`,
    '  const parsed = new URL(request.url ?? "/", "http://127.0.0.1"); const parts = parsed.pathname.split("/");',
    '  if (parts[1] === "api" && parts[2] === "runtimes" && parts[3]) {',
    '    const runtimeId = parts[3]; const suffix = parts.length > 4 ? `/${parts.slice(4).join("/")}` : ""; const runtime = runtimes.get(runtimeId);',
    '    if (!runtime) return json(response, 404, { error: "Runtime not found" });',
    '    if (!suffix && request.method === "GET") { const busy = busyGets > 0 || (busyUntil > 0 && Date.now() < busyUntil); if (busyGets > 0) busyGets -= 1; return json(response, 200, { ...runtime, busy }); }',
    '    if (suffix === "/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`event: connected\\ndata: ${JSON.stringify({ runtimeId })}\\n\\n`); const set = clients.get(runtimeId) ?? new Set(); set.add(response); clients.set(runtimeId, set); request.on("close", () => set.delete(response)); return; }',
    '    if (suffix === "/state") return json(response, 200, { piSessionId: runtime.piSessionId, isStreaming: false, pendingMessageCount: 0 });',
    '    if (suffix === "/commands") return json(response, 200, { commands: [{ name: "review", source: "skill" }] });',
    '    if (suffix === "/resume" && request.method === "POST") { const value = await body(request); runtime.piSessionId = "restored-session"; runtime.sessionPath = value.sessionPath; if (detachEventsOnResume) clients.set(runtimeId, new Set()); return json(response, 200, { success: true, runtimeId, piSessionId: runtime.piSessionId }); }',
    '    if (suffix === "/prompt" && request.method === "POST") { await body(request); json(response, 202, { success: true }); event(runtimeId, { type: "agent_start", sessionId: runtime.piSessionId }); return; }',
    '    if (suffix === "/fork" && request.method === "POST") { await body(request); runtime.piSessionId = `fork-${++counter}`; runtime.sessionPath = `${runtime.sessionDir}/${runtime.piSessionId}.jsonl`; return json(response, 200, { success: true, runtimeId, piSessionId: runtime.piSessionId }); }',
    '    if (!suffix && request.method === "DELETE") { deleteCount += 1; writeFileSync("delete-count.json", String(deleteCount)); if (deleteBusyTurns > 0) { deleteBusyTurns -= 1; return json(response, 409, { error: "Runtime is busy", code: "runtime_busy" }); } runtimes.delete(runtimeId); return json(response, 200, { success: true }); }',
    '  }',
    '  return json(response, 404, { error: "Not found" });',
    '});',
    `server.listen(${port}, "127.0.0.1");`,
  ].join("\n"), "utf8");
  return {
    cwd,
    command: process.execPath,
    args: [script],
    env: { ...process.env, FAKE_WEB_TOKEN: "test-token" },
    web: {
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: "test-token",
      runtime: { cwd, sessionDir: join(cwd, "sessions") },
    },
  };
}

describe("Node Pi JSONL adapter", () => {
  it("correlates commands and emits unsolicited events", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const process = await manager.start("workspace", runtime);
    const events: string[] = [];
    process.on("event", (event: { type: string }) => events.push(event.type));
    await expect(manager.sendCommand("workspace", "get_state")).resolves.toMatchObject({ success: true, data: { type: "get_state" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContain("session.idle");
    await manager.stop("workspace");
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("returns a stable error when the process exits", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeRuntime();
    const process = await manager.start("workspace", runtime);
    await process.shutdown();
    await expect(manager.sendCommand("workspace", "get_state")).resolves.toMatchObject({ code: "not_found" });
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});

describe("Node Pi Orbit adapter", () => {
  it("shares one host process across isolated runtimes and streams scoped events", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime();
    const process = await manager.start("web-workspace", runtime);
    const second = await manager.start("web-workspace-2", runtime);
    const events: string[] = [];
    process.on("event", (event: { type: string }) => events.push(event.type));

    expect(manager.hostProcessCount).toBe(1);
    expect(process.child.pid).toBe(second.child.pid);
    expect(process.runtimeIdentity).toMatchObject({
      runtimeId: "runtime-1",
      piSessionId: "session-1",
      workspaceCwd: runtime.cwd,
      persisted: true,
    });

    await expect(manager.sendCommand("web-workspace", "get_state")).resolves.toMatchObject({
      success: true,
      data: { sessionId: "session-1" },
    });
    await expect(manager.sendCommand("web-workspace-2", "get_state")).resolves.toMatchObject({
      success: true,
      data: { sessionId: "session-2" },
    });
    await expect(manager.sendCommand("web-workspace", "get_commands")).resolves.toMatchObject({
      success: true,
      data: { commands: [{ name: "review", source: "skill" }] },
    });
    await expect(manager.sendCommand("web-workspace", "prompt", { message: "hello" })).resolves.toMatchObject({ success: true });
    for (let attempt = 0; attempt < 50 && !events.includes("agent_start"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events).toContain("agent_start");
    await expect(manager.sendCommand("web-workspace", "fork")).resolves.toMatchObject({ success: true, piSessionId: "fork-3" });
    expect(process.runtimeIdentity).toMatchObject({ runtimeId: "runtime-1", piSessionId: "fork-3" });
    await manager.stop("web-workspace");
    expect(manager.hostProcessCount).toBe(1);
    await expect(manager.sendCommand("web-workspace-2", "get_state")).resolves.toMatchObject({ success: true });
    await manager.shutdownAll();
    expect(manager.hostProcessCount).toBe(0);
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("reattaches the Orbit event stream after resuming a persisted session", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime(false, null, 0, 0, 0, true);
    const process = await manager.start("restored-workspace", runtime);
    const events: Array<{ type: string; sessionId?: string }> = [];
    process.on("event", (event: { type: string; sessionId?: string }) => events.push(event));

    await expect(manager.sendCommand("restored-workspace", "switch_session", {
      sessionPath: join(runtime.cwd, "sessions", "restored-session.jsonl"),
    })).resolves.toMatchObject({ success: true });
    await expect(manager.sendCommand("restored-workspace", "prompt", { message: "hello again" }))
      .resolves.toMatchObject({ success: true });

    for (let attempt = 0; attempt < 50 && !events.some((event) => event.type === "agent_start"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events).toContainEqual({ type: "agent_start", sessionId: "restored-session" });
    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("tracks event-stream liveness instrumentation", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime();
    const process = await manager.start("web-workspace-liveness", runtime);
    expect(process.attachedToHost).toBe(true);
    for (let attempt = 0; attempt < 50 && process.lastEventAt === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(process.lastEventAt).toBeGreaterThan(0);
    expect(process.eventStreamAlive).toBe(true);
    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("reconnects the event stream from the last sequence", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime();
    const process = await manager.start("web-workspace-reconnect", runtime);
    const events: string[] = [];
    process.on("event", (event: { type: string }) => events.push(event.type));
    for (let attempt = 0; attempt < 50 && process.lastEventAt === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await process.reconnectEventStream();
    expect(process.eventStreamAlive).toBe(true);
    await expect(manager.sendCommand("web-workspace-reconnect", "prompt", { message: "hello" })).resolves.toMatchObject({ success: true });
    for (let attempt = 0; attempt < 50 && !events.includes("agent_start"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events).toContain("agent_start");
    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("preserves stable Pi Orbit initialization errors and diagnostics", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime(true);

    await expect(manager.start("broken-workspace", runtime)).rejects.toMatchObject({
      code: "runtime_initialization_failed",
      status: 422,
      payload: { diagnostics: [{ type: "error", message: "broken skill" }] },
    });

    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("defaults a legacy untrusted workspace to trusted", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime(false, false);

    await expect(manager.start("legacy-untrusted-workspace", runtime)).resolves.toBeDefined();

    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("disposes a busy runtime once it stops being busy", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime(false, null, 2);
    await manager.start("busy-then-free", runtime);

    // GET reports busy twice, then free: dispose must poll through the busy
    // window and still delete the runtime instead of giving up after 2s.
    await manager.stop("busy-then-free");
    expect(manager.get("busy-then-free")).toBeUndefined();
    expect(manager.hostProcessCount).toBe(1);

    // The runtime must actually be gone from the host, not just from the map.
    const deleted = await fetch(`${runtime.web!.baseUrl}/api/runtimes/runtime-1`, {
      headers: { authorization: `Bearer ${runtime.web!.authToken}` },
    });
    expect(deleted.status).toBe(404);

    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("retries DELETE while the host keeps reporting busy", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime(false, null, 0, 2);
    await manager.start("delete-409", runtime);

    // DELETE returns 409 twice, then succeeds: the dispose loop must back off
    // and retry instead of recording a single failure and leaking the runtime.
    await manager.stop("delete-409");
    expect(manager.hostProcessCount).toBe(1);

    // The runtime must actually be gone from the host, not just from the map.
    const deleted = await fetch(`${runtime.web!.baseUrl}/api/runtimes/runtime-1`, {
      headers: { authorization: `Bearer ${runtime.web!.authToken}` },
    });
    expect(deleted.status).toBe(404);

    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("disposes even with a tiny budget (do-while runs at least once)", async () => {
    const previous = process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS;
    process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS = "1";
    try {
      const manager = new PiManager();
      managers.push(manager);
      const runtime = await fakeWebRuntime(false, null, 0, 0);
      await manager.start("tiny-budget", runtime);

      await manager.stop("tiny-budget");

      // Even with a 1ms budget the first GET+DELETE attempt must still run.
      const deleted = await fetch(`${runtime.web!.baseUrl}/api/runtimes/runtime-1`, {
        headers: { authorization: `Bearer ${runtime.web!.authToken}` },
      });
      expect(deleted.status).toBe(404);

      await manager.shutdownAll();
      await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      if (previous === undefined) delete process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS;
      else process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS = previous;
    }
  });

  it("gives up within the budget when the runtime stays busy", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime(false, null, Infinity);
    process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS = "400";
    const stderr: string[] = [];
    await manager.start("always-busy", runtime);
    const piProcess = manager.get("always-busy");
    if (!piProcess) throw new Error("process not found");
    piProcess.on("stderr", (text: string) => stderr.push(text));

    // The runtime never stops being busy: dispose must time out (budget 400ms)
    // without throwing and without killing the shared host.
    await expect(manager.stop("always-busy")).resolves.toBeUndefined();
    expect(manager.hostProcessCount).toBe(1);
    expect(stderr.join("")).toContain("Unable to dispose Pi Orbit runtime within");

    await manager.shutdownAll();
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("shutdownAll tears the host down directly without waiting for busy runtimes", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const runtime = await fakeWebRuntime(false, null, Infinity);
    await manager.start("shutdown-fast", runtime);

    // The runtime stays busy forever; shutdownAll must not spend the dispose
    // budget on it (the host is about to die anyway).
    const started = Date.now();
    await manager.shutdownAll();
    const elapsed = Date.now() - started;

    expect(manager.hostProcessCount).toBe(0);
    expect(elapsed).toBeLessThan(10_000);

    // Discriminating assertion: shutdownAll skips per-runtime dispose entirely
    // (the host is killed directly), so the fake host must never have seen a
    // single DELETE. A legacy shutdownAll that disposed each runtime first
    // would leave delete-count.json at 1+.
    const deleteCount = JSON.parse(await readFile(join(runtime.cwd, "delete-count.json"), "utf8").catch(() => "0"));
    expect(deleteCount).toBe(0);
    await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("self-heals with a fresh port after the reserved one is taken", async () => {
    const manager = new PiManager();
    managers.push(manager);
    const root = join(tmpdir(), `pi-science-eaddrinuse-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(root, { recursive: true });
    const originalHome = process.env.PI_SCIENCE_HOME;
    const originalCli = process.env.PI_CLI_PATH;
    const originalMode = process.env.PI_SCIENCE_PI_MODE;
    try {
      process.env.PI_SCIENCE_HOME = join(root, "control-home");
      await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
      // Minimal fake Pi Orbit host: binds the --port argv and answers the
      // readiness/capability/trust/runtime endpoints the control plane needs.
      const script = join(root, "fake-orbit.mjs");
      await writeFile(script, [
        'import http from "node:http";',
        'const argv = process.argv.slice(2);',
        'const port = Number(argv[argv.indexOf("--port") + 1]);',
        'let counter = 0;',
        'function json(response, status, value) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }',
        'const server = http.createServer(async (request, response) => {',
        '  const parsed = new URL(request.url ?? "/", "http://127.0.0.1");',
        '  if (parsed.pathname === "/api/health") return json(response, 200, { status: "ok" });',
        '  if (parsed.pathname === "/api/capabilities") return json(response, 200, { protocolVersion: 1, isolationModel: "single-user-shared-process", features: { runtimeApi: true, eventReplay: true, browserSessionAuth: true, workspaceBinding: true, projectTrustApi: true, legacySessionApi: true } });',
        '  if (parsed.pathname.startsWith("/api/project-trust")) return json(response, 200, { cwd: String(parsed.searchParams.get("cwd") ?? ""), required: false, decision: true });',
        '  if (parsed.pathname === "/api/runtimes" && request.method === "POST") {',
        '    const chunks = []; for await (const chunk of request) chunks.push(chunk);',
        '    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");',
        '    const runtimeId = `runtime-${++counter}`;',
        '    return json(response, 201, { runtimeId, piSessionId: `session-${counter}`, sessionPath: `${value.sessionDir}/${counter}.jsonl`, sessionDir: value.sessionDir, workspaceCwd: value.cwd, persisted: true, diagnostics: [] });',
        '  }',
        '  const parts = parsed.pathname.split("/");',
        '  if (parts[1] === "api" && parts[2] === "runtimes" && parts[3]) {',
        '    const runtimeId = parts[3];',
        '    const suffix = parts.length > 4 ? `/${parts.slice(4).join("/")}` : "";',
        '    if (!suffix && request.method === "GET") return json(response, 200, { runtimeId, busy: false });',
        '    if (suffix === "/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`event: connected\\ndata: ${JSON.stringify({ runtimeId })}\\n\\n`); return; }',
        '    if (!suffix && request.method === "DELETE") return json(response, 200, { success: true });',
        '  }',
        '  return json(response, 404, { error: "Not found" });',
        '});',
        'server.listen(port, "127.0.0.1");',
      ].join("\n"), "utf8");
      process.env.PI_CLI_PATH = script;
      delete process.env.PI_SCIENCE_PI_MODE;
      resetWebRuntimeAllocation();

      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const first = buildPiProcessOptions(workspace)!;
      const port1 = new URL(first.web!.baseUrl).port;

      // Occupy the reserved port so the spawned host cannot bind it. Destroy
      // accepted connections so the control plane's health probes fail fast
      // and blocker.close() is not held open by keep-alive sockets.
      const blocker = createServer();
      blocker.on("connection", (socket) => socket.destroy());
      await new Promise<void>((resolve) => blocker.listen(Number(port1), "127.0.0.1", resolve));
      try {
        first.requestTimeoutMs = 600;
        // The host cannot become ready: health probes fail (connection reset by
        // the blocker) and the spawned host process dies on EADDRINUSE.
        await expect(manager.start("addr-in-use", first)).rejects.toThrow(/fetch failed|did not become ready/i);
        expect(manager.hostProcessCount).toBe(0);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }

      // The failed start must reset the singleton: the next allocation picks
      // a different port instead of retrying the occupied one forever.
      const second = buildPiProcessOptions(workspace)!;
      const port2 = new URL(second.web!.baseUrl).port;
      expect(port2).not.toBe(port1);

      second.requestTimeoutMs = 10_000;
      await manager.start("addr-in-use-2", second);
      expect(manager.hostProcessCount).toBe(1);

      await manager.shutdownAll();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
      else process.env.PI_SCIENCE_HOME = originalHome;
      if (originalCli === undefined) delete process.env.PI_CLI_PATH;
      else process.env.PI_CLI_PATH = originalCli;
      if (originalMode === undefined) delete process.env.PI_SCIENCE_PI_MODE;
      else process.env.PI_SCIENCE_PI_MODE = originalMode;
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  });

  it("waits out a busy runtime longer than the legacy 2s dispose budget", async () => {
    const manager = new PiManager();
    managers.push(manager);
    // The host reports busy for 3.5s wall-clock. The legacy dispose loop gave
    // up after 2s and leaked the runtime; the budgeted loop (10s) must poll
    // through the busy window and still delete it. A count-based busy window
    // cannot discriminate the two (the legacy loop polls every 25ms and would
    // exhaust any small count inside its 2s budget).
    const runtime = await fakeWebRuntime(false, null, 0, 0, 3_500);
    const previous = process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS;
    process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS = "10000";
    try {
      await manager.start("long-busy-window", runtime);

      const started = Date.now();
      await manager.stop("long-busy-window");
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThan(2_500);
      expect(manager.hostProcessCount).toBe(1);
      const deleted = await fetch(`${runtime.web!.baseUrl}/api/runtimes/runtime-1`, {
        headers: { authorization: `Bearer ${runtime.web!.authToken}` },
      });
      expect(deleted.status).toBe(404);

      await manager.shutdownAll();
      await rm(runtime.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      if (previous === undefined) delete process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS;
      else process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS = previous;
    }
  });
});
