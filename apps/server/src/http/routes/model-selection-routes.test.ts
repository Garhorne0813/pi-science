import { providerViewsResponseSchema } from "@pi-science/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../app/app.js";
import { createServerModules } from "../../app/server-modules.js";
import type { ServerConfig } from "../../config/config.js";

const flash = "deepseek/deepseek-flash";
const pro = "deepseek/deepseek-v4-pro";
const config: ServerConfig = { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 1000000, upstreamTimeoutMs: 100,
  nodeSessions: false, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
let root: string;
let cwd: string;
let home: string;
let modules: ReturnType<typeof createServerModules>;
let app: ReturnType<typeof buildApp>;
beforeEach(async () => {
  const scratch = fileURLToPath(new URL("../../../../../.cache/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "selection-v2-"));
  cwd = join(root, "workspace"); home = join(root, "home");
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  await mkdir(home);
  vi.stubEnv("PI_SCIENCE_HOME", home);
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("PI_CLI_PATH", "");
  modules = createServerModules(config, { sqliteEnabled: false });
  app = buildApp(config, modules);
  expect((await app.inject({ method: "PUT", url: "/api/settings/api-key", payload: { provider: "deepseek", api_key: "synthetic-ownership-key" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: flash, thinking: "off" } })).statusCode).toBe(200);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await modules?.sessions.shutdownAll();
  await app?.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const path = (id: string) => `/api/sessions/${id}/model-selection?cwd=${encodeURIComponent(cwd)}`;
async function create() {
  const result = await modules.sessions.create({ cwd, config: { skills: [], extensions: [] } });
  if (!("id" in result)) throw new Error(result.error);
  return result.id;
}
async function selection(id: string) {
  const response = await app.inject({ method: "GET", url: path(id) });
  expect(response.statusCode).toBe(200);
  return response.json().selection;
}
describe("ModelSelection v2", () => {
  it("separates defaults, existing sessions and cold durable resumes", async () => {
    const reload = vi.spyOn(modules.sessions, "reloadConfiguration");
    const a = await create();
    expect((await app.inject({ method: "PUT", url: path(a), payload: { model: pro, thinking: "high" } })).statusCode).toBe(200);
    expect(await selection(a)).toEqual({ model: pro, thinking: "high" });
    expect((await app.inject({ method: "GET", url: "/api/model-selection/default" })).json().selection).toEqual({ model: flash, thinking: "off" });
    const b = await create();
    expect(await selection(b)).toEqual({ model: flash, thinking: "off" });
    expect(modules.sessions.processCount).toBe(2);
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: pro, thinking: "max" } })).statusCode).toBe(200);
    expect(modules.sessions.processCount).toBe(2);
    expect(await selection(a)).toEqual({ model: pro, thinking: "high" });
    expect(await selection(b)).toEqual({ model: flash, thinking: "off" });
    const c = await create();
    expect(await selection(c)).toEqual({ model: pro, thinking: "max" });
    expect(reload).not.toHaveBeenCalled();
    await modules.sessions.shutdownAll();
    expect(modules.sessions.processCount).toBe(0);
    for (const [id, model, thinking] of [[a, pro, "high"], [b, flash, "off"], [c, pro, "max"]]) {
      expect(await selection(id!)).toEqual({ model, thinking });
      expect(await modules.sessions.resume(id!, cwd)).toMatchObject({ success: true });
      expect(await selection(id!)).toEqual({ model, thinking });
    }
  }, 30000);
  it("keeps default reads lightweight and rejects malformed or unavailable writes", async () => {
    const catalog = vi.spyOn(modules.runtimeCatalog, "getCatalog");
    const models = vi.spyOn(modules.sessions, "availableModels");
    const configure = vi.spyOn(modules.sessions, "configure");
    const write = vi.spyOn(modules.settings, "update");
    expect((await app.inject({ method: "GET", url: "/api/model-selection/default" })).json()).toMatchObject({ scope: "default", selection: { model: flash, thinking: "off" } });
    expect(catalog).not.toHaveBeenCalled(); expect(models).not.toHaveBeenCalled();
    for (const payload of [{ model: flash, thinking: "unknown" }, { model: "invalid", thinking: "off" }, { model: flash, thinking: "off", session_id: "injected" }]) {
      expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: "user-missing/model", thinking: "off" } })).statusCode).toBe(422);
    const available = (await app.inject({ method: "GET", url: "/api/model-selection/catalog" })).json().available_models;
    const levels = available.find((model: { id: string }) => model.id === flash).thinking_levels;
    const unsupported = ["minimal", "low", "medium", "high", "xhigh", "max"].find((level) => !levels.includes(level));
    expect(unsupported).toBeDefined();
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: flash, thinking: unsupported } })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/sessions/missing/model-selection" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: path("missing") })).statusCode).toBe(404);
    expect(write).not.toHaveBeenCalled(); expect(configure).not.toHaveBeenCalled();
  });
  it("isolates failed/busy session writes and clearing defaults from existing sessions", async () => {
    const a = await create();
    const before = await readFile(join(home, "config.json"), "utf8");
    const configure = vi.spyOn(modules.sessions, "configure").mockResolvedValue({ success: false, code: "busy", error: "agent is busy" });
    const failed = await app.inject({ method: "PUT", url: path(a), payload: { model: pro, thinking: "high" } });
    expect(failed.statusCode).toBe(409);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(before);
    expect(await selection(a)).toEqual({ model: flash, thinking: "off" });
    configure.mockRestore();
    expect((await app.inject({ method: "PUT", url: path(a), payload: { model: null, thinking: "off" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: null, thinking: "off" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/model-selection/default" })).json().selection).toEqual({ model: null, thinking: "off" });
    expect(await selection(a)).toEqual({ model: flash, thinking: "off" });
    expect(await modules.sessions.create({ cwd, config: { skills: [], extensions: [] } })).toMatchObject({ code: "invalid_model" });
    // A workspace draft can still create a session with an explicit selection.
    const draft = await modules.sessions.create({ cwd, config: { model: pro, thinking: "high", skills: [], extensions: [] } });
    expect(draft).toHaveProperty("id");
  }, 30000);
  it.each(["credential_deleted", "endpoint_disabled", "binding_disabled", "binding_deleted", "allowlist_excludes", "provider_disabled", "model_disabled", "endpoint_blocked"])("rejects a catalogued custom model after %s without changing either owner", async (failure) => {
    const resources = modules.modelResources;
    const provider = await resources.createProvider({ name: "Selectable Lab", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
    const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "synthetic-selectability-key", owner_provider_id: provider.id });
    const endpoint = await resources.createEndpoint({ name: "Lab route", base_url: "http://127.0.0.1:9/v1", protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "local" });
    const binding = await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    const model = `${provider.id}/lab-model`;
    await resources.updateModel(provider.id, "lab-model", { enabled: true });
    const catalog = async () => (await app.inject({ method: "GET", url: "/api/model-selection/catalog" })).json().available_models;
    expect(await catalog()).toEqual(expect.arrayContaining([expect.objectContaining({ id: model })]));
    expect((await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model, thinking: "off" } })).statusCode).toBe(200);
    await app.inject({ method: "PUT", url: "/api/model-selection/default", payload: { model: flash, thinking: "off" } });
    const a = await create();
    if (failure === "credential_deleted") await resources.credentials.remove(credential.id);
    if (failure === "endpoint_disabled") await resources.updateEndpoint(endpoint.id, { enabled: false });
    if (failure === "binding_disabled") await resources.updateBinding(binding.id, { enabled: false });
    if (failure === "binding_deleted") await resources.deleteBinding(binding.id);
    if (failure === "allowlist_excludes") await resources.updateBinding(binding.id, { model_allowlist: ["another-model"] });
    if (failure === "provider_disabled") await resources.updateProvider(provider.id, { enabled: false });
    if (failure === "model_disabled") await resources.updateModel(provider.id, "lab-model", { enabled: false });
    if (failure === "endpoint_blocked") await resources.repository.update((state) => { state.endpoints.find((item) => item.id === endpoint.id)!.health = "blocked"; });
    const resourceBeforeGet = await readFile(join(home, "model-resources.json"), "utf8");
    const management = await app.inject({ method: "GET", url: "/api/provider-views" });
    expect(management.statusCode).toBe(200);
    expect(providerViewsResponseSchema.safeParse(management.json()).success).toBe(true);
    const view = management.json().providers.find((item: { id: string }) => item.id === provider.id);
    expect(view).toMatchObject({ routing: { configured_model_count: 1, selectable_model_count: 0 }, last_verification: { state: "never", checked_at: null }, models: [expect.objectContaining({ id: model, available: false })] });
    expect(view.allowed_actions).toContain("edit");
    if (failure === "binding_deleted") expect(view).toMatchObject({ status: "unavailable", credential: { state: "ready", configured: true }, routing: { issues: [{ code: "no_binding" }] } });
    expect(management.body).not.toContain("synthetic-selectability-key");
    expect(await readFile(join(home, "model-resources.json"), "utf8")).toBe(resourceBeforeGet);
    // This is a real Core projection, not a mocked catalog or resource list.
    expect(await catalog()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: model })]));
    const persisted = await readFile(join(home, "config.json"), "utf8");
    const configure = vi.spyOn(modules.sessions, "configure");
    for (const url of ["/api/model-selection/default", path(a), `/api/settings/model?cwd=${encodeURIComponent(cwd)}`]) {
      const response = await app.inject({ method: "PUT", url, payload: { model, thinking: "off" } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_model" });
    }
    expect(configure).not.toHaveBeenCalled();
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(persisted);
    expect(await selection(a)).toEqual({ model: flash, thinking: "off" });
  }, 30000);
  it("rejects a builtin model after its managed credential is deleted", async () => {
    const a = await create();
    const ref = (await modules.modelResources.repository.read()).credential_refs.deepseek;
    expect(ref).toBeDefined();
    await modules.modelResources.credentials.remove(ref!);
    const persisted = await readFile(join(home, "config.json"), "utf8");
    for (const url of ["/api/model-selection/default", path(a)]) {
      expect((await app.inject({ method: "PUT", url, payload: { model: flash, thinking: "off" } })).statusCode).toBe(422);
    }
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(persisted);
    expect(await selection(a)).toEqual({ model: flash, thinking: "off" });
  }, 30000);

  it("keeps configured native routes distinct from Core selectability and inference verification", async () => {
    const resources = modules.modelResources;
    const provider = await resources.createProvider({ name: "Native Lab", adapter: "native", catalog_mode: "manual", auth_kind: "none", enabled: true });
    const endpoint = await resources.createEndpoint({ name: "Native", base_url: "http://127.0.0.1:9", protocol: "native", credential_ref: null, enabled: true, data_egress: "local" });
    await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    await resources.updateModel(provider.id, "unsupported", { capabilities: { context_window: 65536 } });
    await resources.repository.update((state) => { const row = state.endpoints.find((item) => item.id === endpoint.id)!; row.health = "ready"; row.last_checked_at = new Date().toISOString(); });
    const snapshot = await readFile(join(home, "model-resources.json"), "utf8");
    const response = await app.inject({ method: "GET", url: "/api/provider-views" });
    expect(response.statusCode).toBe(200);
    const view = response.json().providers.find((item: { id: string }) => item.id === provider.id);
    expect(view).toMatchObject({ status: "unavailable", credential: { configured: true, state: "ready" }, routing: { configured_model_count: 1, selectable_model_count: 0 }, last_verification: { state: "never", checked_at: null }, models: [expect.objectContaining({ available: false, availability_reason: "core_unavailable", capabilities: expect.objectContaining({ context_window: 65536 }), routes: [expect.objectContaining({ health: "ready" })] })] });
    expect((await app.inject({ method: "GET", url: "/api/provider-views" })).json()).toEqual(response.json());
    expect(await readFile(join(home, "model-resources.json"), "utf8")).toBe(snapshot);
  }, 30000);
  it("scopes provider views to the validated workspace catalog", async () => {
    const response = await app.inject({ method: "GET", url: `/api/provider-views?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    const catalog = (await app.inject({ method: "GET", url: `/api/model-selection/catalog?cwd=${encodeURIComponent(cwd)}` })).json().available_models;
    const ids = new Set(catalog.map((item: { id: string }) => item.id));
    for (const provider of response.json().providers) {
      expect(provider.routing.selectable_model_count).toBe(provider.models.filter((model: { id: string }) => ids.has(model.id)).length);
    }
    expect((await app.inject({ method: "GET", url: "/api/provider-views?cwd=" })).statusCode).toBe(400);
  }, 30000);

});
