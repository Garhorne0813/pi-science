import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConfigService, modelConfigBackend } from "./model-config-service.js";
import { ModelResourceRepository } from "../model-resources/model-resource-repository.js";
import { CredentialStore } from "../model-resources/credential-store.js";
import { agentModels } from "../runtime/agent/worker/agent-models.js";
import { nativeProviderViews } from "./provider-config-view.js";
import { buildApp } from "../app/app.js";
import { createServerModules } from "../app/server-modules.js";
import { loadConfig } from "../config/config.js";
let root: string;
const apps: Array<{ close(): Promise<unknown> }> = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-replacement-")); vi.stubEnv("PI_SCIENCE_HOME", root); delete process.env.PI_SCIENCE_MODEL_CONFIG_BACKEND; });
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function appWithOldData() {
  const key = await new CredentialStore().put({ kind: "api_key", backend: "managed", secret: "old-secret" });
  await new ModelResourceRepository().update((state) => { state.credential_refs.openai = key.id; state.credential_refs.anthropic = key.id; });
  await writeFile(join(root, "config.json"), JSON.stringify({ api_keys: { openai: "old-inline-secret" }, custom_providers: [{ id: "old", name: "Old", api_key: "old-custom-secret", models: ["obsolete"], base_url: "http://127.0.0.1:9000/v1", api: "openai-completions" }] }));
  const cfg = { ...loadConfig({ PI_SCIENCE_REQUIRE_INTERNAL_TOKEN: "0", LOG_LEVEL: "silent" }), nodePiManager: false, nodeSessions: false, nodeSse: false, nodeFiles: false };
  const app = buildApp(cfg, createServerModules(cfg, { sqliteEnabled: false })); apps.push(app); await app.ready(); return app;
}
async function bytes() { return Object.fromEntries(await Promise.all((await readdir(root)).filter((name) => name.endsWith(".json")).map(async (name) => [name, await readFile(join(root, name), "utf8")]))); }
it("defaults to the sole native backend and rejects removed deployment switches", () => {
  expect(modelConfigBackend()).toBe("pi_ai_v1");
  for (const backend of ["legacy", "shadow", "surprise"]) { vi.stubEnv("PI_SCIENCE_MODEL_CONFIG_BACKEND", backend); expect(() => modelConfigBackend()).toThrow(); }
});
it("never adopts old builtin refs, inline keys or custom providers across Settings, catalog and Worker registry", async () => {
  const app = await appWithOldData(); const before = await bytes();
  expect(await agentModels().getAvailable()).toEqual([]);
  const views = await nativeProviderViews();
  for (const id of ["openai", "anthropic"]) expect(views.find((provider) => provider.id === id)?.credential.configured).toBe(false);
  for (const url of ["/api/provider-views", "/api/model-config/catalog", "/api/settings/config", "/api/settings/providers"]) {
    const response = await app.inject({ method: "GET", url }); expect(response.statusCode, url).toBe(200);
    expect(response.body).not.toMatch(/old-secret|old-inline-secret|old-custom-secret|custom-old|obsolete/);
  }
  expect((await app.inject({ method: "GET", url: "/api/settings/config" })).json().available_models).toEqual([]);
  expect(await bytes()).toEqual(before);
});
it("retires every old resource entry before network or persistence, including query/trailing slash variants", async () => {
  const app = await appWithOldData(); const before = await bytes(); const network = vi.spyOn(globalThis, "fetch");
  for (const path of ["providers", "models", "endpoints", "credentials", "provider-endpoint-bindings", "custom-providers", "settings/api-key", "settings/custom-providers"]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: `/api/${path}/item/?probe=1`, ...(method === "GET" || method === "DELETE" ? {} : { payload: { base_url: "https://must-not-resolve.example", api_key: "secret" } }) });
      expect({ path, method, status: response.statusCode }).toMatchObject({ status: 410 });
      expect(response.json()).toMatchObject({ code: "model_config_retired" });
    }
  }
  expect(network).not.toHaveBeenCalled(); expect(await bytes()).toEqual(before);
});
it("fails closed on manifests retaining legacy adapters without touching old files", async () => {
  const app = await appWithOldData();
  await writeFile(join(root, "models.json"), JSON.stringify({ schema_version: 1, legacy_providers: ["openai"], providers: {} }));
  const before = await bytes(); expect(() => new ModelConfigService().readSync()).toThrow(); expect(() => agentModels()).toThrow();
  expect((await app.inject({ method: "GET", url: "/api/model-config/catalog" })).statusCode).toBe(400);
  expect(await bytes()).toEqual(before);
});
it("reports shared builtin refs as blocked and requires exact explicit exclusions without retaining an adapter", async () => {
  const app = await appWithOldData();
  const before = await bytes();
  const report = (await app.inject({ method: "GET", url: "/api/model-config/migration" })).json();
  expect(report.providers).toEqual(expect.arrayContaining(["openai", "anthropic"].map((provider_id) => expect.objectContaining({ provider_id, status: "blocked", reasons: expect.arrayContaining(["shared_or_unsupported_credential"]) }))));
  expect(await bytes()).toEqual(before);
  const input = { revision: 0, source_revision: report.source_revision };
  for (const excluded_provider_ids of [[], ["openai"], ["openai", "anthropic", "unknown"]]) {
    const response = await app.inject({ method: "POST", url: "/api/model-config/migration", payload: { ...input, excluded_provider_ids } });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("import_blocked"); expect(await bytes()).toEqual(before);
  }
  expect((await app.inject({ method: "POST", url: "/api/model-config/migration", payload: { ...input, excluded_provider_ids: ["openai", "anthropic"] } })).statusCode).toBe(200);
  expect(new ModelConfigService().readSync()).toMatchObject({ config: { providers: {} }, credential_refs: {}, legacy_providers: [] });
  for (const name of Object.keys(before)) expect(await readFile(join(root, name), "utf8")).toBe(before[name]);
  expect(await agentModels().getAvailable()).toEqual([]);
});
it("does not import aliases pointing at excluded resources in a mixed healthy/empty import", async () => {
  const { ModelResourceService } = await import("../model-resources/model-resource-service.js");
  const resources = new ModelResourceService();
  for (const id of ["user-empty", "user-healthy"]) {
    await resources.createProvider({ id, name: id, adapter: "openai-compatible", auth_kind: "none", catalog_mode: "manual", enabled: true });
    const endpoint = await resources.createEndpoint({ name: id, base_url: "http://127.0.0.1:9000/v1", protocol: "openai", enabled: true, data_egress: "local" });
    await resources.createBinding({ provider_id: id, endpoint_id: endpoint.id, priority: 100, enabled: true });
    if (id === "user-healthy") await resources.updateModel(id, "test", { capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 8192 } });
  }
  await resources.repository.update((state) => { state.aliases["old-empty/test"] = "user-empty/test"; state.aliases["old-healthy/test"] = "user-healthy/test"; });
  const { ModelConfigMigration } = await import("./model-config-migration.js");
  const service = new ModelConfigService(), migration = new ModelConfigMigration(service, resources.repository);
  const before = await bytes(); const report = await migration.plan();
  expect(report.providers).toContainEqual(expect.objectContaining({ provider_id: "user-empty", status: "blocked", reasons: expect.arrayContaining(["empty_model_catalog"]) }));
  await expect(migration.apply(0, report.source_revision)).rejects.toMatchObject({ code: "import_blocked" }); expect(await bytes()).toEqual(before);
  await migration.apply(0, report.source_revision, ["user-empty"]);
  expect(service.readSync().aliases).toEqual({ "old-healthy/test": "user-healthy/test" });
  expect((await agentModels().getAvailable()).map((model) => model.provider)).toEqual(["user-healthy"]);
  expect(service.readSync().legacy_providers).toEqual([]);
});
it("blocks builtin resource endpoints whose catalog and dispatch cannot be represented by native overrides", async () => {
  const { ModelResourceService } = await import("../model-resources/model-resource-service.js");
  const { ModelConfigMigration } = await import("./model-config-migration.js");
  const resources = new ModelResourceService();
  await resources.repository.update((state) => {
    state.providers.push({ id: "openai", name: "Old gateway", kind: "system", source: "pi-ai", adapter: "pi-ai", auth_kind: "none", enabled: true, catalog_mode: "manual" });
    state.endpoints.push({ id: "gateway", name: "Gateway", base_url: "http://127.0.0.1:9000/v1", protocol: "openai", credential_ref: null, enabled: true, health: "unknown", data_egress: "local" });
    state.bindings.push({ id: "route", provider_id: "openai", endpoint_id: "gateway", enabled: true, priority: 100 });
    state.models.push({ provider_id: "openai", model_id: "gpt-4o", display_name: "GPT", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 8192, max_output_tokens: 4096 }, capability_source: "manual" });
  });
  const report = await new ModelConfigMigration(new ModelConfigService(), resources.repository).plan();
  expect(report.providers).toContainEqual(expect.objectContaining({ provider_id: "openai", status: "blocked", reasons: expect.arrayContaining(["builtin_endpoint_transport"]) }));
});
