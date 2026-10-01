import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { NodeSessionService } from "../node/node-session-service.js";
import { SessionRepository } from "../node/session-repository.js";
import { PiManager } from "../pi/pi-manager.js";
import Fastify from "fastify";
import { registerNodeSessionRoutes } from "../../http/routes/node-session-routes.js";
import { registerSessionReadRoutes } from "../../http/routes/session-routes.js";

const roots: string[] = [];
const services: NodeSessionService[] = [];
const previousMode = process.env.PI_SCIENCE_AGENT_RUNTIME;
const previousHome = process.env.PI_SCIENCE_HOME;

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.shutdownAll()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (previousMode === undefined) delete process.env.PI_SCIENCE_AGENT_RUNTIME;
  else process.env.PI_SCIENCE_AGENT_RUNTIME = previousMode;
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
});

function service(): NodeSessionService {
  const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
  const instance = new NodeSessionService(hub, new PiManager(), new SessionRepository(), { environment: async () => ({}) });
  services.push(instance);
  return instance;
}

describe("agent-core main service integration", () => {
  it("creates, lists, resumes, and reads a v4 session through the existing service", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-core-integration-")));
    roots.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    process.env.PI_SCIENCE_AGENT_RUNTIME = "agent-core";
    const first = service();
    const created = await first.create({ cwd, config: { model: "openai/gpt-4.1-mini", thinking: "low", skills: [], extensions: [] } });
    expect(created).toMatchObject({ id: expect.any(String), cwd });
    if (!("id" in created)) throw new Error(String(created.error));
    expect((await new SessionRepository().list(cwd)).map((item) => item.id)).toContain(created.id);
    expect(await first.state(created.id, cwd)).toMatchObject({ id: created.id, model: "openai/gpt-4.1-mini", thinking: "off" });
    const requestId = "0379079d-63a2-428d-aec1-8ea88e46441f";
    expect(await first.command(created.id, cwd, "prompt", { message: "hello", client_message_id: requestId })).toMatchObject({ success: true });
    const repository = new SessionRepository();
    let messages = await repository.messages(cwd, created.id);
    for (let i = 0; i < 30 && !messages.some((item) => item.client_message_id === requestId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      messages = await repository.messages(cwd, created.id);
    }
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", client_message_id: requestId })]));
    const page = await repository.messagesPage(cwd, created.id);
    expect(page.messages.some((item) => item.client_message_id === requestId)).toBe(true);
    const index = await repository.userMessageIndex(cwd, created.id);
    expect(index.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "hello", before: expect.any(String) })]));
    expect((await repository.messagesPage(cwd, created.id, { before: index.messages[0]!.before, limit: 1 })).messages)
      .toEqual([expect.objectContaining({ client_message_id: requestId })]);
    await first.shutdownAll();
    const second = service();
    expect(await second.resume(created.id, cwd)).toMatchObject({ success: true });
    expect(await second.state(created.id, cwd)).toMatchObject({ id: created.id });
  }, 20_000);

  it("imports a Pi v3 session on resume and keeps the original transcript", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-core-legacy-")));
    roots.push(cwd);
    const legacyRoot = join(cwd, ".pi-science", "sessions");
    await mkdir(legacyRoot, { recursive: true });
    process.env.PI_SCIENCE_HOME = join(cwd, "config");
    await mkdir(process.env.PI_SCIENCE_HOME, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME, "config.json"), JSON.stringify({ model: "openai/gpt-4.1-mini", thinking: "low" }));
    const id = "legacy-session";
    const original = [
      { type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "prior question" }], timestamp: Date.parse("2026-01-01T00:00:01.000Z") } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    const source = join(legacyRoot, "legacy.jsonl");
    await writeFile(source, original);
    process.env.PI_SCIENCE_AGENT_RUNTIME = "agent-core";
    const instance = service();
    expect(await instance.resume(id, cwd)).toMatchObject({ success: true });
    const repository = new SessionRepository();
    expect((await repository.list(cwd)).filter((row) => row.id === id)).toHaveLength(1);
    expect(await repository.messages(cwd, id)).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: [{ type: "text", text: "prior question" }] })]));
    expect(await instance.command(id, cwd, "prompt", { message: "continue" })).toMatchObject({ success: true });
    let messages = await repository.messages(cwd, id);
    for (let i = 0; i < 30 && !messages.some((row) => row.content.some((part) => part.text === "continue")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      messages = await repository.messages(cwd, id);
    }
    expect(messages.map((row) => row.content[0]?.text)).toEqual(expect.arrayContaining(["prior question", "continue"]));
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(source, "utf8"))).toBe(original);
  }, 20_000);

  it("restarts an idle worker after configuration reload and resumes the same session", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-core-reload-")));
    roots.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    process.env.PI_SCIENCE_AGENT_RUNTIME = "agent-core";
    const instance = service();
    const created = await instance.create({ cwd, config: { model: "openai/gpt-4.1-mini", thinking: "low", skills: [], extensions: [] } });
    if (!("id" in created)) throw new Error(String(created.error));
    expect(instance.liveSession(cwd)).toMatchObject({ id: created.id });
    expect(await instance.reloadConfiguration()).toEqual([]);
    expect(instance.liveSession(cwd)).toBeNull();
    expect(await instance.resume(created.id, cwd)).toMatchObject({ success: true });
    expect(instance.liveSession(cwd)).toMatchObject({ id: created.id });
    expect(await instance.state(created.id, cwd)).toMatchObject({ id: created.id });
  }, 20_000);

  it("serves existing HTTP create, prompt, history, and idempotency routes", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-core-http-")));
    roots.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    process.env.PI_SCIENCE_AGENT_RUNTIME = "agent-core";
    const sessions = service();
    const repository = new SessionRepository();
    const app = Fastify({ logger: false });
    registerSessionReadRoutes(app, repository, sessions);
    registerNodeSessionRoutes(app, sessions, repository);
    try {
      const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {
        cwd, config: { model: "openai/gpt-4.1-mini", thinking: "low", skills: [], extensions: [] },
      } });
      expect(created.statusCode).toBe(200);
      const id = created.json().id as string;
      const requestId = "b2199baa-1385-4df6-8ba5-1307e4ae686e";
      const url = `/api/sessions/${id}/prompt?cwd=${encodeURIComponent(cwd)}`;
      const first = await app.inject({ method: "POST", url, payload: { message: "hello", client_message_id: requestId } });
      expect(first.statusCode).toBe(202);
      const repeated = await app.inject({ method: "POST", url, payload: { message: "hello", client_message_id: requestId } });
      expect(repeated.statusCode).toBe(202);
      const list = await app.inject({ method: "GET", url: `/api/sessions?cwd=${encodeURIComponent(cwd)}` });
      expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
      const history = await app.inject({ method: "GET", url: `/api/sessions/${id}/messages?cwd=${encodeURIComponent(cwd)}` });
      expect(history.statusCode).toBe(200);
      expect(history.json().messages).toEqual(expect.arrayContaining([expect.objectContaining({ client_message_id: requestId })]));
    } finally { await app.close(); }
  }, 20_000);
});
