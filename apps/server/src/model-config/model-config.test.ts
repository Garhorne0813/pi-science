import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_CONTEXT_WINDOW, modelConfigSchema } from "@pi-science/contracts";
import { ModelConfigService, modelConfigBackend, modelConfigPath } from "./model-config-service.js";
import { ModelCredentialAdapter } from "./model-credential-adapter.js";
import { ModelRegistryService } from "./model-registry-service.js";
import { ModelConfigMigration } from "./model-config-migration.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";
import { agentModels } from "../runtime/agent/worker/agent-models.js";
import { registerModelResourceRoutes } from "../http/routes/model-resource-routes.js";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-model-config-")); vi.stubEnv("PI_SCIENCE_HOME", root); vi.stubEnv("PI_SCIENCE_MODEL_CONFIG_BACKEND", "pi_ai_v1"); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const config = { providers: { lab: { api: "openai-completions" as const, baseUrl: "http://127.0.0.1:9876/v1", models: [{ id: "test", contextWindow: 8192 }] } } };

describe("native model configuration", () => {
  it.each([
    { providers: { lab: { apiKey: "secret" } } },
    { providers: { lab: { samplingParamsByThinkingLevel: {} } } },
    { providers: { lab: { headers: { authorization: "secret" } } } },
    { providers: { lab: { baseUrl: "http://user:secret@localhost/v1" } } },
    { providers: { lab: { baseUrl: "http://localhost/v1?key=secret" } } },
    { providers: { lab: { models: [{ id: "a" }, { id: "a" }] } } },
  ])("rejects unknown/version-incompatible or secret-bearing fields", (input) => {
    expect(modelConfigSchema.safeParse(input).success).toBe(false);
  });
  it("defaults to native and rejects unknown backends", () => {
    delete process.env.PI_SCIENCE_MODEL_CONFIG_BACKEND;
    expect(modelConfigBackend()).toBe("pi_ai_v1");
    vi.stubEnv("PI_SCIENCE_MODEL_CONFIG_BACKEND", "surprise");
    expect(() => modelConfigBackend()).toThrow();
  });
  it("defaults an undeclared context window to the shared value", async () => {
    const service = new ModelConfigService();
    await service.replace(0, { providers: { lab: { api: "openai-completions" as const, baseUrl: "http://127.0.0.1:9876/v1", models: [{ id: "bare" }] } } });
    expect(new ModelRegistryService(service).compile().getModel("lab", "bare")).toMatchObject({ contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW, maxTokens: 16384 });
  });
  it("offers seven thinking levels when a reasoning model maps the extended ones", async () => {
    const service = new ModelConfigService();
    await service.replace(0, { providers: { lab: { api: "openai-completions" as const, baseUrl: "http://127.0.0.1:9876/v1", models: [{ id: "reasoner", reasoning: true, thinkingLevelMap: { xhigh: "high", max: "high" } }] } } });
    const model = new ModelRegistryService(service).compile().getModel("lab", "reasoner")!;
    expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
  it("keeps reads pure and fails closed on corruption or symlinks", async () => {
    const service = new ModelConfigService();
    expect(service.readSync().revision).toBe(0);
    await expect(stat(modelConfigPath())).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(modelConfigPath(), "bad");
    expect(() => service.readSync()).toThrow("invalid");
    await rm(modelConfigPath());
    await writeFile(join(root, "other.json"), "{}");
    await symlink(join(root, "other.json"), modelConfigPath());
    expect(() => service.readSync()).toThrow();
  });
  it("serializes competing revisions across service instances and preserves old bytes on failure", async () => {
    const service = new ModelConfigService();
    const results = await Promise.allSettled([service.replace(0, config), new ModelConfigService().replace(0, config)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(service.readSync().revision).toBe(1);
    const before = await readFile(modelConfigPath(), "utf8");
    await expect(service.replace(1, { providers: { bad: {} } })).rejects.toThrow();
    expect(await readFile(modelConfigPath(), "utf8")).toBe(before);
    // Windows reports synthesized POSIX mode bits; its access control is ACL-based.
    if (process.platform !== "win32") expect((await stat(modelConfigPath())).mode & 0o777).toBe(0o600);
  });
  it("does not adopt ambient keys and resolves only explicit env refs", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-secret"); vi.stubEnv("LAB_KEY", "explicit-secret");
    const service = new ModelConfigService();
    await service.replace(0, config);
    const registry = new ModelRegistryService(service);
    expect(await registry.compile().getAvailable()).toEqual([]);
    await service.setCredential("lab", 1, { source: "environment", environment_variable: "LAB_KEY" });
    expect((await registry.compile().getAvailable()).map((model) => `${model.provider}/${model.id}`)).toEqual(["lab/test"]);
    expect(await new ModelCredentialAdapter(service).read("lab")).toEqual({ type: "api_key", key: "explicit-secret" });
    expect(JSON.stringify(await service.view("lab"))).not.toContain("explicit-secret");
    expect(await readFile(modelConfigPath(), "utf8")).not.toContain("explicit-secret");
    vi.stubEnv("LAB_KEY", "");
    expect(await registry.compile().getAvailable()).toEqual([]);
  });
  it.each(["PI_SCIENCE_INTERNAL_TOKEN", "NCBI_API_KEY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE"])("rejects reserved env reference %s", async (name) => {
    const service = new ModelConfigService(); await service.replace(0, config);
    await expect(service.setCredential("lab", 1, { source: "environment", environment_variable: name })).rejects.toThrow();
    expect(service.readSync().revision).toBe(1);
  });
  it("uses copy-on-write credentials without changing or deleting an MCP-owned secret", async () => {
    const service = new ModelConfigService(); await service.replace(0, config);
    await service.credentials.put({ id: "shared", kind: "api_key", backend: "managed", secret: "mcp-secret", owner_kind: "mcp" });
    await service.update(1, (snapshot) => { snapshot.credential_refs.lab = "shared"; });
    await service.setCredential("lab", 2, { source: "managed", secret: "model-secret" });
    expect(service.readSync().credential_refs.lab).not.toBe("shared");
    await new ModelCredentialAdapter(service).delete("lab");
    expect((await service.credentials.getForRuntime("shared"))?.secret).toBe("mcp-secret");
    expect(await new ModelCredentialAdapter(service).read("lab")).toBeUndefined();
  });
  it("keeps registry snapshots stable, supports overrides and explicit keyless providers", async () => {
    const service = new ModelConfigService();
    await service.replace(0, { providers: { ...config.providers, openai: { modelOverrides: { "gpt-4o": { contextWindow: 65536 } } } } });
    await service.setCredential("lab", 1, { source: "keyless" });
    const snapshot = service.readSync();
    const models = agentModels({ modelConfigBackend: "pi_ai_v1", modelConfigSnapshot: snapshot });
    expect(models.getModel("openai", "gpt-4o")?.contextWindow).toBe(65536);
    expect((await models.getAvailable()).map((model) => model.provider)).toEqual(["lab"]);
    await service.setCredential("lab", 2, { source: "remove" });
    expect((await models.getAvailable()).map((model) => model.provider)).toEqual(["lab"]);
    expect(await new ModelRegistryService(service).compile().getAvailable()).toEqual([]);
    await expect(new ModelCredentialAdapter(service, snapshot).delete("lab")).rejects.toThrow("Settings");
  });
  it("rolls back a newly created credential if the config commit fails", async () => {
    const service = new ModelConfigService(); await service.replace(0, config);
    vi.spyOn(service, "preflight").mockRejectedValue(new Error("preflight failed"));
    await expect(service.setCredential("lab", 1, { source: "managed", secret: "never-commit" })).rejects.toThrow();
    expect(await service.credentials.listMetadata()).toEqual([]);
    expect(service.readSync().revision).toBe(1);
  });
  it("retains complex alias routes, backs up old files and does not rewrite legacy state", async () => {
    const resources = new ModelResourceService();
    const provider = await resources.createProvider({ name: "Complex", adapter: "openai-compatible", auth_kind: "none", catalog_mode: "manual", enabled: true });
    const endpoint = await resources.createEndpoint({ name: "Local", base_url: "http://127.0.0.1:9876/v1", protocol: "openai", enabled: true, data_egress: "local" });
    await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 100, model_aliases: { test: "upstream" } });
    await resources.updateModel(provider.id, "test", { enabled: true, capabilities: { context_window: 8192 } });
    const before = await readFile(join(root, "model-resources.json"), "utf8");
    const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository);
    const plan = await migration.plan();
    expect(plan.providers.find((row) => row.provider_id === provider.id)).toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["binding_policy"]) });
    await expect(migration.apply(0, plan.source_revision)).rejects.toMatchObject({ code: "import_blocked" });
    const report = await migration.apply(0, plan.source_revision, [provider.id]);
    expect(await readFile(join(report.backup, "model-resources.json"), "utf8")).toBe(before);
    expect(await readFile(join(root, "model-resources.json"), "utf8")).toBe(before);
    const registry = new ModelRegistryService().compile();
    expect(registry.getModel(provider.id, "test")).toBeUndefined();
  });
  it("keeps native HTTP reads pure, rejects stale edits and hides managed keys", async () => {
    vi.stubEnv("PI_SCIENCE_MODEL_CONFIG_BACKEND", "pi_ai_v1");
    const app = Fastify(); const reload = vi.fn().mockResolvedValue([]);
    registerModelResourceRoutes(app, new ModelResourceService(), { reloadConfiguration: reload } as unknown as NodeSessionService);
    try {
      expect((await app.inject("/api/model-config")).json().revision).toBe(0);
      await expect(stat(modelConfigPath())).rejects.toMatchObject({ code: "ENOENT" });
      expect((await app.inject({ method: "PUT", url: "/api/model-config", payload: { revision: 0, config } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PUT", url: "/api/model-config", payload: { revision: 0, config } })).statusCode).toBe(409);
      const response = await app.inject({ method: "PUT", url: "/api/model-config/providers/lab/credential", payload: { revision: 1, credential: { source: "managed", secret: "private-key" } } });
      expect(response.statusCode).toBe(200); expect(response.body).not.toContain("private-key");
      expect((await app.inject("/api/model-config/catalog")).body).not.toContain("private-key");
      expect((await app.inject({ method: "POST", url: "/api/providers", payload: {} })).statusCode).toBe(410);
      expect(reload).toHaveBeenCalledTimes(2);
      for (let attempt = 0; attempt < 10; attempt++) await app.inject({ method: "POST", url: "/api/model-config/discover", payload: {} });
      expect((await app.inject({ method: "POST", url: "/api/model-config/discover", payload: {} })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
});

it("keeps text, thinking and tool stream events equivalent across Worker and control-plane registries", async () => {
  const { createServer } = await import("node:http");
  const requests: Array<{ auth?: string; model: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ auth: request.headers.authorization, model: body.model });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const deltas = [{ role: "assistant", reasoning_content: "think" }, { content: "hello" },
      { tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "lookup", arguments: '{"value":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }];
    for (const delta of deltas) response.write(`data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const resources = new ModelResourceService();
    const provider = await resources.createProvider({ id: "user-lab", name: "Lab", adapter: "openai-compatible", auth_kind: "api_key", catalog_mode: "manual", enabled: true });
    const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "route-secret" });
    const endpoint = await resources.createEndpoint({ name: "Lab", base_url: baseUrl, protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "local" });
    await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 100 });
    await resources.updateModel(provider.id, "test", { enabled: true, capabilities: { reasoning: true, thinking_levels: ["off", "high"], context_window: 8192, max_output_tokens: 4096 } });
    expect(await agentModels().getAvailable()).toEqual([]);
    const service = new ModelConfigService();
    await service.createProvider(0, provider.id, { api: "openai-completions", baseUrl, models: [{ id: "test", reasoning: true, contextWindow: 8192, maxTokens: 4096, thinkingLevelMap: { off: "off", high: "high", minimal: null, low: null, medium: null, xhigh: null, max: null } }] }, { source: "managed", secret: "route-secret" });
    const native = new ModelRegistryService(service).compile();
    const traces = [];
    for (const registry of [agentModels(), native]) {
      const stream = registry.streamSimple(registry.getModel(provider.id, "test")!, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { reasoning: "high" });
      const events: unknown[] = [];
      for await (const event of stream) events.push({ type: event.type, delta: "delta" in event ? event.delta : undefined });
      const result = await stream.result();
      expect(result.stopReason).toBe("toolUse");
      traces.push({ events, content: result.content, usage: result.usage });
    }
    expect(traces[1]).toEqual(traces[0]);
    expect(requests).toEqual([{ auth: "Bearer route-secret", model: "test" }, { auth: "Bearer route-secret", model: "test" }]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("does not resolve reserved internal env references even when manually mapped", async () => {
  vi.stubEnv("PI_SCIENCE_INTERNAL_TOKEN", "internal-never-dispatch");
  const service = new ModelConfigService(); await service.replace(0, config);
  const credential = await service.credentials.put({ kind: "api_key", backend: "environment", environment_variable: "PI_SCIENCE_INTERNAL_TOKEN" });
  await service.update(1, (snapshot) => { snapshot.credential_refs.lab = credential.id; });
  expect(await new ModelCredentialAdapter(service).read("lab")).toBeUndefined();
  expect(await new ModelRegistryService(service).compile().getAvailable()).toEqual([]);
});

it("serializes credential modify callbacks and cleans up new keys after a failed commit", async () => {
  const service = new ModelConfigService(); await service.replace(0, config);
  await service.setCredential("lab", 1, { source: "managed", secret: "zero" });
  const adapter = new ModelCredentialAdapter(service);
  const seen: Array<string | undefined> = [];
  let entered!: () => void, release!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const modify = (key: string) => adapter.modify("lab", async (current) => {
    seen.push(current?.type === "api_key" ? current.key : undefined);
    if (key === "one") { entered(); await gate; }
    return { type: "api_key", key };
  });
  // Establish the lock holder explicitly; asynchronous reads before acquisition
  // do not guarantee that simultaneous invocations reach the lock in order.
  const first = modify("one");
  await firstEntered;
  const second = modify("two");
  release();
  await Promise.all([first, second]);
  expect(seen).toEqual(["zero", "one"]);
  expect(await adapter.read("lab")).toEqual({ type: "api_key", key: "two" });
  const count = (await service.credentials.listMetadata()).length;
  vi.spyOn(service, "preflight").mockRejectedValueOnce(new Error("write failed"));
  await expect(modify("failed")).rejects.toThrow("write failed");
  expect((await service.credentials.listMetadata()).length).toBe(count);
  expect(await adapter.read("lab")).toEqual({ type: "api_key", key: "two" });
});

it("migrates builtin credentials without Provider rows and keeps the available catalog equivalent", async () => {
  const service = new ModelConfigService();
  await service.credentials.put({ id: "builtin-key", kind: "api_key", backend: "managed", secret: "builtin-test-secret" });
  const resources = new ModelResourceService();
  await resources.repository.update((state) => { state.credential_refs.openai = "builtin-key"; });
  expect(await agentModels().getAvailable()).toEqual([]);
  const migration = new ModelConfigMigration(service, resources.repository);
  const plan = await migration.plan();
  expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: "openai", status: "migrated" }));
  await migration.apply(0, plan.source_revision);
  expect((await agentModels().getAvailable()).some((model) => model.provider === "openai")).toBe(true);
});

it("atomically creates an empty builtin override with its first managed credential", async () => {
  const service = new ModelConfigService();
  await service.setCredential("openai", 0, { source: "managed", secret: "first-builtin-key" });
  expect(service.readSync()).toMatchObject({ revision: 1, config: { providers: { openai: {} } } });
  expect(await new ModelCredentialAdapter(service).read("openai")).toEqual({ type: "api_key", key: "first-builtin-key" });
});

it("pins private-network restrictions in Worker settings without expanding the environment whitelist", async () => {
  vi.stubEnv("PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS", "1");
  const service = new ModelConfigService();
  await service.createProvider(0, "lab", config.providers.lab, { source: "keyless" });
  const models = agentModels({ modelConfigBackend: "pi_ai_v1", modelConfigSnapshot: service.readSync(), modelConfigAllowPrivate: false });
  const fetch = vi.spyOn(globalThis, "fetch");
  const result = await models.completeSimple(models.getModel("lab", "test")!, { messages: [{ role: "user", content: "test", timestamp: 1 }] });
  expect(result.stopReason).toBe("error");
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves non-reasoning Thinking maps when converting a simple custom provider", async () => {
  const resources = new ModelResourceService();
  const provider = await resources.createProvider({ id: "user-simple", name: "Simple", adapter: "openai-compatible", auth_kind: "none", catalog_mode: "manual", enabled: true });
  const endpoint = await resources.createEndpoint({ name: "Simple", base_url: config.providers.lab.baseUrl, protocol: "openai", enabled: true, data_egress: "local" });
  await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 100 });
  await resources.updateModel(provider.id, "test", { enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 8192, max_output_tokens: 4096 } });
  expect(await agentModels().getAvailable()).toEqual([]);
  const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository);
  const plan = await migration.plan();
  expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: provider.id, status: "migrated" }));
  await migration.apply(0, plan.source_revision);
  expect(new ModelRegistryService().compile().getModel(provider.id, "test")).toMatchObject({ reasoning: false, thinkingLevelMap: { off: null } });
});

it("binds the native snapshot and trusted EnvRef for direct disposable Worker callers", async () => {
  vi.stubEnv("PI_SCIENCE_MODEL_CONFIG_BACKEND", "pi_ai_v1");
  vi.stubEnv("LAB_KEY", "host-only-test-key");
  const service = new ModelConfigService();
  await service.createProvider(0, "lab", config.providers.lab);
  await service.setCredential("lab", 1, { source: "environment", environment_variable: "LAB_KEY" });
  const { AgentCoreRuntimeClient } = await import("../runtime/agent/agent-runtime-client.js");
  const sessionsRoot = join(root, ".pi-science", "agent-sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const worker = await AgentCoreRuntimeClient.start({ cwd: root, sessionsRoot, model: { provider: "lab", modelId: "test" },
    allowedTools: [], skillPaths: [], env: { LAB_KEY: "workspace-cannot-override" } });
  try {
    const result = await worker.sendCommand("get_available_models");
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ provider: "lab", id: "test" })]) });
    expect(JSON.stringify(result)).not.toContain("host-only-test-key");
  } finally { await worker.shutdown(); }
}, 30000);

it("isolates empty snapshots and failed initial commits across fresh homes", async () => {
  const service = new ModelConfigService();
  const first = service.readSync();
  first.config.providers.phantom = {};
  first.credential_refs.phantom = "not-persisted";
  first.legacy_providers.push("phantom");
  expect(service.readSync()).toMatchObject({ revision: 0, config: { providers: {} }, credential_refs: {}, legacy_providers: [] });
  await expect(service.createProvider(0, "invalid", {})).rejects.toThrow();
  expect(service.readSync().config.providers).toEqual({});
});
