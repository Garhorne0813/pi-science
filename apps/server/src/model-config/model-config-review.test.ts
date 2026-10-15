import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelConfigSchema, type Endpoint, type ProviderConfig } from "@pi-science/contracts";
import { ModelConfigMigration } from "./model-config-migration.js";
import { ModelConfigService, modelConfigPath } from "./model-config-service.js";
import { ModelRegistryService } from "./model-registry-service.js";
import { nativeProviderViews } from "./provider-config-view.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";
import { AgentCoreRuntimeClient } from "../runtime/agent/agent-runtime-client.js";
import { agentModels } from "../runtime/agent/worker/agent-models.js";
import { registerModelResourceRoutes } from "../http/routes/model-resource-routes.js";
import { buildApp } from "../app/app.js";
import { createServerModules } from "../app/server-modules.js";
import { loadConfig } from "../config/config.js";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
let root: string;
const apps: Array<{ close(): Promise<unknown> }> = [];
const config: ProviderConfig = { api: "openai-completions", baseUrl: "http://127.0.0.1:9876/v1", models: [{ id: "test", contextWindow: 8192 }] };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-model-review-"));
  vi.stubEnv("PI_SCIENCE_HOME", root); vi.stubEnv("PI_SCIENCE_MODEL_CONFIG_BACKEND", "pi_ai_v1");
  vi.mocked(lookup).mockResolvedValue([{ address: "203.0.113.10", family: 4 }] as never);
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});
async function legacyProvider(resources: ModelResourceService, id: string, options: { empty?: boolean; ref?: string; keyless?: boolean; priority?: number; endpoint?: Endpoint } = {}) {
  const provider = await resources.createProvider({ id, name: id, adapter: "openai-compatible", auth_kind: options.keyless === false || options.ref ? "api_key" : "none", catalog_mode: "manual", enabled: true });
  const endpoint = options.endpoint ?? await resources.createEndpoint({ name: id, base_url: config.baseUrl!, protocol: "openai", credential_ref: options.ref, enabled: true, data_egress: "local" });
  await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: options.priority ?? 100 });
  if (!options.empty) await resources.updateModel(provider.id, "test", { enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 8192, max_output_tokens: 4096 } });
  return { provider, endpoint };
}
async function routeApp(resources = new ModelResourceService()) {
  const app = Fastify(); apps.push(app);
  registerModelResourceRoutes(app, resources, { reloadConfiguration: async () => [] } as unknown as NodeSessionService);
  await app.ready(); return app;
}
async function bytes() {
  const names = (await readdir(root)).filter((name) => name.endsWith(".json"));
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(root, name), "utf8")])));
}

