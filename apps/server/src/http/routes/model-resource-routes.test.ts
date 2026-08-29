import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { registerModelEndpointRoutes } from "./model-endpoint-routes.js";
import { registerModelResourceRoutes } from "./model-resource-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { SettingsStore } from "../../storage/settings-store.js";

const roots: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-model-resource-routes-"));
  roots.push(root);
  process.env.PI_SCIENCE_HOME = root;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("model resource routes", () => {
  it("switches an aggregate provider to no authentication", async () => {
    const reloadConfiguration = vi.fn().mockResolvedValue([]);
    const session = { reloadConfiguration } as unknown as NodeSessionService;
    const service = new ModelResourceService();
    const app = Fastify({ logger: false });
    registerModelResourceRoutes(app, service, session);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200, headers: { "content-type": "application/json" } }));

    const created = await app.inject({ method: "POST", url: "/api/custom-providers", payload: { name: "Lab", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", allow_private: true, auth: { kind: "api_key", secret: "route-secret" } } });
    expect(created.statusCode).toBe(200);
    const providerId = created.json().provider.id as string;
    const credentialId = created.json().credential.id as string;

    const updated = await app.inject({ method: "PUT", url: `/api/custom-providers/${providerId}`, payload: { auth: { kind: "none" } } });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ provider: { auth_kind: "none" }, endpoint: { credential_ref: null } });
    expect(await service.credentials.metadata(credentialId)).toBeNull();
  });

  it("runs provider → credential → endpoint → binding → discovery and fails closed when disabled", async () => {
    const reloadConfiguration = vi.fn().mockResolvedValue([]);
    const session = { reloadConfiguration } as unknown as NodeSessionService;
    const service = new ModelResourceService();
    const app = Fastify({ logger: false });
    registerModelResourceRoutes(app, service, session);
    registerModelEndpointRoutes(app, { service, nodeSessionService: session });
    registerSettingsRoutes(app, session, new SettingsStore(), service);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toContain("/models");
      return new Response(JSON.stringify({ data: [{ id: "model-a", context_window: 131072, reasoning: true, thinking_levels: ["off", "high"] }] }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const provider = await app.inject({ method: "POST", url: "/api/providers", payload: { name: "Lab", adapter: "openai-compatible", catalog_mode: "hybrid", auth_kind: "api_key" } });
    expect(provider.statusCode).toBe(200);
    const providerId = provider.json().provider.id as string;
    const credential = await app.inject({ method: "POST", url: "/api/credentials", payload: { kind: "api_key", backend: "managed", secret: "route-secret", label: "Lab key" } });
    expect(credential.statusCode).toBe(200);
    expect(credential.body).not.toContain("route-secret");
    const credentialId = credential.json().credential.id as string;
    const endpoint = await app.inject({ method: "POST", url: "/api/endpoints", payload: { name: "Lab connection", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: credentialId, data_egress: "local", network_policy: { allow_private: true } } });
    expect(endpoint.statusCode).toBe(200);
    const endpointId = endpoint.json().endpoint.id as string;
    const binding = await app.inject({ method: "POST", url: "/api/provider-endpoint-bindings", payload: { provider_id: providerId, endpoint_id: endpointId, priority: 10, enabled: true } });
    expect(binding.statusCode).toBe(200);
    const bindingId = binding.json().binding.id as string;

    const discovered = await app.inject({ method: "POST", url: `/api/providers/${providerId}/discover`, payload: { binding_id: bindingId } });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: `${providerId}/model-a`, available: true, capability_source: "discovery" })]));

    const available = await app.inject({ method: "GET", url: "/api/models?available=true" });
    expect(available.statusCode).toBe(200);
    expect(available.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: `${providerId}/model-a`, available: true, routes: [expect.objectContaining({ binding_id: bindingId, priority: 10 })] })]));

    const selected = await app.inject({ method: "PUT", url: "/api/settings/model", payload: { model: `${providerId}/model-a`, thinking: "high" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ ok: true, model: `${providerId}/model-a` });

    const disabled = await app.inject({ method: "PUT", url: `/api/endpoints/${endpointId}/enabled?enabled=false` });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ endpoint: { enabled: false, health: "blocked" } });
    const unavailable = await app.inject({ method: "GET", url: `/api/models?provider_id=${providerId}` });
    expect(unavailable.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: `${providerId}/model-a`, available: false, availability_reason: "disabled_endpoint" })]));
    reloadConfiguration.mockClear();
    const probed = await app.inject({ method: "POST", url: `/api/endpoints/${endpointId}/health` });
    expect(probed.statusCode).toBe(200);
    expect(reloadConfiguration).toHaveBeenCalledTimes(1);
  });
});
