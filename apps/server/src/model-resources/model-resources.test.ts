import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCapabilities } from "./capability-resolver.js";
import { CredentialStore } from "./credential-store.js";
import { migrateLegacyModelResources } from "./migration/migrate-custom-providers.js";
import { ModelResourceRepository, emptyModelResourceState } from "./model-resource-repository.js";
import { ModelResourceService } from "./model-resource-service.js";
import { RuntimeModelResolver } from "./runtime-model-resolver.js";
import { SettingsStore } from "../storage/settings-store.js";

const roots: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-model-resources-"));
  roots.push(root);
  process.env.PI_SCIENCE_HOME = root;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("capability resolver", () => {
  it("keeps runtime values above manual and discovery values", () => {
    const result = resolveCapabilities("qwen3", [
      { reasoning: false, context_window: 32_768, thinking_levels: ["off"], source: "manual" },
      { reasoning: true, context_window: 65_536, thinking_levels: ["off", "high"], source: "discovery" },
      { reasoning: true, context_window: 131_072, thinking_levels: ["off", "high", "max"], source: "runtime", verified_at: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(result.capabilities).toMatchObject({ reasoning: true, context_window: 131_072, thinking_levels: ["off", "high", "max"] });
    expect(result.capability_source).toBe("runtime");
    expect(result.verified_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("forces thinking off when reasoning is false", () => {
    expect(resolveCapabilities("plain-model", [{ reasoning: false, thinking_levels: ["off", "high"], source: "manual" }]).capabilities).toMatchObject({ reasoning: false, thinking_levels: ["off"] });
  });
});

describe("credential store", () => {
  it("returns metadata without the managed secret and reads environment credentials explicitly", async () => {
    const store = new CredentialStore();
    const managed = await store.put({ id: "cred-managed", kind: "api_key", backend: "managed", secret: "managed-secret", label: "Managed" });
    expect(managed).not.toHaveProperty("secret");
    expect(await store.listMetadata()).not.toEqual(expect.arrayContaining([expect.objectContaining({ secret: "managed-secret" })]));
    expect(await store.getForRuntime("cred-managed")).toMatchObject({ secret: "managed-secret" });

    process.env.PI_SCIENCE_EXPLICIT_KEY = "environment-secret";
    const environment = await store.put({ id: "cred-env", kind: "api_key", backend: "environment", environment_variable: "PI_SCIENCE_EXPLICIT_KEY" });
    expect(environment).toMatchObject({ backend: "environment", status: "configured", environment_variable: "PI_SCIENCE_EXPLICIT_KEY" });
    expect(await store.getForRuntime("cred-env")).toMatchObject({ secret: "environment-secret" });
    const persisted = await readFile(join(process.env.PI_SCIENCE_HOME!, "credentials.json"), "utf8");
    expect(persisted).not.toContain("environment-secret");
    delete process.env.PI_SCIENCE_EXPLICIT_KEY;
  });

  it("creates credentials.json with 0600 permissions on POSIX", async () => {
    await new CredentialStore().put({ id: "cred-mode", kind: "api_key", backend: "managed", secret: "mode-secret" });
    const mode = (await stat(join(process.env.PI_SCIENCE_HOME!, "credentials.json"))).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("drops persisted secrets when the backend no longer stores them", async () => {
    const store = new CredentialStore();
    const path = join(process.env.PI_SCIENCE_HOME!, "credentials.json");
    await store.put({ id: "cred-switch", kind: "api_key", backend: "managed", secret: "stale-secret" });
    expect(await readFile(path, "utf8")).toContain("stale-secret");

    await store.put({ id: "cred-switch", backend: "external", external_ref: "vault/item" });
    expect(await readFile(path, "utf8")).not.toContain("stale-secret");

    await store.put({ id: "cred-switch", kind: "api_key", backend: "managed", secret: "stale-secret" });
    await store.put({ id: "cred-switch", backend: "environment", environment_variable: "PI_SCIENCE_SWITCH_KEY" });
    expect(await readFile(path, "utf8")).not.toContain("stale-secret");

    await store.put({ id: "cred-switch", kind: "api_key", backend: "managed", secret: "stale-secret" });
    await store.put({ id: "cred-switch", kind: "none" });
    expect(await readFile(path, "utf8")).not.toContain("stale-secret");
  });
});

describe("runtime model resolver", () => {
  it("requires a usable credential and chooses bindings by priority", async () => {
    const repository = new ModelResourceRepository();
    const credentials = new CredentialStore();
    await credentials.put({ id: "cred", kind: "api_key", backend: "managed", secret: "secret" });
    const state = emptyModelResourceState();
    state.providers.push({ id: "user-lab", name: "Lab", kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "manual", auth_kind: "api_key", source: "user" });
    state.endpoints.push(
      { id: "ep-disabled", name: "Disabled", base_url: "http://disabled.example/v1", protocol: "openai", credential_ref: "cred", enabled: false, health: "unknown", data_egress: "remote" },
      { id: "ep-primary", name: "Primary", base_url: "http://primary.example/v1", protocol: "openai", credential_ref: "cred", enabled: true, health: "unknown", data_egress: "remote" },
    );
    state.bindings.push(
      { id: "bind-disabled", provider_id: "user-lab", endpoint_id: "ep-disabled", enabled: true, priority: 1 },
      { id: "bind-primary", provider_id: "user-lab", endpoint_id: "ep-primary", enabled: true, priority: 20 },
    );
    state.models.push({ provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "manual" });
    await repository.replace(state);
    const model = (await new RuntimeModelResolver(repository, credentials).resolveAvailableModels())[0]!;
    expect(model.available).toBe(true);
    expect(model.routes).toHaveLength(1);
    expect(model.routes[0]).toMatchObject({ binding_id: "bind-primary", priority: 20, unverified: true });
  });

  it("marks a model unavailable when its endpoint is blocked or its credential is missing", async () => {
    const repository = new ModelResourceRepository();
    const credentials = new CredentialStore();
    const state = emptyModelResourceState();
    state.providers.push({ id: "user-lab", name: "Lab", kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "manual", auth_kind: "api_key", source: "user" });
    state.endpoints.push({ id: "ep", name: "Blocked", base_url: "http://blocked.example/v1", protocol: "openai", credential_ref: "missing", enabled: true, health: "blocked", data_egress: "remote" });
    state.bindings.push({ id: "bind", provider_id: "user-lab", endpoint_id: "ep", enabled: true, priority: 1 });
    state.models.push({ provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "fallback" });
    await repository.replace(state);
    const model = (await new RuntimeModelResolver(repository, credentials).resolveAvailableModels())[0]!;
    expect(model).toMatchObject({ available: false, availability_reason: "blocked", routes: [] });
  });
});

describe("legacy migration", () => {
  it("is idempotent, moves secrets to CredentialStore, and cleans legacy settings", async () => {
    await mkdir(process.env.PI_SCIENCE_HOME!, { recursive: true });
    await writeFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), JSON.stringify({ model: "custom-lab/model-a", api_keys: { openai: "builtin-secret" }, custom_providers: [{ id: "lab", name: "Lab", base_url: "http://127.0.0.1:8000/v1", api: "openai-completions", models: ["model-a"], api_key: "custom-secret", reasoning: true, context_window: 64_000 }] }), "utf8");
    const repository = new ModelResourceRepository();
    const credentials = new CredentialStore();
    const settings = new SettingsStore();
    const first = await migrateLegacyModelResources(repository, credentials, settings);
    expect(first.migrated).toBe(true);
    expect(first.provider_count).toBe(1);
    expect((await repository.read()).models[0]).toMatchObject({ provider_id: "user-lab", model_id: "model-a" });
    expect((await credentials.listMetadata()).length).toBe(2);
    const cleaned = JSON.parse(await readFile(join(process.env.PI_SCIENCE_HOME!, "config.json"), "utf8")) as Record<string, unknown>;
    expect(cleaned).not.toHaveProperty("api_keys");
    expect((cleaned.custom_providers as Array<Record<string, unknown>>)[0]).not.toHaveProperty("api_key");
    const second = await migrateLegacyModelResources(repository, credentials, settings);
    expect(second.migrated).toBe(false);
    expect((await repository.read()).providers).toHaveLength(1);
  });
});

describe("resource service", () => {
  it("creates canonical user resources without putting a secret in the resource file", async () => {
    const service = new ModelResourceService();
    const provider = await service.createProvider({ name: "Lab", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "none", enabled: true });
    const endpoint = await service.createEndpoint({ name: "Lab endpoint", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: null, enabled: true, data_egress: "local" });
    await service.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    const state = await service.repository.read();
    expect(state.providers).toHaveLength(1);
    expect(state.endpoints[0]).not.toHaveProperty("secret");
  });

  it("makes a disabled endpoint routable again after enable", async () => {
    const service = new ModelResourceService();
    const provider = await service.createProvider({ name: "Lab", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "none", enabled: true });
    const endpoint = await service.createEndpoint({ name: "Lab endpoint", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: null, enabled: true, data_egress: "local" });
    await service.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    await service.updateModel(provider.id, "model-a", { enabled: true });
    await service.setEndpointEnabled(endpoint.id, false);
    expect(await service.getEndpoint(endpoint.id)).toMatchObject({ enabled: false, health: "blocked" });
    expect((await service.resolveAvailableModels()).find((model) => model.model_id === "model-a")).toMatchObject({ available: false, routes: [] });
    await service.setEndpointEnabled(endpoint.id, true);
    expect(await service.getEndpoint(endpoint.id)).toMatchObject({ enabled: true, health: "unknown", last_error: null });
    const model = (await service.resolveAvailableModels()).find((item) => item.model_id === "model-a");
    expect(model?.available).toBe(true);
    expect(model?.routes[0]?.endpoint_id).toBe(endpoint.id);
  });

  it("accepts a model catalog response a little larger than two MiB", async () => {
    const service = new ModelResourceService();
    const provider = await service.createProvider({ name: "Large catalog", adapter: "openai-compatible", catalog_mode: "hybrid", auth_kind: "api_key", enabled: true });
    const credential = await service.credentials.put({ kind: "api_key", backend: "managed", secret: "catalog-secret" });
    const endpoint = await service.createEndpoint({ name: "Large catalog endpoint", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "local" });
    const binding = await service.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    const payload = JSON.stringify({ data: [{ id: "model-a", metadata: "x".repeat(2 * 1024 * 1024 + 4096) }] });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(payload)).toBeLessThan(8 * 1024 * 1024);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
    }));

    const result = await service.discover(provider.id, binding.id);
    expect(result.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: `${provider.id}/model-a` })]));
  });

  it("creates a custom provider aggregate and discovers its models", async () => {
    const service = new ModelResourceService();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await service.createCustomProvider({ name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", auth: { kind: "api_key", secret: "aggregate-secret" } });
    expect(result.provider).toMatchObject({ id: "user-lab", auth_kind: "api_key" });
    expect(result.endpoint).toMatchObject({ owner_provider_id: "user-lab", credential_ref: result.credential?.id ?? null });
    expect(result.credential?.owner_provider_id).toBe("user-lab");
    expect(result.binding.provider_id).toBe("user-lab");
    expect(result.discovery?.model_count).toBe(2);
    const state = await service.repository.read();
    expect(state.providers).toHaveLength(1);
    expect(state.endpoints).toHaveLength(1);
    expect(state.bindings).toHaveLength(1);
  });

  it("compensates created resources when the aggregate creation fails", async () => {
    const service = new ModelResourceService();
    await expect(
      service.createCustomProvider({ name: "Broken", base_url: "not-a-url", auth: { kind: "api_key", secret: "compensated-secret" } }),
    ).rejects.toThrow();
    expect(await service.credentials.listMetadata()).toEqual([]);
    const state = await service.repository.read();
    expect(state.providers).toHaveLength(0);
    expect(state.endpoints).toHaveLength(0);
    expect(state.bindings).toHaveLength(0);
  });

  it("probes a prospective configuration without persisting anything", async () => {
    const service = new ModelResourceService();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await service.testProviderConfiguration({ protocol: "openai", base_url: "http://127.0.0.1:8100/v1", auth: { kind: "api_key", secret: "probe-secret" } });
    expect(result).toMatchObject({ ok: true, health: "ready" });
    expect(result.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
    const state = await service.repository.read();
    expect(state.providers).toHaveLength(0);
    expect(state.endpoints).toHaveLength(0);
  });

  it("honors the confirmed model selection on aggregate create", async () => {
    const service = new ModelResourceService();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await service.createCustomProvider({ name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", auth: { kind: "api_key", secret: "select-secret" }, models: ["model-a", "model-c"] });
    void result;
    const models = await service.listModels({ provider_id: "user-lab" });
    expect(models.filter((model) => model.enabled).map((model) => model.model_id).sort()).toEqual(["model-a", "model-c"]);
    expect(models.filter((model) => !model.enabled).map((model) => model.model_id).sort()).toEqual(["model-b"]);
  });

  it("deletes a custom provider with its owned endpoint and managed credential", async () => {
    const service = new ModelResourceService();
    const result = await service.createCustomProvider({ name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", auth: { kind: "api_key", secret: "delete-me-secret" } });
    expect(await readFile(join(process.env.PI_SCIENCE_HOME!, "credentials.json"), "utf8")).toContain("delete-me-secret");
    const removed = await service.deleteCustomProvider("user-lab");
    expect(removed).toMatchObject({ removed_endpoints: 1, removed_credentials: 1 });
    const state = await service.repository.read();
    expect(state.providers).toHaveLength(0);
    expect(state.endpoints).toHaveLength(0);
    expect(state.bindings).toHaveLength(0);
    expect(await readFile(join(process.env.PI_SCIENCE_HOME!, "credentials.json"), "utf8")).not.toContain("delete-me-secret");
    void result;
  });

  it("cleans up legacy resources without ownership metadata when deleting", async () => {
    const service = new ModelResourceService();
    // Resources created before ownership metadata existed: no owner field.
    const credential = await service.credentials.put({ kind: "api_key", backend: "managed", secret: "legacy-secret" });
    const provider = await service.createProvider({ name: "Legacy", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
    const endpoint = await service.createEndpoint({ name: "Legacy connection", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "local" });
    await service.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    const removed = await service.deleteCustomProvider(provider.id);
    expect(removed).toMatchObject({ removed_endpoints: 1, removed_credentials: 1 });
    const state = await service.repository.read();
    expect(state.endpoints).toHaveLength(0);
    expect(await service.credentials.listMetadata()).toEqual([]);
    expect(await readFile(join(process.env.PI_SCIENCE_HOME!, "credentials.json"), "utf8")).not.toContain("legacy-secret");
  });

  it("keeps a shared endpoint and its credential when deleting only one provider", async () => {
    const service = new ModelResourceService();
    await service.createCustomProvider({ name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", auth: { kind: "api_key", secret: "shared-secret" } });
    const state = await service.repository.read();
    const endpoint = state.endpoints[0]!;
    const credential = state.endpoints[0]!.credential_ref!;
    const other = await service.createProvider({ name: "Other", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
    // Reuse the endpoint and credential from a provider that does not own them.
    await service.createBinding({ provider_id: other.id, endpoint_id: endpoint.id, enabled: true, priority: 200 });
    const removed = await service.deleteCustomProvider("user-lab");
    expect(removed).toMatchObject({ removed_endpoints: 0, removed_credentials: 0 });
    const after = await service.repository.read();
    expect(after.endpoints.some((item) => item.id === endpoint.id)).toBe(true);
    expect((await service.credentials.metadata(credential))?.id).toBe(credential);
  });

  it("updates a custom provider connection base URL and key", async () => {
    const service = new ModelResourceService();
    await service.createCustomProvider({ name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", auth: { kind: "api_key", secret: "old-secret" } });
    const before = await service.repository.read();
    const endpointId = before.endpoints[0]!.id;
    await service.updateCustomProvider("user-lab", { base_url: "http://127.0.0.1:9000/v1", auth: { kind: "api_key", secret: "new-secret" } });
    const after = await service.repository.read();
    expect(after.endpoints.find((item) => item.id === endpointId)?.base_url).toBe("http://127.0.0.1:9000/v1");
    expect(await readFile(join(process.env.PI_SCIENCE_HOME!, "credentials.json"), "utf8")).not.toContain("old-secret");
    expect(await readFile(join(process.env.PI_SCIENCE_HOME!, "credentials.json"), "utf8")).toContain("new-secret");
  });
});