describe("review migration resource graph", () => {
  it("retains both providers sharing one endpoint without changing ownership or source files", async () => {
    const resources = new ModelResourceService();
    const first = await legacyProvider(resources, "user-first");
    await legacyProvider(resources, "user-second", { endpoint: first.endpoint });
    const before = await bytes(); const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository);
    const plan = await migration.plan();
    expect(plan.providers.filter((row) => row.status === "blocked").map((row) => row.provider_id).sort()).toEqual(["user-first", "user-second"]);
    expect(plan.providers.every((row) => row.reasons.includes("shared_endpoint"))).toBe(true);
    expect(await bytes()).toEqual(before);
    await migration.apply(0, plan.source_revision, plan.providers.filter((row) => row.status === "blocked").map((row) => row.provider_id));
    expect(await readFile(join(root, "model-resources.json"), "utf8")).toBe(before["model-resources.json"]);
    expect(new ModelConfigService().readSync().config.providers).toEqual({});
  });
  it.each(["provider-provider", "provider-endpoint"])("retains cross-owner %s credential references", async (topology) => {
    const resources = new ModelResourceService();
    const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "shared-review-key" });
    const a = await legacyProvider(resources, "user-a", { keyless: false });
    await legacyProvider(resources, "user-b", { keyless: false });
    await resources.repository.update((state) => {
      state.credential_refs["user-b"] = credential.id;
      if (topology === "provider-provider") state.credential_refs["user-a"] = credential.id;
      else state.endpoints.find((entry) => entry.id === a.endpoint.id)!.credential_ref = credential.id;
    });
    const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository);
    const plan = await migration.plan();
    expect(plan.providers).toEqual(expect.arrayContaining(["user-a", "user-b"].map((provider_id) => expect.objectContaining({ provider_id, status: "blocked", reasons: expect.arrayContaining(["shared_or_unsupported_credential"]) }))));
  });
  it("keeps MCP-owned credentials and their provider references intact during migration", async () => {
    const resources = new ModelResourceService();
    const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "mcp-shared-secret", owner_kind: "mcp", owner_id: "mcp-science" });
    await legacyProvider(resources, "user-mcp", { ref: credential.id });
    const before = await bytes(); const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository);
    const plan = await migration.plan();
    expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: "user-mcp", status: "blocked", reasons: expect.arrayContaining(["shared_or_unsupported_credential"]) }));
    await migration.apply(0, plan.source_revision, plan.providers.filter((row) => row.status === "blocked").map((row) => row.provider_id));
    expect(await resources.credentials.metadata(credential.id)).toMatchObject({ owner_kind: "mcp", owner_id: "mcp-science" });
    expect(await readFile(join(root, "credentials.json"), "utf8")).toBe(before["credentials.json"]);
    expect(await readFile(join(root, "model-resources.json"), "utf8")).toBe(before["model-resources.json"]);
  });
  it("classifies an empty custom catalog before applying a mixed healthy dataset", async () => {
    const resources = new ModelResourceService();
    await legacyProvider(resources, "user-empty", { empty: true });
    await legacyProvider(resources, "user-healthy");
    const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository);
    const before = await bytes(); const plan = await migration.plan();
    expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: "user-empty", status: "blocked", reasons: expect.arrayContaining(["empty_model_catalog"]) }));
    expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: "user-healthy", status: "migrated" }));
    expect(await bytes()).toEqual(before);
    await migration.apply(0, plan.source_revision, plan.providers.filter((row) => row.status === "blocked").map((row) => row.provider_id));
    expect(new ModelConfigService().readSync()).toMatchObject({ revision: 1, legacy_providers: [], config: { providers: { "user-healthy": expect.any(Object) } } });
    expect(await readFile(join(root, "model-resources.json"), "utf8")).toBe(before["model-resources.json"]);
  });
  it("retains native gateway transport and the exact destination instead of silently using builtin defaults", async () => {
    const resources = new ModelResourceService();
    const model = builtinModels().getProvider("openai")!.getModels()[0]!;
    const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "gateway-key" });
    await resources.repository.update((state) => { state.providers.push({ id: "openai", name: "OpenAI gateway", kind: "system", source: "pi-ai", adapter: "pi-ai", auth_kind: "api_key", enabled: true, catalog_mode: "runtime" }); });
    const endpoint = await resources.createEndpoint({ name: "Gateway", base_url: "http://127.0.0.1:8989/vendor-proxy", protocol: "native", credential_ref: credential.id, enabled: true, data_egress: "local" });
    await resources.createBinding({ provider_id: "openai", endpoint_id: endpoint.id, enabled: true, priority: 100 });
    await resources.repository.update((state) => { state.models.push({ provider_id: "openai", model_id: model.id, display_name: model.name, enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: model.contextWindow, max_output_tokens: model.maxTokens }, capability_source: "runtime" }); });
    const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository); const plan = await migration.plan();
    expect(plan.providers).toContainEqual(expect.objectContaining({ provider_id: "openai", status: "blocked", reasons: expect.arrayContaining(["native_endpoint_transport"]) }));
    await migration.apply(0, plan.source_revision, plan.providers.filter((row) => row.status === "blocked").map((row) => row.provider_id));
    expect(new ModelRegistryService().compile().getModel("openai", model.id)?.baseUrl).not.toBe(endpoint.base_url);
    expect(await agentModels().getAvailable()).toEqual([]);
  });
  it("preserves original files and references when apply fails before the atomic commit", async () => {
    const resources = new ModelResourceService(); await legacyProvider(resources, "user-failed");
    const service = new ModelConfigService(); const migration = new ModelConfigMigration(service, resources.repository);
    const plan = await migration.plan(); const before = await bytes();
    vi.spyOn(service, "preflight").mockRejectedValueOnce(new Error("preflight failed"));
    await expect(migration.apply(0, plan.source_revision)).rejects.toThrow("preflight failed");
    expect(await bytes()).toEqual(before); expect(service.readSync().revision).toBe(0);
  });
  it("rejects stale migration previews without changing bytes, credentials or revision", async () => {
    const resources = new ModelResourceService(); await legacyProvider(resources, "user-stale");
    const migration = new ModelConfigMigration(new ModelConfigService(), resources.repository); const plan = await migration.plan();
    await resources.repository.update((state) => { state.providers[0]!.name = "Changed"; });
    const before = await bytes();
    await expect(migration.apply(0, plan.source_revision)).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await bytes()).toEqual(before); expect(new ModelConfigService().readSync().revision).toBe(0);
  });
});

