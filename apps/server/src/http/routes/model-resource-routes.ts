import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createBindingRequestSchema,
  createCredentialRequestSchema,
  createProviderRequestSchema,
  updateBindingRequestSchema,
  updateCredentialRequestSchema,
  updateProviderRequestSchema,
} from "@pi-science/contracts";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";

function errorStatus(code: string): number {
  if (code === "resource_not_found") return 404;
  if (code === "resource_in_use" || code === "provider_id_conflict") return 409;
  if (code === "discovery_empty" || code === "no_routable_endpoint") return 422;
  if (code === "endpoint_probe_failed" || code === "runtime_reload_failed") return 502;
  return 400;
}

function routeError(reply: FastifyReply, error: unknown): FastifyReply {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "invalid_resource";
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(errorStatus(code)).send({ code, error: message });
}

async function reload<T extends Record<string, unknown>>(service: NodeSessionService, reply: FastifyReply, payload: T): Promise<T | FastifyReply> {
  try { return { ...payload, session_replacements: await service.reloadConfiguration() }; }
  catch (error) { return reply.code(502).send({ ok: false, code: "runtime_reload_failed", error: `Resources were saved, but Pi runtime reload failed: ${error instanceof Error ? error.message : String(error)}` }); }
}

function queryValue(request: { query: unknown }, name: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[name];
  return typeof value === "string" && value ? value : undefined;
}

/** Canonical Provider/Model/Binding/Credential HTTP surface. Endpoint CRUD is
 * kept in model-endpoint-routes.ts so its old response aliases can remain
 * available during the migration window. */
