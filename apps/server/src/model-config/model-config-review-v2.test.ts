import { modelResourceStateSchema } from "@pi-science/contracts";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism, cpus, freemem, tmpdir, totalmem } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConfigMigration } from "./model-config-migration.js";
import { ModelConfigService } from "./model-config-service.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";
import { buildApp } from "../app/app.js";
import { createServerModules } from "../app/server-modules.js";
import { loadConfig } from "../config/config.js";
import { AgentRuntimeManager } from "../runtime/agent/agent-runtime-manager.js";
import { CoreTitleRuntimeFactory } from "../runtime/title/ai-title-service.js";
import { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { openCoreRunner } from "../runtime/agent/core-runner-runtime.js";
let root: string;
let diagnosticPhase = "not-started";
let diagnosticTimer: ReturnType<typeof setInterval> | undefined;
let diagnosticTarget = false;
const diagnosticInFlight = new Set<string>();
function diagnostic(phase: string) {
  if (!diagnosticTarget || process.env.PI_SCIENCE_CI_DIAGNOSTIC !== "1") return;
  if (phase.endsWith(".begin")) diagnosticInFlight.add(phase.slice(0, -6));
  if (phase.endsWith(".end")) diagnosticInFlight.delete(phase.slice(0, -4));
  if (!phase.startsWith("heartbeat:")) diagnosticPhase = phase;
  try {
    const resources = process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, type) => {
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {});
    const systemCpu = cpus().reduce((sum, cpu) => {
      sum.idle += cpu.times.idle;
      sum.total += Object.values(cpu.times).reduce((total, value) => total + value, 0);
      return sum;
    }, { idle: 0, total: 0 });
    console.error("[ci-diagnostic]", JSON.stringify({ phase, inFlight: [...diagnosticInFlight], timestamp: Date.now(), monotonicMs: performance.now(), pid: process.pid, cpu: process.cpuUsage(), memory: process.memoryUsage(), resources, system: { freeMemory: freemem(), totalMemory: totalmem(), parallelism: availableParallelism(), cpu: systemCpu } }));
  } catch {
    // Diagnostics must not alter the test result.
  }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-review-v2-")); vi.stubEnv("PI_SCIENCE_HOME", root); });
afterEach(async () => {
  diagnostic("afterEach.begin");
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  diagnostic("afterEach.rm.begin");
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    diagnostic("afterEach.rm.end");
  } finally {
    diagnostic("afterEach.end");
    if (diagnosticTimer) clearInterval(diagnosticTimer);
    diagnosticTimer = undefined;
    diagnosticTarget = false;
    diagnosticInFlight.clear();
  }
});
async function sourceProvider(resources: ModelResourceService, id: string, url: string, model = "test") {
  diagnostic("provider.create.begin");
  await resources.createProvider({ id, name: id, adapter: "openai-compatible", auth_kind: "none", catalog_mode: "manual", enabled: true });
  diagnostic("provider.create.end");
  const accepted = new URL(url); accepted.username = ""; accepted.password = "";
  diagnostic("endpoint.create.begin");
  const endpoint = await resources.createEndpoint({ name: id, base_url: accepted.toString(), protocol: "openai", enabled: true, data_egress: "local" });
  diagnostic("endpoint.create.end");
  diagnostic("endpoint.update.begin");
  await resources.repository.update((state) => { state.endpoints.find((entry) => entry.id === endpoint.id)!.base_url = url; });
  diagnostic("endpoint.update.end");
  diagnostic("binding.create.begin");
  await resources.createBinding({ provider_id: id, endpoint_id: endpoint.id, enabled: true, priority: 100 });
  diagnostic("binding.create.end");
  diagnostic("model.update.begin");
  await resources.updateModel(id, model, { capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 8192, max_output_tokens: 4096 } });
  diagnostic("model.update.end");
}
async function bytes() { return Object.fromEntries(await Promise.all((await readdir(root)).filter((name) => name.endsWith(".json")).map(async (name) => [name, await readFile(join(root, name), "utf8")]))); }
it.each([
  ["query", "https://gateway.example/v1?profile=research", "test"],
  ["fragment", "https://gateway.example/v1#profile", "test"],
  ["userinfo", "https://user:password@gateway.example/v1", "test"],
  ["duplicate models", "http://127.0.0.1:9001/v1", "duplicate"],
])("classifies incompatible native %s before committing a mixed import", async (_case, url, model) => {
  const resources = new ModelResourceService();
  await sourceProvider(resources, "user-incompatible", url, "test");
  if (model === "duplicate") await resources.repository.update((state) => { state.models.push(structuredClone(state.models[0]!)); });
  expect(modelResourceStateSchema.safeParse(resources.repository.readSync()).success).toBe(true);
  await sourceProvider(resources, "user-healthy", "http://127.0.0.1:9000/v1");
  const service = new ModelConfigService(), migration = new ModelConfigMigration(service, resources.repository);
  const before = await bytes(), plan = await migration.plan();
  expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: "user-incompatible", status: "blocked", reasons: ["native_schema_incompatible"] }));
  expect(plan.snapshot.config.providers["user-incompatible"]).toBeUndefined();
  expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: "user-healthy", status: "migrated" }));
  expect(await bytes()).toEqual(before);
  await expect(migration.apply(0, plan.source_revision)).rejects.toMatchObject({ code: "import_blocked" }); expect(await bytes()).toEqual(before);
  await migration.apply(0, plan.source_revision, ["user-incompatible"]);
  expect(Object.keys(service.readSync().config.providers)).toEqual(["user-healthy"]);
  for (const [name, content] of Object.entries(before)) expect(await readFile(join(root, name), "utf8")).toBe(content);
});
it("uses imported native aliases for Settings, ordinary sessions and real research/review Workers without rewriting the saved default", async () => {
  diagnosticTarget = true;
  diagnostic("test.begin");
  if (process.env.PI_SCIENCE_CI_DIAGNOSTIC === "1") {
    diagnosticTimer = setInterval(() => diagnostic(`heartbeat:${diagnosticPhase.replace(/^heartbeat:/, "")}`), 3000);
    diagnosticTimer.unref();
  }
  const requests: Array<{ url?: string; model: string }> = [];
  const server = createServer(async (request, response) => {
    diagnostic("http.request.begin");
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ url: request.url, model: body.model });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "alias-test", object: "chat.completion.chunk", created: 1, model: body.model };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
    diagnostic("http.request.end");
  });
  diagnostic("server.listen.begin");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  diagnostic("server.listen.end");
  const cfg = { ...loadConfig({ PI_SCIENCE_REQUIRE_INTERNAL_TOKEN: "0", LOG_LEVEL: "silent" }), nodePiManager: false, nodeSessions: false, nodeSse: false, nodeFiles: false };
  const modules = createServerModules(cfg, { sqliteEnabled: false }), app = buildApp(cfg, modules), manager = new AgentRuntimeManager();
  diagnostic("modules.created");
  try {
    diagnostic("workspace.mkdir.begin");
    const cwd = join(root, "workspace"); await mkdir(join(cwd, ".pi-science"), { recursive: true });
    diagnostic("workspace.mkdir.end");
    diagnostic("provider.begin");
    await sourceProvider(modules.modelResources, "user-healthy", `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    diagnostic("provider.end");
    diagnostic("alias.update.begin");
    await modules.modelResources.repository.update((state) => { state.aliases["old-healthy/test"] = "user-healthy/test"; });
    diagnostic("alias.update.end");
    diagnostic("config.write.begin");
    await writeFile(join(root, "config.json"), JSON.stringify({ model: "old-healthy/test", thinking: "off" }));
    diagnostic("config.write.end");
    diagnostic("migration.plan.begin");
    const migration = new ModelConfigMigration(new ModelConfigService(), modules.modelResources.repository), plan = await migration.plan();
    diagnostic("migration.plan.end");
    diagnostic("migration.apply.begin");
    await migration.apply(0, plan.source_revision);
    diagnostic("migration.apply.end");
    diagnostic("config.read.begin");
    const saved = await readFile(join(root, "config.json"), "utf8");
    diagnostic("config.read.end");
    diagnostic("models.read.begin");
    const native = await readFile(join(root, "models.json"), "utf8");
    diagnostic("models.read.end");
    diagnostic("settings.inject.begin");
    const settings = await app.inject({ method: "GET", url: "/api/settings/config" });
    diagnostic("settings.inject.end");
    expect(settings.statusCode).toBe(200); expect(settings.json()).toMatchObject({ model: "user-healthy/test", unavailable_model: null });
    diagnostic("selection.inject.begin");
    expect((await app.inject({ method: "GET", url: "/api/model-selection/default" })).json().selection).toEqual({ model: "user-healthy/test", thinking: "off" });
    diagnostic("selection.inject.end");
    diagnostic("session.create.begin");
    const session = await modules.sessions.create({ cwd, config: { skills: [], extensions: [] } });
    diagnostic("session.create.end");
    if (!("id" in session)) throw new Error(session.error);
    diagnostic("session.state.begin");
    expect(await modules.sessions.state(session.id, cwd)).toMatchObject({ model: "user-healthy/test" });
    diagnostic("session.state.end");
    for (const purpose of ["research", "review"] as const) {
      diagnostic(`${purpose}.open.begin`);
      const runtime = await openCoreRunner(manager, { environment: async () => ({}) }, cwd, "alias", "owner", purpose);
      diagnostic(`${purpose}.open.end`);
      diagnostic(`${purpose}.initialize.begin`);
      await runtime.initialize();
      diagnostic(`${purpose}.initialize.end`);
      diagnostic(`${purpose}.prompt.begin`);
      expect(await runtime.prompt({ message: "Respond ok", clientMessageId: purpose, deadline: Date.now() + 15000 })).toBe("ok");
      diagnostic(`${purpose}.prompt.end`);
    }
    const environments = new WorkspaceEnvironmentService(); vi.spyOn(environments, "environment").mockResolvedValue({});
    const titleFactory = new CoreTitleRuntimeFactory(manager, environments);
    diagnostic("title.start.begin");
    const title = await titleFactory.start(cwd);
    diagnostic("title.start.end");
    try {
      diagnostic("title.command.begin");
      expect(await title.sendCommand("get_available_models")).toMatchObject({ success: true, data: { models: expect.arrayContaining([expect.objectContaining({ provider: "user-healthy", id: "test" })]) } });
      diagnostic("title.command.end");
    } finally {
      diagnostic("title.dispose.begin");
      await title.dispose();
      diagnostic("title.dispose.end");
    }
    expect(requests).toEqual([{ url: "/v1/chat/completions", model: "test" }, { url: "/v1/chat/completions", model: "test" }]);
    diagnostic("config.verify.begin");
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(saved);
    diagnostic("config.verify.end");
    diagnostic("models.verify.begin");
    expect(await readFile(join(root, "models.json"), "utf8")).toBe(native);
    diagnostic("models.verify.end");
  } finally {
    diagnostic("finally.begin");
    diagnostic("manager.shutdown.begin");
    await manager.shutdownAll();
    diagnostic("manager.shutdown.end");
    diagnostic("sessions.shutdown.begin");
    await modules.sessions.shutdownAll();
    diagnostic("sessions.shutdown.end");
    diagnostic("app.close.begin");
    await app.close();
    diagnostic("app.close.end");
    diagnostic("server.close.begin");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    diagnostic("server.close.end");
    diagnostic("finally.end");
  }
}, 30000);
it.each(["constructor", `user-${"a".repeat(201)}`])("blocks legacy provider ID %s using the target schema rather than treating inherited names as existing", async (id) => {
  const resources = new ModelResourceService(); await sourceProvider(resources, "user-source", "http://127.0.0.1:9000/v1");
  await resources.repository.update((state) => { state.providers[0]!.id = id; state.models[0]!.provider_id = id; state.bindings[0]!.provider_id = id; });
  expect(resources.repository.readSync().providers).toHaveLength(1);
  expect(modelResourceStateSchema.safeParse(resources.repository.readSync()).success).toBe(true);
  const plan = await new ModelConfigMigration(new ModelConfigService(), resources.repository).plan();
  expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: id, status: "blocked", reasons: ["native_schema_incompatible"] }));
  expect(Object.hasOwn(plan.snapshot.config.providers, id)).toBe(false);
});