describe("review header boundary", () => {
  it.each(["X-ApiKey", "X-Auth", "X-Custom-Credential"])("rejects %s at provider, model and override levels without persisting or echoing the value", async (header) => {
    const service = new ModelConfigService(); await service.replace(0, { providers: { lab: config } });
    const app = await routeApp(); const before = await readFile(modelConfigPath(), "utf8");
    for (const provider of [{ ...config, headers: { [header]: "Bearer review-secret" } }, { ...config, models: [{ id: "test", headers: { [header]: "Bearer review-secret" } }] }, { ...config, modelOverrides: { test: { headers: { [header]: "Bearer review-secret" } } } }]) {
      const input = { providers: { lab: provider } };
      expect(modelConfigSchema.safeParse(input).success).toBe(false);
      const response = await app.inject({ method: "PUT", url: "/api/model-config", payload: { revision: 1, config: input } });
      expect(response.statusCode).toBe(400); expect(response.body).not.toContain("review-secret");
      expect(await readFile(modelConfigPath(), "utf8")).toBe(before);
      expect((await app.inject({ method: "GET", url: "/api/model-config" })).body).not.toContain("review-secret");
    }
  });
  it("preserves supported non-authentication protocol headers through disk, API and registry", async () => {
    const service = new ModelConfigService(); const app = await routeApp();
    const provider = { ...config, headers: { Accept: "text/event-stream", "Anthropic-Version": "2023-06-01" }, models: [{ id: "test", headers: { "Content-Type": "application/json" } }] };
    await service.replace(0, { providers: { lab: provider } });
    expect((await app.inject({ method: "GET", url: "/api/model-config" })).json().config.providers.lab).toMatchObject(provider);
    expect(JSON.parse(await readFile(modelConfigPath(), "utf8")).providers.lab).toMatchObject(provider);
    expect(new ModelRegistryService(service).compile().getModel("lab", "test")?.headers).toMatchObject({ ...provider.headers, ...provider.models[0]!.headers });
  });
  it.each([{ Accept: "Bearer secret" }, { "Content-Type": "text/plain" }, { "Anthropic-Version": "opaque-credential" }, { Accept: "application/json\n" }, { Accept: "application/json", accept: "text/event-stream" }])("rejects non-protocol values, control characters and duplicate names: %j", (headers) => {
    expect(modelConfigSchema.safeParse({ providers: { lab: { ...config, headers } } }).success).toBe(false);
  });
  it("fails closed on secret headers already written by an older configuration version", async () => {
    await writeFile(modelConfigPath(), JSON.stringify({ revision: 1, providers: { lab: { ...config, headers: { "X-Auth": "old-secret" } } } }));
    const before = await readFile(modelConfigPath(), "utf8"); const app = await routeApp();
    expect(() => new ModelConfigService().readSync()).toThrow();
    const response = await app.inject({ method: "GET", url: "/api/model-config" });
    expect(response.statusCode).toBe(400); expect(response.body).not.toContain("old-secret");
    expect(await readFile(modelConfigPath(), "utf8")).toBe(before);
  });
});

