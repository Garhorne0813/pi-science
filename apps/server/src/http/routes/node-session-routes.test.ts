import Fastify from "fastify";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodeSessionRoutes } from "./node-session-routes.js";
import { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { registerSessionReadRoutes } from "./session-routes.js";
import { sessionRepository } from "../../runtime/node/session-repository.js";
import { AI_TITLE_PROMPT_INSTRUCTION } from "../../runtime/title/title-prompt.js";

const cleanup: string[] = [];
const nodeSessionService = new NodeSessionService(undefined, undefined, {
  async environment(_cwd: string, inherited: NodeJS.ProcessEnv = process.env) { return { ...inherited }; },
});
const original = { home: process.env.PI_SCIENCE_HOME };

beforeEach(async () => {
  const root = join(tmpdir(), `pi-science-node-routes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  await mkdir(root, { recursive: true });
  process.env.PI_SCIENCE_HOME = join(root, "data");
  await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
  await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), JSON.stringify({ model: "openai/gpt-4.1-mini", thinking: "off" }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await nodeSessionService.shutdownAll();
  for (const [key, value] of Object.entries(original)) {
    const environmentKey = key === "home" ? "PI_SCIENCE_HOME" : key;
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
      JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-07-23T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: `${id}-user`, parentId: null, timestamp: "2026-07-23T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `<hello ${id}>` }] } }),
      JSON.stringify({ type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp: "2026-07-23T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: `answer ${id}` }] } }),
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
  it("accepts client message IDs idempotently and rejects reuse with different content", async () => {
    const cwd = await workspaceWithSessions("prompt-idempotency");
    const command = vi.fn(async () => ({ success: true }));
    const fakeService = {
      command,
      liveSessions: () => [],
    } as unknown as NodeSessionService;
    const server = Fastify({ logger: false });
    registerNodeSessionRoutes(server, fakeService, sessionRepository);
    const id = "8fd824aa-51d3-4f63-839c-09e021b7970b";
    const url = `/api/sessions/prompt-idempotency/prompt?cwd=${encodeURIComponent(cwd)}`;

    const first = await server.inject({ method: "POST", url, payload: { message: "status", client_message_id: id } });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ ok: true, status: "accepted", client_message_id: id });
    const duplicate = await server.inject({ method: "POST", url, payload: { message: "status", client_message_id: id } });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({ ok: true, status: "accepted", client_message_id: id });
    expect(command).toHaveBeenCalledTimes(1);

    const conflict = await server.inject({ method: "POST", url, payload: { message: "other text", client_message_id: id } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "client_message_id_conflict" });
    const statusResponse = await server.inject({ method: "GET", url: `/api/sessions/prompt-idempotency/prompt-requests/${id}?cwd=${encodeURIComponent(cwd)}` });
    expect(statusResponse.json()).toMatchObject({ status: "accepted", client_message_id: id });
    await server.close();
  });

  it("serializes distinct prompt IDs for a session and blocks the next send until association resolves", async () => {
    const cwd = await workspaceWithSessions("prompt-serialized");
    let releaseCommand!: () => void;
    const command = vi.fn(() => new Promise<{ success: boolean }>((resolve) => {
      releaseCommand = () => resolve({ success: true });
    }));
    const fakeService = {
      command,
      liveSessions: () => [],
    } as unknown as NodeSessionService;
    const server = Fastify({ logger: false });
    registerNodeSessionRoutes(server, fakeService, sessionRepository);
    const firstId = "8fd824aa-51d3-4f63-839c-09e021b7970b";
    const secondId = "91d824aa-51d3-4f63-839c-09e021b7970b";
    const url = `/api/sessions/prompt-serialized/prompt?cwd=${encodeURIComponent(cwd)}`;

    const first = server.inject({ method: "POST", url, payload: { message: "status", client_message_id: firstId } });
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    const second = server.inject({ method: "POST", url, payload: { message: "status", client_message_id: secondId } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(command).toHaveBeenCalledTimes(1);

    releaseCommand();
    expect((await first).statusCode).toBe(202);
    const blocked = await second;
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "prompt_request_in_flight", blocking_client_message_id: firstId });
    expect(command).toHaveBeenCalledTimes(1);
    await server.close();
  });

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
  }, 20_000);

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

  it("maps stable Core runtime failures to actionable HTTP responses", async () => {
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
        async create() { return { error: "Core runtime failure", code, diagnostics: [{ type: "error", message: "detail" }] }; },
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
  }, 20_000);

  it("serves whole-session stats for an idle session by folding its JSONL", async () => {
    const cwd = await workspaceWithSessions("session-a");
    await writeFile(join(cwd, ".pi-science", "sessions", "session-a.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-a", cwd, timestamp: "2026-07-23T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-07-23T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-23T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read" }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
      JSON.stringify({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-07-23T00:00:03.000Z", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "message", id: "a2", parentId: "r1", timestamp: "2026-07-23T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    ].join("\n") + "\n", "utf8");
    const server = app();

    const res = await server.inject({ method: "GET", url: `/api/sessions/session-a/stats?cwd=${encodeURIComponent(cwd)}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.stats).toMatchObject({
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 4,
      tokens: { input: 15, output: 5, cacheRead: 0, cacheWrite: 0, total: 20 },
    });

    const missing = await server.inject({ method: "GET", url: `/api/sessions/no-such/stats?cwd=${encodeURIComponent(cwd)}` });
    expect(missing.statusCode).toBe(404);
    await server.close();
  });

  it("does not re-add a hidden AI-title session merely because it was resumed", async () => {
    const cwd = await workspaceWithSessions();
    const sessionId = "legacy-title-runtime";
    await writeFile(join(cwd, ".pi-science", "sessions", `${sessionId}.jsonl`), [
      JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: "2026-07-23T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "title-prompt", parentId: null, timestamp: "2026-07-23T00:00:01.000Z",
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
  }, 20_000);

  it("serves older history pages from an opaque cursor and rejects invalid pagination", async () => {
    const cwd = await workspaceWithSessions("session-page");
    await writeFile(join(cwd, ".pi-science", "sessions", "session-page.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-page", cwd, timestamp: "2026-07-23T00:00:00.000Z" }),
      ...["m1", "m2", "m3"].map((id, index) => JSON.stringify({
        type: "message", id, parentId: index ? `m${index}` : null, timestamp: `2026-07-23T00:00:0${index + 1}.000Z`,
        message: { role: "user", content: id },
      })),
    ].join("\n") + "\n", "utf8");
    const server = app();

    const [first, index] = await Promise.all([
      server.inject({ method: "GET", url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&limit=2` }),
      server.inject({ method: "GET", url: `/api/sessions/session-page/messages/index?cwd=${encodeURIComponent(cwd)}` }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      messages: [{ content: [{ type: "text", text: "m2" }] }, { content: [{ type: "text", text: "m3" }] }],
      has_more: true,
      next_cursor: expect.any(String),
      snapshot_version: expect.any(String),
    });

    const { AgentSessionRepository } = await import("../../runtime/agent/agent-session-repository.js");
    const entryIds = await new AgentSessionRepository().migrationEntryIds(cwd, "session-page");
    expect(first.json().messages.map((message: { id: string }) => message.id)).toEqual([entryIds.m2, entryIds.m3]);
    expect(nodeSessionService.processCount).toBe(0);
    const cursor = first.json().next_cursor as string;
    const second = await server.inject({
      method: "GET",
      url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&before=${encodeURIComponent(cursor)}&limit=2`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ messages: [{ id: entryIds.m1 }], has_more: false, next_cursor: null });

    expect(index.statusCode).toBe(200);
    expect(index.json()).toMatchObject({
      messages: [
        { id: entryIds.m1, text: "m1", before: expect.any(String) },
        { id: entryIds.m2, text: "m2", before: expect.any(String) },
        { id: entryIds.m3, text: "m3", before: expect.any(String) },
      ],
      snapshot_version: expect.any(String),
    });

    expect((await server.inject({ method: "GET", url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&limit=0` })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `/api/sessions/session-page/messages?cwd=${encodeURIComponent(cwd)}&before=not-a-cursor` })).statusCode).toBe(400);
    await server.close();
  });

  it("forwards persisted trajectory metadata in history messages", async () => {
    const cwd = await workspaceWithSessions("session-metadata");
    await writeFile(join(cwd, ".pi-science", "sessions", "session-metadata.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "session-metadata", cwd, timestamp: "2026-09-14T00:00:00.000Z" }),
      JSON.stringify({
        type: "message", id: "a1", parentId: null, timestamp: "2026-09-14T00:00:00.000Z",
        message: {
          role: "assistant", content: [{ type: "text", text: "done" }], details: { rows: 3 },
          presentationRole: "final", turnId: "turn-1", runId: "run-1", itemId: "item-1",
          revision: 2, sequence: 7, classificationSource: "explicit",
        },
      }),
    ].join("\n") + "\n", "utf8");
    const server = app();
    const response = await server.inject({ method: "GET", url: `/api/sessions/session-metadata/messages?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0]).toMatchObject({
      details: { rows: 3 }, presentationRole: "final", turnId: "turn-1", runId: "run-1",
      itemId: "item-1", revision: 2, sequence: 7, classificationSource: "explicit",
    });
    await server.close();
  });

  it("paginates the session index without losing rows when timestamps tie", async () => {
    const ids = Array.from({ length: 35 }, (_, index) => `session-${String(index).padStart(2, "0")}`);
    const cwd = await workspaceWithSessions(...ids);
    const server = app();

    const first = await server.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}&limit=20` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    expect(first.json().sessions).toHaveLength(20);

    const second = await server.inject({
      method: "GET",
      url: `/api/sessions?cwd=${encodeURIComponent(cwd)}&limit=20&cursor=${encodeURIComponent(first.json().next_cursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ has_more: false, next_cursor: null });
    expect(second.json().sessions).toHaveLength(15);
    expect(new Set([...first.json().sessions, ...second.json().sessions].map((session: { id: string }) => session.id)).size).toBe(35);
    expect((await server.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}&limit=0` })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}&cursor=broken` })).statusCode).toBe(400);
    await server.close();
  });

  it("enforces busy status and owns fork, interaction, commands, model, export, and exact delete routes", async () => {
    const cwd = await workspaceWithSessions("session-a", "session-b");
    vi.spyOn(nodeSessionService, "configure").mockResolvedValue({ success: true, model: "openrouter/openai/gpt-5.1" });
    vi.spyOn(nodeSessionService, "command").mockImplementation(async (_id, _cwd, type) => type === "compact" ? { success: false, code: "busy" } : type === "get_commands" ? { success: true, data: { commands: [{ name: "review", source: "skill" }] } } : { success: true });
    vi.spyOn(nodeSessionService, "notify").mockResolvedValue({ success: true });
    vi.spyOn(nodeSessionService, "fork").mockResolvedValue({ success: true, sessionId: "forked" });
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
    // Migration retains the original; deletion hides the imported session durably.
    expect((await sessionRepository.list(cwd)).some((row) => row.id === "session-b")).toBe(false);
    await expect(readFile(join(cwd, ".pi-science", "sessions", "session-a.jsonl"), "utf8")).resolves.toContain('"id":"session-a"');
    // Deleting a session that never existed is idempotent success (ghost).
    const ghost = await server.inject({ method: "DELETE", url: `/api/sessions/ghost-no-such?${query}` });
    expect(ghost.statusCode).toBe(200);
    expect(ghost.json()).toMatchObject({ ok: true });

    expect(nodeSessionService.configure).toHaveBeenCalledWith("session-a", cwd, "openrouter/openai/gpt-5.1", "high");
    expect(nodeSessionService.notify).toHaveBeenCalledWith("session-a", cwd, "extension_ui_response", { id: "question-1", confirmed: true });
    expect(nodeSessionService.fork).toHaveBeenCalledWith("session-a", cwd, "entry-7");
    await server.close();
  }, 20_000);

  it("returns runtime command errors and cancellations instead of disguising them as an empty command list", async () => {
    for (const [mode, statusCode, code] of [["commands-error", 502, "commands_failed"], ["commands-cancelled", 409, "cancelled"]] as const) {
      vi.spyOn(nodeSessionService, "command").mockResolvedValue(mode === "commands-error" ? { success: false, code: "commands_failed", error: "unavailable" } : { success: false, code: "cancelled", error: "cancelled" });
      const cwd = await workspaceWithSessions(`session-${mode}`);
      const server = app();
      const response = await server.inject({ method: "GET", url: `/api/sessions/session-${mode}/commands?cwd=${encodeURIComponent(cwd)}` });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ ok: false, code });
      await server.close();
      vi.restoreAllMocks();
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
});
