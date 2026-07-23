import Fastify from "fastify";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerNodeSessionRoutes } from "./node-session-routes.js";
import { nodeSessionService } from "./node-session-service.js";
import { registerSessionReadRoutes } from "./session-routes.js";

const cleanup: string[] = [];
const original = {
  home: process.env.PI_SCIENCE_HOME,
  cli: process.env.PI_CLI_PATH,
  node: process.env.PI_NODE_PATH,
  log: process.env.FAKE_PI_LOG,
  mode: process.env.FAKE_PI_MODE,
};

beforeEach(async () => {
  const root = join(tmpdir(), `pi-science-node-routes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  const script = join(root, "fake-pi.mjs");
  await writeFile(script, [
    'import fs from "node:fs";',
    'import readline from "node:readline";',
    'const args = process.argv.slice(2);',
    'const sessionArg = args.indexOf("--session");',
    'let sessionId = sessionArg >= 0 ? JSON.parse(fs.readFileSync(args[sessionArg + 1], "utf8").split("\\n")[0]).id : `blank-${process.pid}`;',
    'let counter = 0;',
    'let busy = false;',
    'const input = readline.createInterface({ input: process.stdin });',
    'function log(request) { if (process.env.FAKE_PI_LOG) fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(request) + "\\n"); }',
    'function respond(request, extra = {}) { process.stdout.write(JSON.stringify({ id: request.id, success: true, ...extra }) + "\\n"); }',
    'input.on("line", (line) => {',
    '  const request = JSON.parse(line); log(request);',
    '  if (!request.id) return;',
    '  if (request.type === "get_state") return respond(request, { data: { sessionId, isStreaming: busy, isCompacting: false, pendingMessageCount: 0, model: { provider: "openrouter", id: "openai/gpt-5.1" }, thinkingLevel: "high" } });',
    '  if (request.type === "switch_session") { sessionId = JSON.parse(fs.readFileSync(request.sessionPath, "utf8").split("\\n")[0]).id; return respond(request); }',
    '  if (request.type === "new_session" || request.type === "clone" || request.type === "fork") { sessionId = `fork-${++counter}-${process.pid}`; return respond(request); }',
    '  if (request.type === "prompt") { busy = true; respond(request); process.stdout.write(JSON.stringify({ type: "agent_start", sessionId }) + "\\n"); return; }',
    '  if (request.type === "abort") { busy = false; respond(request); process.stdout.write(JSON.stringify({ type: "agent_settled", sessionId, handledWithoutTurn: true }) + "\\n"); return; }',
    '  if (request.type === "get_commands") { if (process.env.FAKE_PI_MODE === "commands-error") return process.stdout.write(JSON.stringify({ id: request.id, success: false, code: "commands_failed", error: "commands unavailable" }) + "\\n"); if (process.env.FAKE_PI_MODE === "commands-cancelled") return respond(request, { data: { cancelled: true } }); return respond(request, { data: { commands: [{ name: "review", source: "skill" }] } }); }',
    '  respond(request);',
    '});',
  ].join("\n"), "utf8");
  process.env.PI_SCIENCE_HOME = join(root, "data");
  process.env.PI_CLI_PATH = script;
  process.env.PI_NODE_PATH = process.execPath;
  process.env.FAKE_PI_LOG = join(root, "rpc.jsonl");
});

afterEach(async () => {
  await nodeSessionService.shutdownAll();
  for (const [key, value] of Object.entries(original)) {
    const environmentKey = key === "home" ? "PI_SCIENCE_HOME" : key === "cli" ? "PI_CLI_PATH" : key === "node" ? "PI_NODE_PATH" : key === "mode" ? "FAKE_PI_MODE" : "FAKE_PI_LOG";
    if (value === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = value;
  }
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspaceWithSessions(...ids: string[]): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-route-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  const directory = join(cwd, ".pi-science", "sessions");
  await mkdir(directory, { recursive: true });
  for (const id of ids) {
    await writeFile(join(directory, `${id}.jsonl`), [
      JSON.stringify({ type: "session", id, cwd, timestamp: "2026-07-23T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: `${id}-user`, message: { role: "user", content: [{ type: "text", text: `<hello ${id}>` }] } }),
      JSON.stringify({ type: "message", id: `${id}-assistant`, message: { role: "assistant", content: [{ type: "text", text: `answer ${id}` }] } }),
    ].join("\n") + "\n", "utf8");
  }
  return realpath(cwd);
}

function app() {
  const server = Fastify({ logger: false });
  registerSessionReadRoutes(server);
  registerNodeSessionRoutes(server);
  return server;
}

describe("native Node conversation routes", () => {
  it("lists an active blank session and switches repeatedly between persisted sessions", async () => {
    const cwd = await workspaceWithSessions("session-a", "session-b");
    const server = app();
    const created = await server.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    expect(created.statusCode).toBe(200);
    const blankId = created.json().id as string;

    const listed = await server.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}` });
    expect(listed.json().map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([blankId, "session-a", "session-b"]));

    for (const id of ["session-a", "session-b", "session-a"]) {
      const state = await server.inject({ method: "GET", url: `/api/sessions/${id}/state?cwd=${encodeURIComponent(cwd)}` });
      expect(state.statusCode).toBe(200);
      expect(state.json()).toMatchObject({ ok: true, id });
    }
    await server.close();
  });

  it("enforces busy status and owns fork, interaction, commands, model, export, and exact delete routes", async () => {
    const cwd = await workspaceWithSessions("session-a", "session-b");
    const server = app();
    const query = `cwd=${encodeURIComponent(cwd)}`;

    expect((await server.inject({ method: "GET", url: `/api/sessions/session-a/state?${query}` })).statusCode).toBe(200);
    const model = await server.inject({ method: "POST", url: `/api/sessions/session-a/model?${query}`, payload: { model: "openrouter/openai/gpt-5.1", thinking: "high" } });
    expect(model.statusCode).toBe(200);
    expect(model.json()).toMatchObject({ ok: true, model: "openrouter/openai/gpt-5.1" });

    const commands = await server.inject({ method: "GET", url: `/api/sessions/session-a/commands?${query}` });
    expect(commands.json()).toMatchObject({ commands: [{ name: "review", source: "skill" }] });
    const interaction = await server.inject({ method: "POST", url: `/api/sessions/session-a/interactions/question-1?${query}`, payload: { confirmed: true } });
    expect(interaction.statusCode).toBe(200);

    const exported = await server.inject({ method: "GET", url: `/api/sessions/session-a/export?${query}&format=html` });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("session-session-");
    expect(exported.body).toContain("&lt;hello session-a&gt;");

    const forked = await server.inject({ method: "POST", url: `/api/sessions/session-a/fork?${query}`, payload: { entry_id: "entry-7" } });
    expect(forked.statusCode, forked.body).toBe(200);
    expect(forked.json().id).not.toBe("session-a");

    const prompt = await server.inject({ method: "POST", url: `/api/sessions/${forked.json().id}/prompt?${query}`, payload: { message: "hold" } });
    expect(prompt.statusCode).toBe(200);
    const compact = await server.inject({ method: "POST", url: `/api/sessions/${forked.json().id}/compact?${query}` });
    expect(compact.statusCode).toBe(409);
    expect(compact.json()).toMatchObject({ code: "busy" });
    const createWhileBusy = await server.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    expect(createWhileBusy.statusCode).toBe(409);
    await server.inject({ method: "POST", url: `/api/sessions/${forked.json().id}/abort?${query}` });

    const deleted = await server.inject({ method: "DELETE", url: `/api/sessions/session-b?${query}` });
    expect(deleted.statusCode).toBe(200);
    await expect(access(join(cwd, ".pi-science", "sessions", "session-b.jsonl"))).rejects.toThrow();
    await expect(readFile(join(cwd, ".pi-science", "sessions", "session-a.jsonl"), "utf8")).resolves.toContain('"id":"session-a"');

    const log = await readFile(process.env.FAKE_PI_LOG!, "utf8");
    expect(log).toContain('"type":"set_model","provider":"openrouter","modelId":"openai/gpt-5.1"');
    expect(log).toContain('"type":"extension_ui_response","id":"question-1","confirmed":true');
    expect(log).toContain('"type":"fork","entryId":"entry-7"');
    await server.close();
  });

  it("returns runtime command errors and cancellations instead of disguising them as an empty command list", async () => {
    for (const [mode, statusCode, code] of [["commands-error", 502, "commands_failed"], ["commands-cancelled", 409, "cancelled"]] as const) {
      process.env.FAKE_PI_MODE = mode;
      const cwd = await workspaceWithSessions(`session-${mode}`);
      const server = app();
      const response = await server.inject({ method: "GET", url: `/api/sessions/session-${mode}/commands?cwd=${encodeURIComponent(cwd)}` });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ ok: false, code });
      await server.close();
      await nodeSessionService.shutdownAll();
    }
  });
});
