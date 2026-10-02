import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNodeSessionRoutes } from "../../http/routes/node-session-routes.js";
import { workspaceFile } from "../../storage/persistence.js";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { NodeSessionService } from "../node/node-session-service.js";
import { SessionRepository } from "../node/session-repository.js";
import { PiManager } from "../pi/pi-manager.js";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { AgentRuntimeTimeoutError } from "./agent-runtime-errors.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";

const roots: string[] = [];
const services: NodeSessionService[] = [];
const initialConfig = { model: "openai/gpt-4.1-mini", thinking: "low", skills: [], extensions: [] };

async function workspace() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-core-faults-")));
  roots.push(cwd);
  const home = join(cwd, "home");
  await mkdir(home);
  await mkdir(join(cwd, ".pi-science"));
  await writeFile(join(home, "config.json"), JSON.stringify(initialConfig));
  vi.stubEnv("PI_SCIENCE_HOME", home);
  vi.stubEnv("PI_SCIENCE_AGENT_RUNTIME", "agent-core");
  return cwd;
}

function service() {
  const events: Array<Record<string, unknown>> = [];
  const hub = new ConversationEventHub({ append: async (_cwd, _id, event) => { events.push(JSON.parse(event.data) as Record<string, unknown>); },
    readAfter: async () => [] });
  const instance = new NodeSessionService(hub, new PiManager(), new SessionRepository(), { environment: async () => ({}) });
  services.push(instance);
  return { instance, events };
}

async function legacyWorkspace() {
  vi.stubEnv("PI_SCIENCE_AGENT_CORE_MIGRATE_LEGACY", "1");
  const cwd = await workspace();
  const id = "legacy-delete-regression";
  const source = workspaceFile(cwd, "sessions/legacy.jsonl");
  const original = [
    { type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "prior question" }], timestamp: 1767225601000 } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, original);
  return { cwd, id, source, original };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(services.splice(0).map((instance) => instance.shutdownAll()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
  vi.unstubAllEnvs();
});

