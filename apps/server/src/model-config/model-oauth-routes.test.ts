import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import { registerModelConfigRoutes } from "../http/routes/model-config-routes.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";
import { ModelConfigService } from "./model-config-service.js";
import { ModelCredentialAdapter } from "./model-credential-adapter.js";

let root: string, app: FastifyInstance;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-oauth-http-")); vi.stubEnv("PI_SCIENCE_HOME", root); app = Fastify();
  registerModelConfigRoutes(app, new ModelResourceService(), { reloadConfiguration: vi.fn().mockResolvedValue(undefined) } as unknown as NodeSessionService);
});
afterEach(async () => { await app.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("uses non-cacheable authenticated interaction DTOs and rejects token injection and stale responses", async () => {
  const rejected = await app.inject({ method: "PUT", url: "/api/model-config/providers/openai/credential", payload: { revision: 0, credential: { source: "oauth", access: "injected-token" } } });
  expect(rejected.statusCode).toBe(400); expect(rejected.body).not.toContain("injected-token");
  const started = await app.inject({ method: "POST", url: "/api/model-config/oauth/openai/start", payload: { revision: 0 } });
  expect(started.statusCode).toBe(200); expect(started.headers["cache-control"]).toBe("no-store");
  let prompt: { id: string } | undefined;
  await vi.waitFor(async () => { const response = await app.inject("/api/model-config/oauth/openai/current"); expect(response.headers["cache-control"]).toBe("no-store"); prompt = response.json().session.prompt; expect(prompt).toBeDefined(); });
  const id = started.json().id;
  const response = await app.inject({ method: "DELETE", url: `/api/model-config/oauth/sessions/${id}` });
  expect(response.json().status).toBe("cancelled");
  const stale = await app.inject({ method: "POST", url: `/api/model-config/oauth/sessions/${id}/respond`, payload: { prompt_id: prompt!.id, value: "private-code" } });
  expect(stale.statusCode).toBe(409); expect(stale.body).not.toContain("private-code");
  expect(new ModelConfigService().readSync().revision).toBe(0);
});
it("refreshes and disconnects a stored grant with revision protection while preserving unrelated credentials", async () => {
  const service = new ModelConfigService();
  await service.credentials.put({ id: "mcp-owned", kind: "api_key", backend: "managed", secret: "unrelated-mcp-secret", owner_kind: "mcp" });
  await service.setOAuthCredential("openai", 0, { type: "oauth", access: "old-access", refresh: "provider-refresh", expires: Date.now() - 1000, clientId: "registered-client" });
  const worker = new ModelCredentialAdapter(service, service.readSync());
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: "chatgpt.tokens.use.direct" })));
  const refreshed = await app.inject({ method: "POST", url: "/api/model-config/oauth/openai/refresh", payload: { revision: 1 } });
  expect(refreshed.statusCode).toBe(200); expect(refreshed.body).not.toMatch(/fresh-access|rotated-refresh|unrelated-mcp-secret/);
  expect(refreshed.json().provider.authentication).toMatchObject({ source: "oauth", resolved: true }); expect(service.readSync().revision).toBe(1);
  expect((await app.inject({ method: "DELETE", url: "/api/model-config/oauth/openai", payload: { revision: 0 } })).statusCode).toBe(409);
  expect((await app.inject({ method: "DELETE", url: "/api/model-config/oauth/openai", payload: { revision: 1 } })).statusCode).toBe(200);
  expect(await worker.read("openai")).toBeUndefined(); expect((await service.credentials.getForRuntime("mcp-owned"))?.secret).toBe("unrelated-mcp-secret");
  expect(await service.view("openai")).toMatchObject({ configured: true, authentication: { source: "unconfigured", resolved: false } });
});
it("rejects OAuth on arbitrary provider endpoints and on unsupported API-only providers", async () => {
  const service = new ModelConfigService();
  await service.update(0, (s) => { s.config.providers.openai = { baseUrl: "http://127.0.0.1:9999/v1" }; });
  expect((await app.inject({ method: "POST", url: "/api/model-config/oauth/openai/start", payload: { revision: 1 } })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/api/model-config/oauth/deepseek/start", payload: { revision: 1 } })).statusCode).toBe(400);
});

it("rejects endpoint edits after OAuth is connected and fails closed for a tampered Worker snapshot", async () => {
  const service = new ModelConfigService();
  await service.setOAuthCredential("openai", 0, { type: "oauth", access: "protected-oauth-access", refresh: "refresh", expires: Date.now() + 3600000 });
  const edited = await app.inject({ method: "PATCH", url: "/api/model-config/providers/openai", payload: { revision: 1, config: { baseUrl: "http://127.0.0.1:9999/v1" } } });
  expect(edited.statusCode).toBe(400); expect(service.readSync().revision).toBe(1);
  const snapshot = service.readSync(); snapshot.config.providers.openai = { baseUrl: "http://127.0.0.1:9999/v1" };
  const { ModelRegistryService } = await import("./model-registry-service.js");
  expect(() => new ModelRegistryService(service).compile(snapshot)).toThrow("overridden endpoint");
});