describe("review network preflight", () => {
  it("rotates B while A DNS is unavailable, but validates every new or changed destination", async () => {
    const service = new ModelConfigService();
    await service.replace(0, { providers: { a: { ...config, baseUrl: "https://offline.example/v1" }, b: config } });
    vi.mocked(lookup).mockClear().mockRejectedValue(new Error("DNS offline"));
    await expect(service.setCredential("b", 1, { source: "managed", secret: "rotated-b" })).resolves.toMatchObject({ revision: 2 });
    expect(lookup).not.toHaveBeenCalled();
    await expect(service.update(2, (snapshot) => { snapshot.config.providers.a!.name = "Renamed while offline"; })).resolves.toMatchObject({ revision: 3 });
    expect(lookup).not.toHaveBeenCalled();
    const app = await routeApp();
    expect((await app.inject({ method: "POST", url: "/api/model-config/preview", payload: service.readSync().config })).statusCode).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    const before = await readFile(modelConfigPath(), "utf8");
    await expect(service.createProvider(3, "new", { ...config, baseUrl: "https://new.example/v1" })).rejects.toThrow("DNS offline");
    await expect(service.update(3, (snapshot) => { snapshot.config.providers.b!.baseUrl = "https://changed.example/v1"; })).rejects.toThrow("DNS offline");
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await readFile(modelConfigPath(), "utf8")).toBe(before);
    await expect(service.update(3, (snapshot) => { snapshot.config.providers.b!.models = []; })).rejects.toThrow();
    await expect(service.replace(3, { providers: { b: { ...config, baseUrl: "file:///etc/passwd" } } })).rejects.toThrow();
    vi.stubEnv("PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS", "0");
    await expect(service.createProvider(3, "private", config)).rejects.toThrow(/private|reserved/);
    expect(await readFile(modelConfigPath(), "utf8")).toBe(before);
  });
  it("still blocks private DNS at inference even when a credential-only commit skips URL preflight", async () => {
    const service = new ModelConfigService(); await service.createProvider(0, "lab", { ...config, baseUrl: "https://rebound.example/v1" }, { source: "keyless" });
    vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    await service.setCredential("lab", 1, { source: "keyless" });
    const fetch = vi.spyOn(globalThis, "fetch");
    const registry = new ModelRegistryService(service).compile(undefined, false);
    const result = await registry.completeSimple(registry.getModel("lab", "test")!, { messages: [{ role: "user", content: "test", timestamp: 1 }] });
    expect(result.stopReason).toBe("error"); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("native authentication projection", () => {
  it.each(["managed", "environment", "keyless", "expired-env", "removed-key"] as const)("projects %s from native configuration consistently without exposing secrets", async (kind) => {
    const resources = new ModelResourceService(); const service = new ModelConfigService();
    vi.stubEnv("REVIEW_LEGACY_KEY", kind === "expired-env" ? "" : "legacy-env-secret");
    const credential = kind === "keyless" ? undefined : await resources.credentials.put(kind === "managed" || kind === "removed-key"
      ? { kind: "api_key", backend: "managed", secret: "legacy-managed-secret" }
      : { kind: "api_key", backend: "environment", environment_variable: "REVIEW_LEGACY_KEY" });
    const provider = { id: "native-lab" };
    await service.createProvider(0, provider.id, config);
    if (credential) await service.update(1, (snapshot) => { snapshot.credential_refs[provider.id] = credential.id; });
    else await service.setCredential(provider.id, 1, { source: "keyless" });
    const app = await routeApp(resources);
    if (kind === "removed-key") await resources.credentials.remove(credential!.id);
    const resolved = kind !== "expired-env" && kind !== "removed-key";
    const source = kind === "expired-env" ? "environment" : kind === "removed-key" ? "unconfigured" : kind;
    expect(await service.view(provider.id)).toMatchObject({ legacy: false, editable: true, authentication: { source, resolved } });
    const views = await nativeProviderViews(); const view = views.find((entry) => entry.id === provider.id);
    expect(view).toMatchObject({ status: resolved ? "ready" : "needs_key", credential: { configured: resolved, state: resolved ? "ready" : "needs_key" } });
    const catalog = (await app.inject({ method: "GET", url: "/api/model-config/catalog" })).json();
    expect(catalog.providers.find((entry: { id: string }) => entry.id === provider.id)).toMatchObject({ authentication: { source, resolved }, models: [expect.objectContaining({ available: resolved })] });
    expect((await app.inject({ method: "GET", url: `/api/model-config/providers/${provider.id}` })).json()).toMatchObject({ authentication: { source, resolved } });
    const selected = (await agentModels().getAvailable()).some((entry) => entry.provider === provider.id);
    expect(selected).toBe(resolved);
    for (const response of [views, catalog, await service.view(provider.id)]) expect(JSON.stringify(response)).not.toMatch(/legacy-managed-secret|legacy-env-secret/);
    const sessionsRoot = join(root, ".pi-science", "agent-sessions"); await mkdir(sessionsRoot, { recursive: true });
    const startup = () => AgentCoreRuntimeClient.start({ cwd: root, sessionsRoot, model: { provider: provider.id, modelId: "test" }, allowedTools: [], skillPaths: [],
      env: { REVIEW_LEGACY_KEY: process.env.REVIEW_LEGACY_KEY! }, credentialEnvNames: ["REVIEW_LEGACY_KEY"] });
    {
      const worker = await startup();
      try {
        const result = await worker.sendCommand("get_available_models");
        expect(result).toMatchObject({ success: true, data: { models: resolved ? expect.arrayContaining([expect.objectContaining({ provider: provider.id, id: "test" })]) : [] } });
        expect(JSON.stringify(result)).not.toMatch(/legacy-managed-secret|legacy-env-secret/);
      } finally { await worker.shutdown(); }
    }
  }, 30000);
});

it("enforces native legacy-write isolation using the full App registration order", async () => {
  const resources = new ModelResourceService(); const { provider, endpoint } = await legacyProvider(resources, "user-protected");
  const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "protected-key" });
  vi.stubEnv("PI_SCIENCE_MODEL_CONFIG_BACKEND", "pi_ai_v1");
  const cfg = { ...loadConfig({ PI_SCIENCE_REQUIRE_INTERNAL_TOKEN: "0", LOG_LEVEL: "silent" }), nodePiManager: false, nodeSessions: false, nodeSse: false, nodeFiles: false };
  const modules = createServerModules(cfg, { sqliteEnabled: false }); const app = buildApp(cfg, modules); apps.push(app); await app.ready();
  const before = await bytes();
  expect((await app.inject({ method: "GET", url: "/api/model-config/migration" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/model-config/shadow" })).statusCode).toBe(410);
  expect(await bytes()).toEqual(before);
  for (const url of ["/api/providers", "/api/endpoints", "/api/credentials", "/api/provider-endpoint-bindings"]) {
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(410);
    expect(await bytes()).toEqual(before);
  }
  const bindings = resources.repository.readSync().bindings;
  const calls = [
    ["PUT", "/api/settings/api-key", { provider: "openai", api_key: "new-key" }], ["DELETE", "/api/settings/api-key/openai", undefined],
    ["PUT", "/api/settings/custom-providers/protected", { name: "Changed", base_url: config.baseUrl, models: ["test"] }], ["DELETE", "/api/settings/custom-providers/protected", undefined],
    ["POST", "/api/providers", { name: "New", adapter: "openai-compatible", auth_kind: "none", enabled: true, catalog_mode: "manual" }],
    ["PUT", `/api/providers/${provider.id}`, { name: "Changed" }], ["DELETE", `/api/providers/${provider.id}`, undefined],
    ["PUT", `/api/models/${provider.id}/test`, { enabled: false }], ["DELETE", `/api/models/${provider.id}/test`, undefined],
    ["POST", "/api/endpoints", { name: "New", base_url: config.baseUrl, protocol: "openai", enabled: true }], ["PUT", `/api/endpoints/${endpoint.id}`, { name: "Changed" }], ["DELETE", `/api/endpoints/${endpoint.id}`, undefined],
    ["POST", "/api/provider-endpoint-bindings", { provider_id: provider.id, endpoint_id: endpoint.id, priority: 100, enabled: true }], ["PUT", `/api/provider-endpoint-bindings/${bindings[0]!.id}`, { enabled: false }], ["DELETE", `/api/provider-endpoint-bindings/${bindings[0]!.id}`, undefined],
    ["POST", "/api/custom-providers", { name: "Changed", base_url: config.baseUrl, models: ["test"], auth: { kind: "none" } }],
    ["PUT", `/api/custom-providers/${provider.id}`, { name: "Changed" }], ["DELETE", `/api/custom-providers/${provider.id}`, undefined],
    ["PUT", `/api/endpoints/${endpoint.id}/enabled?enabled=false`, undefined], ["POST", `/api/endpoints/${endpoint.id}/health`, {}],
    ["POST", `/api/credentials/${credential.id}/validate`, {}],
    ["POST", "/api/credentials", { kind: "api_key", backend: "managed", secret: "new-key" }], ["PUT", `/api/credentials/${credential.id}`, { secret: "new-key" }], ["DELETE", `/api/credentials/${credential.id}`, undefined],
  ] as const;
  for (const [method, url, payload] of calls) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect({ method, url, status: response.statusCode, body: response.json() }).toMatchObject({ status: 410, body: { code: "model_config_retired" } });
    expect(await bytes()).toEqual(before);
  }
});
