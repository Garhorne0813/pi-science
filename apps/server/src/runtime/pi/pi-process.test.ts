import { mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiManager } from "./pi-manager.js";

const managers: PiManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
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

async function fakeWebRuntime(createFailure = false, initialTrustDecision: boolean | null = null): Promise<{
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
    '    if (!suffix && request.method === "GET") return json(response, 200, runtime);',
    '    if (suffix === "/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`event: connected\\ndata: ${JSON.stringify({ runtimeId })}\\n\\n`); const set = clients.get(runtimeId) ?? new Set(); set.add(response); clients.set(runtimeId, set); request.on("close", () => set.delete(response)); return; }',
    '    if (suffix === "/state") return json(response, 200, { piSessionId: runtime.piSessionId, isStreaming: false, pendingMessageCount: 0 });',
    '    if (suffix === "/commands") return json(response, 200, { commands: [{ name: "review", source: "skill" }] });',
    '    if (suffix === "/prompt" && request.method === "POST") { await body(request); json(response, 202, { success: true }); event(runtimeId, { type: "agent_start", sessionId: runtime.piSessionId }); return; }',
    '    if (suffix === "/fork" && request.method === "POST") { await body(request); runtime.piSessionId = `fork-${++counter}`; runtime.sessionPath = `${runtime.sessionDir}/${runtime.piSessionId}.jsonl`; return json(response, 200, { success: true, runtimeId, piSessionId: runtime.piSessionId }); }',
    '    if (!suffix && request.method === "DELETE") { runtimes.delete(runtimeId); return json(response, 200, { success: true }); }',
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
});