export function registerModelResourceRoutes(app: FastifyInstance, resources: ModelResourceService, nodeSessionService: NodeSessionService): void {
  app.get("/api/providers", async (_request, reply) => {
    try { return { providers: await resources.listProviders() }; }
    catch (error) { return routeError(reply, error); }
  });

  app.get<{ Params: { provider_id: string } }>("/api/providers/:provider_id", async (request, reply) => {
    try { return { provider: await resources.getProvider(request.params.provider_id) }; }
    catch (error) { return routeError(reply, error); }
  });

  app.post("/api/providers", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, provider: await resources.createProvider(createProviderRequestSchema.parse(request.body ?? {})) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.put<{ Params: { provider_id: string } }>("/api/providers/:provider_id", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, provider: await resources.updateProvider(request.params.provider_id, updateProviderRequestSchema.parse(request.body ?? {})) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.delete<{ Params: { provider_id: string } }>("/api/providers/:provider_id", async (request, reply) => {
    try {
      const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
      const cascade = queryValue(request, "cascade") === "true" || body.cascade === true;
      return await reload(nodeSessionService, reply, { ok: true, ...(await resources.deleteProvider(request.params.provider_id, cascade)) });
    } catch (error) { return routeError(reply, error); }
  });

  app.post<{ Params: { provider_id: string } }>("/api/providers/:provider_id/discover", async (request, reply) => {
    try {
      const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
      return await reload(nodeSessionService, reply, { ok: true, ...(await resources.discover(request.params.provider_id, typeof body.binding_id === "string" ? body.binding_id : undefined)) });
    } catch (error) { return routeError(reply, error); }
  });

  app.get("/api/models", async (request, reply) => {
    try {
      const availableRaw = queryValue(request, "available");
      const available = availableRaw === undefined ? undefined : availableRaw === "true";
      return { models: await resources.listModels({ provider_id: queryValue(request, "provider_id"), available }) };
    } catch (error) { return routeError(reply, error); }
  });

  app.get<{ Params: { provider_id: string; model_id: string } }>("/api/models/:provider_id/:model_id", async (request, reply) => {
    try { return { model: await resources.getModel(request.params.provider_id, request.params.model_id) }; }
    catch (error) { return routeError(reply, error); }
  });

  app.put<{ Params: { provider_id: string; model_id: string } }>("/api/models/:provider_id/:model_id", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, model: await resources.updateModel(request.params.provider_id, request.params.model_id, request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {}) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.delete<{ Params: { provider_id: string; model_id: string } }>("/api/models/:provider_id/:model_id", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, ...(await resources.deleteModel(request.params.provider_id, request.params.model_id)) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.get("/api/provider-endpoint-bindings", async (request, reply) => {
    try { return { bindings: await resources.listBindings({ provider_id: queryValue(request, "provider_id"), endpoint_id: queryValue(request, "endpoint_id") }) }; }
    catch (error) { return routeError(reply, error); }
  });

  app.post("/api/provider-endpoint-bindings", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, binding: await resources.createBinding(createBindingRequestSchema.parse(request.body ?? {})) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.put<{ Params: { binding_id: string } }>("/api/provider-endpoint-bindings/:binding_id", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, binding: await resources.updateBinding(request.params.binding_id, updateBindingRequestSchema.parse(request.body ?? {})) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.delete<{ Params: { binding_id: string } }>("/api/provider-endpoint-bindings/:binding_id", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, ...(await resources.deleteBinding(request.params.binding_id)) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.get("/api/credentials", async (_request, reply) => {
    try { return { credentials: await resources.credentials.listMetadata() }; }
    catch (error) { return routeError(reply, error); }
  });

  app.post("/api/credentials", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, credential: await resources.credentials.put(createCredentialRequestSchema.parse(request.body ?? {})) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.put<{ Params: { credential_id: string } }>("/api/credentials/:credential_id", async (request, reply) => {
    try { return await reload(nodeSessionService, reply, { ok: true, credential: await resources.credentials.put({ ...updateCredentialRequestSchema.parse(request.body ?? {}), id: request.params.credential_id }) }); }
    catch (error) { return routeError(reply, error); }
  });

  app.delete<{ Params: { credential_id: string } }>("/api/credentials/:credential_id", async (request, reply) => {
    try {
      await resources.ensureMigrated();
      const state = await resources.repository.read();
      if (state.endpoints.some((endpoint) => endpoint.credential_ref === request.params.credential_id)) return reply.code(409).send({ code: "resource_in_use", error: `Credential '${request.params.credential_id}' is still referenced by an endpoint` });
      const removed = await resources.credentials.remove(request.params.credential_id);
      if (!removed) return reply.code(404).send({ code: "resource_not_found", error: `Credential '${request.params.credential_id}' was not found` });
      return await reload(nodeSessionService, reply, { ok: true, credential_id: request.params.credential_id });
    } catch (error) { return routeError(reply, error); }
  });

  app.post<{ Params: { credential_id: string } }>("/api/credentials/:credential_id/validate", async (request, reply) => {
    try { return { ok: true, credential: await resources.credentials.validate(request.params.credential_id) }; }
    catch (error) { return routeError(reply, error); }
  });

  /** Aggregate surface for the user-facing custom provider: one call creates
   *  the credential/endpoint/provider/binding and discovers models. */
  app.post("/api/custom-providers", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = String(body.name ?? "").trim();
      const baseUrl = String(body.base_url ?? "").trim();
      if (!name || !baseUrl) return reply.code(400).send({ code: "invalid_resource", error: "name and base_url are required" });
      const protocol = body.protocol === "anthropic" || body.protocol === "ollama" || body.protocol === "native" ? body.protocol : "openai";
      const api = body.api && typeof body.api === "string" ? body.api as "openai-completions" | "openai-responses" | "anthropic-messages" | "ollama" | "native" : undefined;
      const dataEgress = body.data_egress === "local" || body.data_egress === "remote" ? body.data_egress : undefined;
      const auth = body.auth && typeof body.auth === "object" ? body.auth as Record<string, unknown> : null;
      const authKind = auth?.kind === "none" ? "none" : auth?.kind === "api_key" ? "api_key" : null;
      if (authKind === null) return reply.code(400).send({ code: "invalid_resource", error: "auth.kind must be api_key or none" });
      const secret = auth?.secret && typeof auth.secret === "string" ? auth.secret : undefined;
      if (authKind === "api_key" && !secret) return reply.code(400).send({ code: "invalid_resource", error: "auth.secret is required for api_key auth" });
      const models = Array.isArray(body.models) ? body.models.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : undefined;
      const result = await resources.createCustomProvider({ name, base_url: baseUrl, protocol: protocol as "openai" | "anthropic" | "ollama" | "native", api, data_egress: dataEgress, auth: { kind: authKind, ...(secret ? { secret } : {}) }, ...(models ? { models } : {}) });
      return await reload(nodeSessionService, reply, { ok: true, ...result });
    } catch (error) { return routeError(reply, error); }
  });

  /** Probe a prospective configuration; nothing is persisted. */
  app.post("/api/custom-providers/test", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const baseUrl = String(body.base_url ?? "").trim();
      if (!baseUrl) return reply.code(400).send({ code: "invalid_resource", error: "base_url is required" });
      const protocol = body.protocol === "anthropic" || body.protocol === "ollama" || body.protocol === "native" ? body.protocol : "openai";
      const api = body.api && typeof body.api === "string" ? body.api as "openai-completions" | "openai-responses" | "anthropic-messages" | "ollama" | "native" : undefined;
      const auth = body.auth && typeof body.auth === "object" ? body.auth as Record<string, unknown> : null;
      const authKind = auth?.kind === "none" ? "none" : auth?.kind === "api_key" ? "api_key" : null;
      const secret = auth?.secret && typeof auth.secret === "string" ? auth.secret : undefined;
      const result = await resources.testProviderConfiguration({ protocol: protocol as "openai" | "anthropic" | "ollama" | "native", base_url: baseUrl, api, auth: authKind ? { kind: authKind, ...(secret ? { secret } : {}) } : null });
      return { ...result };
    } catch (error) { return routeError(reply, error); }
  });

  app.post<{ Params: { provider_id: string } }>("/api/custom-providers/:provider_id/refresh-models", async (request, reply) => {
    try {
      const discovered = await resources.discover(request.params.provider_id);
      return await reload(nodeSessionService, reply, { ok: true, model_count: discovered.models.length, models: discovered.models });
    } catch (error) { return routeError(reply, error); }
  });

  app.put<{ Params: { provider_id: string } }>("/api/custom-providers/:provider_id/enabled", async (request, reply) => {
    try {
      const enabled = String((request.query as Record<string, unknown>).enabled ?? "") !== "false";
      const provider = await resources.updateProvider(request.params.provider_id, { enabled });
      return await reload(nodeSessionService, reply, { ok: true, provider });
    } catch (error) { return routeError(reply, error); }
  });

  app.put<{ Params: { provider_id: string } }>("/api/custom-providers/:provider_id/models", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const enabledSet = new Set(Array.isArray(body.enabled) ? body.enabled.filter((item): item is string => typeof item === "string") : []);
      const state = await resources.repository.read();
      const provider = state.providers.find((item) => item.id === request.params.provider_id);
      if (!provider) return reply.code(404).send({ code: "resource_not_found", error: `Provider '${request.params.provider_id}' was not found` });
      for (const model of state.models.filter((item) => item.provider_id === provider.id)) {
        if (model.enabled !== enabledSet.has(model.model_id)) await resources.updateModel(provider.id, model.model_id, { enabled: enabledSet.has(model.model_id) });
      }
      return await reload(nodeSessionService, reply, { ok: true, models: await resources.listModels({ provider_id: provider.id }) });
    } catch (error) { return routeError(reply, error); }
  });

  app.put<{ Params: { provider_id: string } }>("/api/custom-providers/:provider_id", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = body.name && typeof body.name === "string" ? body.name.trim() : undefined;
      const baseUrl = body.base_url && typeof body.base_url === "string" ? body.base_url.trim() : undefined;
      const api = body.api && typeof body.api === "string" ? body.api as "openai-completions" | "openai-responses" | "anthropic-messages" | "ollama" | "native" : undefined;
      const auth = body.auth && typeof body.auth === "object" ? body.auth as Record<string, unknown> : null;
      const authKind = auth?.kind === "none" ? "none" : auth?.kind === "api_key" ? "api_key" : null;
      if (body.auth !== undefined && authKind === null) return reply.code(400).send({ code: "invalid_resource", error: "auth.kind must be api_key or none" });
      const secret = auth?.secret && typeof auth.secret === "string" ? auth.secret : undefined;
      if (authKind === "api_key" && !secret) return reply.code(400).send({ code: "invalid_resource", error: "auth.secret is required for api_key auth" });
      if (!name && !baseUrl && !api && !authKind) return reply.code(400).send({ code: "invalid_resource", error: "nothing to update" });
      const result = await resources.updateCustomProvider(request.params.provider_id, { ...(name ? { name } : {}), ...(baseUrl ? { base_url: baseUrl } : {}), ...(api ? { api } : {}), ...(authKind ? { auth: { kind: authKind, ...(secret ? { secret } : {}) } } : {}) });
      return await reload(nodeSessionService, reply, { ok: true, ...result });
    } catch (error) { return routeError(reply, error); }
  });

  app.delete<{ Params: { provider_id: string } }>("/api/custom-providers/:provider_id", async (request, reply) => {
    try {
      const result = await resources.deleteCustomProvider(request.params.provider_id);
      return await reload(nodeSessionService, reply, { ok: true, ...result });
    } catch (error) { return routeError(reply, error); }
  });

  app.get("/api/settings/model", async (_request, reply) => {
    try { return await resources.modelPreferences(); }
    catch (error) { return routeError(reply, error); }
  });
}
