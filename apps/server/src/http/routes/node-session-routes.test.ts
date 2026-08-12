import Fastify from "fastify";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodeSessionRoutes } from "./node-session-routes.js";
import { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { registerSessionReadRoutes } from "./session-routes.js";
import { sessionRepository } from "../../runtime/node/session-repository.js";
import { ConversationNavigationRepository } from "../../conversation-navigation/repository.js";
import { AI_TITLE_PROMPT_INSTRUCTION } from "../../runtime/title/title-prompt.js";

const cleanup: string[] = [];
const nodeSessionService = new NodeSessionService(undefined, undefined, undefined, {
  async environment(_cwd: string, inherited: NodeJS.ProcessEnv = process.env) { return { ...inherited }; },
});
const original = {
  home: process.env.PI_SCIENCE_HOME,
  cli: process.env.PI_CLI_PATH,
  node: process.env.PI_NODE_PATH,
  log: process.env.FAKE_PI_LOG,
  mode: process.env.FAKE_PI_MODE,
  piMode: process.env.PI_SCIENCE_PI_MODE,
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
  process.env.PI_SCIENCE_PI_MODE = "rpc";
  process.env.FAKE_PI_LOG = join(root, "rpc.jsonl");
});

afterEach(async () => {
  await nodeSessionService.shutdownAll();
  for (const [key, value] of Object.entries(original)) {
    const environmentKey = key === "home" ? "PI_SCIENCE_HOME" : key === "cli" ? "PI_CLI_PATH" : key === "node" ? "PI_NODE_PATH" : key === "mode" ? "FAKE_PI_MODE" : key === "piMode" ? "PI_SCIENCE_PI_MODE" : "FAKE_PI_LOG";
    if (value === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = value;
  }
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
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
  registerSessionReadRoutes(server, sessionRepository, nodeSessionService);
  registerNodeSessionRoutes(server, nodeSessionService, sessionRepository);
  return server;
}

describe("native Node conversation routes", () => {
  it("generates an AI title for an existing session and 404s unknown sessions", async () => {
    const cwd = await workspaceWithSessions("session-title");
    const aiTitleService = {
      async generateTitle(workspace: string, sessionId: string) {
        expect(workspace).toBe(cwd);
        expect(sessionId).toBe("session-title");
        return "AI 标题";
      },
    };
    const server = Fastify({ logger: false });
    registerNodeSessionRoutes(server, nodeSessionService, sessionRepository, aiTitleService as never);
    const ok = await server.inject({ method: "POST", url: `/api/sessions/session-title/title?cwd=${encodeURIComponent(cwd)}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, title: "AI 标题" });
    const missing = await server.inject({ method: "POST", url: `/api/sessions/no-such/title?cwd=${encodeURIComponent(cwd)}` });
    expect(missing.statusCode).toBe(404);
    await server.close();
  });

  it("persists the generated AI title server-side without a client PUT", async () => {
    const cwd = await workspaceWithSessions("session-title-persist");
    const aiTitleService = {
      async generateTitle() { return "AI 自动标题"; },
    };
    const server = Fastify({ logger: false });
    registerSessionReadRoutes(server, sessionRepository, nodeSessionService);
    registerNodeSessionRoutes(server, nodeSessionService, sessionRepository, aiTitleService as never);
    const response = await server.inject({ method: "POST", url: `/api/sessions/session-title-persist/title?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, title: "AI 自动标题" });
    // No client PUT involved: the title is already on disk and in the list.
    const raw = await readFile(join(cwd, ".pi-science", "session-titles.jsonl"), "utf8");
    expect(raw).toContain('"session_id":"session-title-persist"');
    expect(raw).toContain("AI 自动标题");
    const listed = await server.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}` });
    expect((listed.json() as Array<{ id: string; name: string | null }>).find((s) => s.id === "session-title-persist")?.name).toBe("AI 自动标题");
    await server.close();
  });

  it("does not persist when AI title generation returns null", async () => {
    const cwd = await workspaceWithSessions("session-title-null");
    const aiTitleService = { async generateTitle() { return null; } };
    const server = Fastify({ logger: false });
    registerNodeSessionRoutes(server, nodeSessionService, sessionRepository, aiTitleService as never);
    const response = await server.inject({ method: "POST", url: `/api/sessions/session-title-null/title?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, title: null });
    await expect(readFile(join(cwd, ".pi-science", "session-titles.jsonl"), "utf8")).rejects.toThrow();
    await server.close();
  });

  it("accepts a title PUT for a live session before its file exists on disk", async () => {
    const cwd = await workspaceWithSessions();
    const server = app();
    const created = await server.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    expect(created.statusCode).toBe(200);
    const sessionId = created.json().id as string;
    expect(nodeSessionService.liveSessions(cwd).some((session) => session.id === sessionId)).toBe(true);
    const put = await server.inject({ method: "PUT", url: `/api/sessions/${sessionId}/title?cwd=${encodeURIComponent(cwd)}`, payload: { title: "live session title" } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, title: "live session title" });
    await server.close();
  });

  it("rejects a title request for an invalid workspace with 403", async () => {
    const aiTitleService = {
      async generateTitle() {
        throw new Error("must not be reached");
      },
    };
    const server = Fastify({ logger: false });
    registerNodeSessionRoutes(server, nodeSessionService, sessionRepository, aiTitleService as never);
    const response = await server.inject({ method: "POST", url: "/api/sessions/session-title/title?cwd=/definitely/not/a/workspace" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, code: "workspace_invalid" });
    await server.close();
  });

  it("returns 404 when the title service is not configured", async () => {
    const cwd = await workspaceWithSessions("session-title");
    const server = app();
    const response = await server.inject({ method: "POST", url: `/api/sessions/session-title/title?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it("maps stable Pi Orbit failures to actionable HTTP responses", async () => {
    for (const [code, statusCode] of [
      ["project_trust_required", 409],
      ["runtime_workspace_mismatch", 409],
      ["session_in_use", 409],
      ["runtime_busy", 409],
      ["runtime_initialization_failed", 422],
      ["runtime_capacity_exceeded", 429],
      ["agent_turn_capacity_exceeded", 429],
      ["runtime_evicted", 410],
      ["runtime_not_found", 404],
    ] as const) {
      const service = {
        async create() { return { error: "Pi Orbit failure", code, diagnostics: [{ type: "error", message: "detail" }] }; },
      } as unknown as NodeSessionService;
      const server = Fastify({ logger: false });
      registerNodeSessionRoutes(server, service, sessionRepository);
      const response = await server.inject({ method: "POST", url: "/api/sessions", payload: { cwd: "/tmp/workspace" } });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ ok: false, code, diagnostics: [{ message: "detail" }] });
      await server.close();
    }
  });

  it("lists an active blank session and switches repeatedly between persisted sessions", async () => {
    const cwd = await workspaceWithSessions("session-a", "session-b");
    const server = app();
    const created = await server.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    expect(created.statusCode).toBe(200);
    const blankId = created.json().id as string;
    const secondCreated = await server.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    expect(secondCreated.statusCode).toBe(200);
    const secondBlankId = secondCreated.json().id as string;

    const listed = await server.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}` });
    expect(listed.json().map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([blankId, secondBlankId, "session-a", "session-b"]));

    for (const id of ["session-a", "session-b", "session-a"]) {
      const state = await server.inject({ method: "GET", url: `/api/sessions/${id}/state?cwd=${encodeURIComponent(cwd)}` });
      expect(state.statusCode).toBe(200);
      expect(state.json()).toMatchObject({ ok: true, id });
    }
    await server.close();
  });

  it("does not re-add a hidden AI-title session merely because it was resumed", async () => {
    const cwd = await workspaceWithSessions();
    const sessionId = "legacy-title-runtime";
    await writeFile(join(cwd, ".pi-science", "sessions", `${sessionId}.jsonl`), [
      JSON.stringify({ type: "session", id: sessionId, cwd, timestamp: "2026-07-23T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "title-prompt",
        message: {
          role: "user",
          content: [{ type: "text", text: `${AI_TITLE_PROMPT_INSTRUCTION}\n\nConversation:\nuser: hidden` }],
        },
      }),
    ].join("\n") + "\n", "utf8");
    const server = app();

    const resumed = await server.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/resume?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(resumed.statusCode).toBe(200);
    expect(nodeSessionService.liveSessions(cwd).map((session) => session.id)).toContain(sessionId);

    const listed = await server.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}` });
    expect((listed.json() as Array<{ id: string }>).some((session) => session.id === sessionId)).toBe(false);
    await server.close();
  });

  it("serves older history pages from an opaque cursor and rejects invalid pagination", async () => {
    const cwd = await workspaceWithSessions("session-page");
    await writeFile(join(cwd, ".pi-science", "sessions", "session-page.jsonl"), [
      JSON.stringify({ type: "session", id: "session-page", cwd, timestamp: "2026-07-23T00:00:00.000Z" }),
      ...["m1", "m2", "m3"].map((id) => JSON.stringify({
        type: "message",
        id,
        message: { role: "user", content: [{ type: "text", text: id }] },
      })),
    ].join("\n") + "\n", "utf8");
    const server = app();

    const first = await server.inject({ method: "GET", url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&limit=2` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      messages: [{ id: "m2" }, { id: "m3" }],
      has_more: true,
      next_cursor: expect.any(String),
      snapshot_version: expect.any(String),
    });

    const cursor = first.json().next_cursor as string;
    const second = await server.inject({
      method: "GET",
      url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&before=${encodeURIComponent(cursor)}&limit=2`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ messages: [{ id: "m1" }], has_more: false, next_cursor: null });

    const index = await server.inject({ method: "GET", url: `/api/sessions/session-page/messages/index?cwd=${encodeURIComponent(cwd)}` });
    expect(index.statusCode).toBe(200);
    expect(index.json()).toMatchObject({
      messages: [
        { id: "m1", text: "m1", before: expect.any(String) },
        { id: "m2", text: "m2", before: expect.any(String) },
        { id: "m3", text: "m3", before: expect.any(String) },
      ],
      snapshot_version: expect.any(String),
    });

    expect((await server.inject({ method: "GET", url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&limit=0` })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&before=not-a-cursor` })).statusCode).toBe(400);
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
    expect(createWhileBusy.statusCode).toBe(200);
    expect(createWhileBusy.json().id).toEqual(expect.any(String));
    await server.inject({ method: "POST", url: `/api/sessions/${forked.json().id}/abort?${query}` });

    const deleted = await server.inject({ method: "DELETE", url: `/api/sessions/session-b?${query}` });
    expect(deleted.statusCode).toBe(200);
    await expect(access(join(cwd, ".pi-science", "sessions", "session-b.jsonl"))).rejects.toThrow();
    await expect(readFile(join(cwd, ".pi-science", "sessions", "session-a.jsonl"), "utf8")).resolves.toContain('"id":"session-a"');
    // Deleting a session that never existed is idempotent success (ghost).
    const ghost = await server.inject({ method: "DELETE", url: `/api/sessions/ghost-no-such?${query}` });
    expect(ghost.statusCode).toBe(200);
    expect(ghost.json()).toMatchObject({ ok: true });

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
      // Spawn Pi first so the test verifies that runtime errors and
      // cancellations are properly propagated.
      await server.inject({ method: "POST", url: `/api/sessions/session-${mode}/resume?cwd=${encodeURIComponent(cwd)}` });
      const response = await server.inject({ method: "GET", url: `/api/sessions/session-${mode}/commands?cwd=${encodeURIComponent(cwd)}` });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ ok: false, code });
      await server.close();
      await nodeSessionService.shutdownAll();
    }
  });

  it("returns an empty optional command list for a stale session id", async () => {
    const cwd = await workspaceWithSessions("session-current");
    const server = app();
    const response = await server.inject({
      method: "GET",
      url: `/api/sessions/session-stale/commands?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commands: [] });
    await server.close();
  });

  it("persists session titles and surfaces them in the session list", async () => {
    const cwd = await workspaceWithSessions("session-a", "session-b");
    const server = app();
    const query = `cwd=${encodeURIComponent(cwd)}`;

    // No titles initially: the list has no names.
    const before = await server.inject({ method: "GET", url: `/api/sessions?${query}` });
    const beforeList = before.json() as Array<{ id: string; name: string | null }>;
    expect(beforeList.find((s) => s.id === "session-a")?.name ?? null).toBeNull();

    // Set a title for session-a.
    const put = await server.inject({
      method: "PUT",
      url: `/api/sessions/session-a/title?${query}`,
      payload: { title: "蛋白质工程分析" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ok: true, title: "蛋白质工程分析" });

    // The list now carries the persisted name.
    const after = await server.inject({ method: "GET", url: `/api/sessions?${query}` });
    const afterList = after.json() as Array<{ id: string; name: string | null }>;
    expect(afterList.find((s) => s.id === "session-a")?.name).toBe("蛋白质工程分析");
    expect(afterList.find((s) => s.id === "session-b")?.name ?? null).toBeNull();

    // Upsert overwrites.
    await server.inject({
      method: "PUT",
      url: `/api/sessions/session-a/title?${query}`,
      payload: { title: "新标题" },
    });
    const updated = await server.inject({ method: "GET", url: `/api/sessions?${query}` });
    expect((updated.json() as Array<{ id: string; name: string | null }>).find((s) => s.id === "session-a")?.name).toBe("新标题");
    await server.close();
  });

  it("validates title payloads and workspace ownership", async () => {
    const cwd = await workspaceWithSessions("session-a");
    const server = app();
    const query = `cwd=${encodeURIComponent(cwd)}`;

    const empty = await server.inject({ method: "PUT", url: `/api/sessions/session-a/title?${query}`, payload: { title: "   " } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: "invalid_request" });

    const tooLong = await server.inject({ method: "PUT", url: `/api/sessions/session-a/title?${query}`, payload: { title: "x".repeat(101) } });
    expect(tooLong.statusCode).toBe(400);

    const missing = await server.inject({ method: "PUT", url: `/api/sessions/ghost-no-such/title?${query}`, payload: { title: "ok" } });
    expect(missing.statusCode).toBe(404);

    const badWorkspace = await server.inject({ method: "PUT", url: `/api/sessions/session-a/title?cwd=${encodeURIComponent("/no/such/workspace")}`, payload: { title: "ok" } });
    expect(badWorkspace.statusCode).toBe(403);
    await server.close();
  });

  it("clears the persisted title when the session is deleted", async () => {
    const cwd = await workspaceWithSessions("session-a");
    const server = app();
    const query = `cwd=${encodeURIComponent(cwd)}`;
    await server.inject({ method: "PUT", url: `/api/sessions/session-a/title?${query}`, payload: { title: "gone soon" } });

    const deleted = await server.inject({ method: "DELETE", url: `/api/sessions/session-a?${query}` });
    expect(deleted.statusCode).toBe(200);

    const list = await server.inject({ method: "GET", url: `/api/sessions?${query}` });
    const sessions = list.json() as Array<{ id: string; name: string | null }>;
    expect(sessions.some((s) => s.id === "session-a" && s.name === "gone soon")).toBe(false);

    // The title file no longer references the deleted session.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(cwd, ".pi-science", "session-titles.jsonl"), "utf8").catch(() => "");
    expect(raw.includes("gone soon")).toBe(false);
    await server.close();
  });

  it("cleans up navigation state when a session is deleted", async () => {
    const cwd = await workspaceWithSessions("session-nav");
    const navigation = new ConversationNavigationRepository(sessionRepository);
    await navigation.createBookmark(cwd, { session_id: "session-nav", message_id: "session-nav-user" });
    await navigation.updateReadState(cwd, "session-nav", { at_bottom: true, mark_seen: true });
    const server = Fastify({ logger: false });
    registerNodeSessionRoutes(server, nodeSessionService, sessionRepository, undefined, undefined, navigation);

    const deleted = await server.inject({ method: "DELETE", url: `/api/sessions/session-nav?cwd=${encodeURIComponent(cwd)}` });
    expect(deleted.statusCode).toBe(200);
    expect((await navigation.bookmarks(cwd, "session-nav")).bookmarks).toHaveLength(0);
    expect(await navigation.readState(cwd, "session-nav")).toBeNull();
    await server.close();
  });

  it("still deletes the session when navigation cleanup fails (best-effort)", async () => {
    const cwd = await workspaceWithSessions("session-nav-fail");
    const navigation = {
      cleanupSession: vi.fn(async () => { throw new Error("navigation state corrupt"); }),
    } as unknown as ConversationNavigationRepository;
    const server = Fastify({ logger: false });
    registerNodeSessionRoutes(server, nodeSessionService, sessionRepository, undefined, undefined, navigation);

    const deleted = await server.inject({ method: "DELETE", url: `/api/sessions/session-nav-fail?cwd=${encodeURIComponent(cwd)}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true });
    await expect(access(join(cwd, ".pi-science", "sessions", "session-nav-fail.jsonl"))).rejects.toThrow();
    expect(navigation.cleanupSession).toHaveBeenCalledWith(cwd, "session-nav-fail");
    await server.close();
  });
});