describe("agent-core fault recovery", () => {
  it("does not admit the same prompt again after losing its acknowledgement and restarting", async () => {
    const cwd = await workspace();
    const { instance, events } = service();
    const created = await instance.create({ cwd, config: initialConfig });
    if (!("id" in created)) throw new Error(String(created.error));
    const core = (instance as unknown as { agentCore: AgentCoreSessionService }).agentCore;
    const runtime = core.liveRuntime(cwd)!;
    const send = runtime.sendCommand.bind(runtime);
    let admissions = 0;
    vi.spyOn(runtime, "sendCommand").mockImplementation(async (type, params) => {
      const result = await send(type, params);
      if (type === "prompt") { admissions += 1; throw new AgentRuntimeTimeoutError("prompt", 30_000); }
      return result;
    });
    const app = Fastify();
    const repository = new SessionRepository();
    registerNodeSessionRoutes(app, instance, repository);
    const requestId = "8d3e4e4d-0b7c-4f0d-b6b6-8791b098a164";
    const url = `/api/sessions/${created.id}/prompt?cwd=${encodeURIComponent(cwd)}`;
    try {
      const first = await app.inject({ method: "POST", url, payload: { message: "one durable prompt", client_message_id: requestId } });
      expect(first.statusCode).toBe(504);
      expect(first.json()).toMatchObject({ code: "timeout", status: "indeterminate" });
      const retry = await app.inject({ method: "POST", url, payload: { message: "one durable prompt", client_message_id: requestId } });
      expect(retry.statusCode).toBe(202);
      expect(retry.json()).toMatchObject({ status: "persisted" });
      expect(admissions).toBe(1);
      await vi.waitFor(() => expect(events.some((event) => event.type === "session.idle")).toBe(true), { timeout: 5_000 });
      await instance.shutdownAll();
    } finally { await app.close(); }

    const restarted = service().instance;
    const secondApp = Fastify();
    registerNodeSessionRoutes(secondApp, restarted, new SessionRepository());
    try {
      const retry = await secondApp.inject({ method: "POST", url, payload: { message: "one durable prompt", client_message_id: requestId } });
      expect(retry.json()).toMatchObject({ status: "persisted" });
      expect(restarted.processCount).toBe(0); // Durable reconciliation needs no new admission.
      expect((await repository.messages(cwd, created.id)).filter((message) => message.client_message_id === requestId)).toHaveLength(1);
    } finally { await secondApp.close(); }
  }, 20_000);

  it("uses durable configuration after concurrent changes and ignores stale sidecar model values", async () => {
    const cwd = await workspace();
    const first = service().instance;
    const created = await first.create({ cwd, config: initialConfig });
    if (!("id" in created)) throw new Error(String(created.error));
    const committed: Array<{ model: unknown; thinking: unknown }> = [];
    const requests = [
      first.configure(created.id, cwd, "openai/gpt-5", "medium"),
      first.configure(created.id, cwd, "openai/not-a-real-model", "high"),
      first.configure(created.id, cwd, "openai/gpt-5-mini", "high"),
    ];
    const results = await Promise.all(requests.map((request) => request.then((result) => {
      if (result.success) committed.push({ model: result.model, thinking: result.thinking });
      return result;
    })));
    expect(results).toMatchObject([{ success: true }, { success: false, code: "invalid_model" }, { success: true }]);
    const last = committed.at(-1)!;
    const path = workspaceFile(cwd, `agent-session-config/${createHash("sha256").update(created.id).digest("hex")}.json`);
    await writeFile(path, JSON.stringify({ model: "openai/not-a-real-model", thinking: "off", skills: [] }));
    await first.shutdownAll();
    const second = service().instance;
    expect(await second.state(created.id, cwd)).toMatchObject(last);
    expect(second.processCount).toBe(0);
    expect(await second.resume(created.id, cwd)).toMatchObject({ success: true });
    expect(await second.state(created.id, cwd)).toMatchObject(last);
  }, 20_000);

  it("keeps migrated sessions deleted after list, restart, reopen, and another delete", async () => {
    const { cwd, id, source, original } = await legacyWorkspace();
    const first = service().instance;
    expect(await first.resume(id, cwd)).toMatchObject({ success: true });
    const registry = new AgentSessionRegistry();
    expect(await registry.get(cwd, id)).toMatchObject({ backend: "agent-core", state: "active", source, migration: "copied" });
    expect(await first.delete(id, cwd)).toMatchObject({ success: true });
    expect(await readFile(source, "utf8")).toBe(original);
    const repository = new SessionRepository();
    expect((await repository.list(cwd)).map((row) => row.id)).not.toContain(id);
    expect(await repository.findPath(cwd, id)).toBeNull();
    expect(await repository.messages(cwd, id)).toEqual([]);
    expect(await repository.messagesPage(cwd, id)).toMatchObject({ messages: [] });
    await first.shutdownAll();
    vi.stubEnv("PI_SCIENCE_AGENT_RUNTIME", "orbit");
    const second = service().instance;
    expect(await second.resume(id, cwd)).toMatchObject({ success: false, code: "not_found" });
    expect(await second.delete(id, cwd)).toMatchObject({ success: true });
    expect((await new SessionRepository().list(cwd)).map((row) => row.id)).not.toContain(id);
    expect(await registry.get(cwd, id)).toMatchObject({ state: "deleted" });
  }, 20_000);

  it("persists deletion before failed file cleanup and lets a restarted service finish cleanup", async () => {
    const { cwd, id, source, original } = await legacyWorkspace();
    const first = service().instance;
    expect(await first.resume(id, cwd)).toMatchObject({ success: true });
    await first.shutdownAll();
    const repository = new SessionRepository();
    const path = (await repository.findPath(cwd, id))!;
    await rm(path);
    await mkdir(path); // Unlinking a directory deterministically fails on all supported platforms.
    expect(await first.delete(id, cwd)).toMatchObject({ success: false, code: "delete_failed" });
    expect((await new SessionRepository().list(cwd)).map((row) => row.id)).not.toContain(id);
    expect(await new SessionRepository().findPath(cwd, id)).toBeNull();
    expect(await readFile(source, "utf8")).toBe(original);
    const second = service().instance;
    expect(await second.resume(id, cwd)).toMatchObject({ success: false, code: "not_found" });
    await rm(path, { recursive: true });
    expect(await second.delete(id, cwd)).toMatchObject({ success: true });
    expect((await new SessionRepository().list(cwd)).map((row) => row.id)).not.toContain(id);
  }, 20_000);
});
