import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { registerModelConfigRoutes } from "../http/routes/model-config-routes.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";
import { ModelConfigService } from "./model-config-service.js";
import { nativeProviderViews } from "./provider-config-view.js";
import { agentModels } from "../runtime/agent/worker/agent-models.js";

let root: string;
const app = (resources = new ModelResourceService()) => {
  const server = Fastify();
  registerModelConfigRoutes(server, resources, { reloadConfiguration: vi.fn().mockResolvedValue(undefined) } as unknown as NodeSessionService);
  return server;
};
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-connections-")); vi.stubEnv("PI_SCIENCE_HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("projects per-field capability sources consistently across catalog, provider views and Workers", async () => {
  const service = new ModelConfigService();
  await service.createProvider(0, "lab", { api: "openai-completions", baseUrl: "http://127.0.0.1:9876/v1", models: [{ id: "test", contextWindow: 8192, reasoning: true, discoveredFields: ["contextWindow", "reasoning"] }], modelOverrides: { test: { contextWindow: 128000 } } }, { source: "keyless" });
  const server = app();
  try {
    const before = service.readSync();
    const response = await server.inject("/api/model-config/catalog");
    const model = response.json().providers.find((provider: { id: string }) => provider.id === "lab").models[0];
    expect(model).toMatchObject({ contextWindow: 128000, maxTokens: 16384, capability_sources: { contextWindow: "user_override", maxTokens: "default", reasoning: "declared", thinkingLevelMap: "default" } });
    const view = (await nativeProviderViews()).find((provider) => provider.id === "lab")!.models[0]!;
    expect(view.capabilities.context_window).toBe(model.contextWindow);
    expect(view.capability_sources).toEqual(model.capability_sources);
    expect(agentModels().getModel("lab", "test")?.contextWindow).toBe(model.contextWindow);
    expect(agentModels().getModel("lab", "test")).not.toHaveProperty("discoveredFields");
    expect(agentModels().getModel("lab", "test")?.thinkingLevelMap).toMatchObject({ xhigh: "high", max: "high" });
    expect(service.readSync().config.providers.lab?.models?.[0]).not.toHaveProperty("thinkingLevelMap");
    expect(service.readSync()).toEqual(before);
  } finally { await server.close(); }
});

it("distinguishes explicit broken credentials, keyless and untouched registry entries without exposing secrets", async () => {
  const service = new ModelConfigService();
  await service.update(0, (s) => { s.credential_refs.openai = "missing-credential"; s.config.providers.anthropic = {}; });
  const server = app();
  try {
    const response = await server.inject("/api/model-config/catalog");
    expect(response.statusCode).toBe(200);
    const providers = response.json().providers;
    expect(providers.find((p: { id: string }) => p.id === "openai")).toMatchObject({ configured: true, authentication: { resolved: false }, auth_capabilities: { api_key: true, environment: true, keyless: false, subscription: true } });
    expect(providers.find((p: { id: string }) => p.id === "anthropic")).toMatchObject({ configured: true, authentication: { resolved: false } });
    expect(providers.some((p: { configured: boolean }) => !p.configured)).toBe(true);
    expect(providers.some((p: { auth_capabilities: { subscription: boolean } }) => p.auth_capabilities.subscription)).toBe(true);
    expect((await nativeProviderViews()).find((p) => p.id === "openai")?.configured).toBe(true);
  } finally { await server.close(); }
});

it("atomically creates an explicit environment connection consumed by Workers, and disconnects with revision protection", async () => {
  vi.stubEnv("LAB_CONNECTION_KEY", "secret-never-in-DTO");
  const server = app();
  try {
    const body = { revision: 0, id: "lab", config: { name: "Lab", api: "openai-completions", baseUrl: "http://127.0.0.1:9876/v1", models: [{ id: "test" }] }, credential: { source: "environment", environment_variable: "LAB_CONNECTION_KEY" } };
    expect((await server.inject({ method: "POST", url: "/api/model-config/providers", payload: body })).statusCode).toBe(200);
    const catalog = await server.inject("/api/model-config/catalog");
    expect(catalog.body).not.toContain("secret-never-in-DTO");
    expect(catalog.json().providers.find((p: { id: string }) => p.id === "lab")).toMatchObject({ configured: true, source: "user", authentication: { source: "environment", resolved: true } });
    expect((await agentModels().getAvailable()).map((model) => `${model.provider}/${model.id}`)).toContain("lab/test");
    expect((await server.inject({ method: "DELETE", url: "/api/model-config/providers/lab", payload: { revision: 0 } })).statusCode).toBe(409);
    expect((await server.inject({ method: "DELETE", url: "/api/model-config/providers/lab", payload: { revision: 1 } })).statusCode).toBe(200);
    expect((await agentModels().getAvailable()).map((model) => `${model.provider}/${model.id}`)).not.toContain("lab/test");
    expect((await server.inject({ method: "POST", url: "/api/model-config/providers", payload: { ...body, revision: 2, credential: { source: "environment", environment_variable: "HTTP_PROXY" } } })).statusCode).toBe(400);
    expect(new ModelConfigService().readSync().config.providers.lab).toBeUndefined();
  } finally { await server.close(); }
});

it("discovers models with stored credentials on the server without selecting or persisting candidates", async () => {
  const service = new ModelConfigService();
  await service.createProvider(0, "lab", { name: "Lab", api: "openai-completions", baseUrl: "http://localhost:9876/v1", models: [{ id: "existing" }] }, { source: "managed", secret: "stored-private-key" });
  const resources = new ModelResourceService();
  const discovery = vi.spyOn(resources, "testProviderConfiguration").mockResolvedValue({ models: [{ id: "candidate", display_name: "Candidate", capabilities: { context_window: 200000, max_output_tokens: 32768 } }] } as Awaited<ReturnType<ModelResourceService["testProviderConfiguration"]>>);
  const server = app(resources);
  try {
    const before = service.readSync();
    const response = await server.inject({ method: "POST", url: "/api/model-config/providers/lab/discover", payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ inference_verified: false, models: [{ id: "candidate", capabilities: { context_window: 200000, max_output_tokens: 32768 } }] });
    expect(response.body).not.toContain("stored-private-key");
    expect(discovery).toHaveBeenCalledWith({ base_url: "http://localhost:9876/v1", protocol: "openai", auth: { kind: "api_key", secret: "stored-private-key" } });
    expect(service.readSync()).toEqual(before);
    expect((await server.inject({ method: "POST", url: "/api/model-config/providers/openai/discover", payload: {} })).statusCode).toBe(400);
  } finally { await server.close(); }
});

it("discovers draft connections with managed, environment or keyless auth without persisting credentials", async () => {
  vi.stubEnv("LAB_DRAFT_MODEL_KEY", "server-env-key");
  const resources = new ModelResourceService();
  const discovery = vi.spyOn(resources, "testProviderConfiguration").mockResolvedValue({ models: [{ id: "candidate", display_name: "Candidate", capabilities: {} }] } as Awaited<ReturnType<ModelResourceService["testProviderConfiguration"]>>);
  const server = app(resources), service = new ModelConfigService();
  try {
    const before = service.readSync();
    for (const [credential, auth] of [
      [{ secret: "draft-private-key" }, { kind: "api_key", secret: "draft-private-key" }],
      [{ environment_variable: "LAB_DRAFT_MODEL_KEY" }, { kind: "api_key", secret: "server-env-key" }],
      [{}, { kind: "none" }],
    ]) {
      const response = await server.inject({ method: "POST", url: "/api/model-config/discover", payload: { base_url: "https://models.example/v1", api: "openai-responses", ...credential } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ inference_verified: false, models: [{ id: "candidate" }] });
      expect(response.body).not.toMatch(/draft-private-key|server-env-key/);
      expect(discovery).toHaveBeenLastCalledWith({ base_url: "https://models.example/v1", protocol: "openai", auth });
    }
    expect(service.readSync()).toEqual(before);
    discovery.mockClear();
    for (const credential of [{ environment_variable: "PI_SCIENCE_HOME" }, { environment_variable: "MISSING_MODEL_ENV_KEY" }, { environment_variable: "LAB_DRAFT_MODEL_KEY", secret: "ambiguous" }]) {
      const response = await server.inject({ method: "POST", url: "/api/model-config/discover", payload: { base_url: "https://models.example/v1", api: "openai-completions", ...credential } });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("server-env-key");
    }
    expect(discovery).not.toHaveBeenCalled();
  } finally { await server.close(); }
});
