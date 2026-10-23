import rateLimit from "@fastify/rate-limit";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { modelCapabilitySources, modelConfigSchema, providerConfigSchema } from "@pi-science/contracts";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { ModelConfigService, configError, isAllowedModelEnvRef, modelConfigBackend } from "../../model-config/model-config-service.js";
import { ModelConfigMigration } from "../../model-config/model-config-migration.js";
import { ModelRegistryService } from "../../model-config/model-registry-service.js";
import { ModelOAuthService } from "../../model-config/model-oauth-service.js";
import { ModelCredentialAdapter } from "../../model-config/model-credential-adapter.js";

const revision = z.number().int().nonnegative();
const credentialInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("managed"), secret: z.string().min(1).max(16000) }).strict(),
  z.object({ source: z.literal("environment"), environment_variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ source: z.literal("keyless") }).strict(), z.object({ source: z.literal("remove") }).strict(),
]);

export function registerModelConfigRoutes(app: FastifyInstance, resources: ModelResourceService, sessions: NodeSessionService) {
  const service = new ModelConfigService();
  const migration = new ModelConfigMigration(service, resources.repository);
  const fail = (reply: FastifyReply, error: unknown) => {
    const code = (error as { code?: string }).code ?? "invalid_config";
    // Never echo a rejected config/secret or upstream error payload.
    return reply.code(code === "revision_conflict" || code === "legacy_route" || code === "import_blocked" || code === "oauth_busy" || code === "oauth_prompt_conflict" || code === "auth_replacement_required" ? 409 : 400).send({ code, error: code === "revision_conflict" ? "Configuration changed; reload before saving" : "Model configuration request failed validation",
      ...(error instanceof z.ZodError ? { fields: error.issues.map((issue) => ({ path: issue.path, code: issue.code })) } : {}) });
  };
  const publish = async (snapshot: { revision: number }) => {
    try { await sessions.reloadConfiguration(); return { ok: true, revision: snapshot.revision, runtime: "published", busy_workers: "after_current_turn" }; }
    catch { return { ok: true, revision: snapshot.revision, runtime: "reload_pending" }; }
  };
  const oauth = new ModelOAuthService(service, { published: async (revision) => (await publish({ revision })).runtime as "published" | "reload_pending" });
  app.addHook("onClose", async () => oauth.close());
  app.register(async (authorization) => {
    await authorization.register(rateLimit, { global: false });
    authorization.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    authorization.post<{ Params: { id: string } }>("/api/model-config/oauth/:id/start", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (request, reply) => {
      try { const body = z.object({ revision, replace_existing: z.boolean().default(false) }).strict().parse(request.body); return await oauth.start(request.params.id, body.revision, body.replace_existing); } catch (error) { return fail(reply, error); }
    });
    authorization.get<{ Params: { id: string } }>("/api/model-config/oauth/:id/current", async (request, reply) => {
      try { return { session: oauth.current(request.params.id) }; } catch (error) { return fail(reply, error); }
    });
    authorization.get<{ Params: { id: string } }>("/api/model-config/oauth/sessions/:id", async (request, reply) => {
      try { return oauth.get(request.params.id); } catch (error) { return fail(reply, error); }
    });
    authorization.post<{ Params: { id: string } }>("/api/model-config/oauth/sessions/:id/respond", async (request, reply) => {
      try { const body = z.object({ prompt_id: z.string().uuid(), value: z.string().max(16000) }).strict().parse(request.body); return oauth.respond(request.params.id, body.prompt_id, body.value); } catch (error) { return fail(reply, error); }
    });
    authorization.delete<{ Params: { id: string } }>("/api/model-config/oauth/sessions/:id", async (request, reply) => {
      try { return oauth.cancel(request.params.id); } catch (error) { return fail(reply, error); }
    });
    authorization.post<{ Params: { id: string } }>("/api/model-config/oauth/:id/refresh", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (request, reply) => {
      try {
        const body = z.object({ revision }).strict().parse(request.body), snapshot = service.readSync(), id = request.params.id;
        if (snapshot.revision !== body.revision) throw configError("revision_conflict", "Configuration changed");
        const auth = builtinModels().getProvider(id)?.auth.oauth;
        if (!auth?.isSubscription) throw configError("unsupported_auth", "Subscription authentication is unavailable");
        const adapter = new ModelCredentialAdapter(service, snapshot);
        const result = await adapter.modify(id, async (current) => {
          if (current?.type !== "oauth") throw configError("unsupported_auth", "No subscription grant");
          return auth.refresh(current, AbortSignal.timeout(15000));
        });
        if (result?.type !== "oauth") throw configError("revision_conflict", "Authorization changed");
        return { ok: true, provider: await service.view(id) };
      } catch (error) { return fail(reply, error); }
    });
    authorization.delete<{ Params: { id: string } }>("/api/model-config/oauth/:id", async (request, reply) => {
      try {
        const body = z.object({ revision }).strict().parse(request.body);
        if ((await service.view(request.params.id)).authentication.source !== "oauth") throw configError("unsupported_auth", "No subscription grant");
        return publish(await service.setCredential(request.params.id, body.revision, { source: "remove" }));
      } catch (error) { return fail(reply, error); }
    });
  });
  app.get("/api/model-config", async (_request, reply) => {
    try { const snapshot = service.readSync(); return { backend: modelConfigBackend(), ...snapshot,
      providers: await Promise.all(Object.keys(snapshot.config.providers).map((id) => service.view(id, snapshot))) }; }
    catch (error) { return fail(reply, error); }
  });
  app.get("/api/model-config/catalog", async (_request, reply) => {
    try {
      const snapshot = service.readSync();
      const models = new ModelRegistryService(service).compile(snapshot);
      const builtin = builtinModels();
      const available = new Set((await models.getAvailable()).map((model) => `${model.provider}/${model.id}`));
      const providers = await Promise.all(models.getProviders().map(async (provider) => {
        const view = await service.view(provider.id, snapshot);
        return {
        ...view, editable: Boolean(provider.auth.apiKey), name: snapshot.config.providers[provider.id]?.name ?? provider.name,
        source: builtin.getProvider(provider.id) ? "builtin" : "user",
        auth_capabilities: { api_key: Boolean(provider.auth.apiKey), environment: Boolean(provider.auth.apiKey), keyless: !builtin.getProvider(provider.id), subscription: Boolean(provider.auth.oauth?.isSubscription) },
        subscription_name: provider.auth.oauth?.isSubscription ? provider.auth.oauth.name : undefined,
        allowed_actions: view.authentication.source === "oauth" ? ["subscription", "disconnect"] : ["details", ...(provider.auth.apiKey ? ["credential"] : []), ...(!builtin.getProvider(provider.id) ? ["edit", "refresh"] : []), "disconnect"],
        models: provider.getModels().map((model) => {
          const config = snapshot.config.providers[provider.id];
          const declared = config?.models?.find((entry) => entry.id === model.id);
          const override = config?.modelOverrides?.[model.id];
          const known = builtin.getModel(provider.id, model.id);
          const reasoningKnown = Boolean(known) || declared?.reasoning !== undefined || override?.reasoning !== undefined;
          return { id: model.id, name: model.name, available: available.has(`${provider.id}/${model.id}`),
            contextWindow: model.contextWindow, maxTokens: model.maxTokens,
            capability_sources: modelCapabilitySources(config, model.id, Boolean(known)),
            reasoning: reasoningKnown ? model.reasoning : null, thinking_levels: reasoningKnown ? getSupportedThinkingLevels(model) : null,
            input: known ? model.input : override?.input ?? declared?.input ?? null,
            source: declared || override ? "configured" : known ? "pi-ai" : "unknown" };
        }),
      }; }));
      return { revision: snapshot.revision, providers };
    } catch (error) { return fail(reply, error); }
  });
  app.post("/api/model-config/preview", async (request, reply) => {
    try { const config = modelConfigSchema.parse(request.body); await service.preflight(config, service.readSync().config); return { valid: true, config }; }
    catch (error) { return fail(reply, error); }
  });
  app.put("/api/model-config", async (request, reply) => {
    try { const body = z.object({ revision, config: modelConfigSchema }).strict().parse(request.body); return publish(await service.replace(body.revision, body.config)); }
    catch (error) { return fail(reply, error); }
  });
  app.post("/api/model-config/providers", async (request, reply) => {
    try {
      const body = z.object({ revision, id: z.string().min(1), config: providerConfigSchema,
        credential: z.discriminatedUnion("source", [z.object({ source: z.literal("managed"), secret: z.string().min(1).max(16000) }).strict(), z.object({ source: z.literal("environment"), environment_variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(), z.object({ source: z.literal("keyless") }).strict()]).optional(),
      }).strict().parse(request.body);
      return publish(await service.createProvider(body.revision, body.id, body.config, body.credential));
    } catch (error) { return fail(reply, error); }
  });
  app.get<{ Params: { id: string } }>("/api/model-config/providers/:id", async (request, reply) => {
    try {
      return service.view(request.params.id);
    } catch (error) { return fail(reply, error); }
  });
  app.patch<{ Params: { id: string } }>("/api/model-config/providers/:id", async (request, reply) => {
    try {
      const body = z.object({ revision, config: providerConfigSchema }).strict().parse(request.body);
      return publish(await service.update(body.revision, (snapshot) => {
        if (!snapshot.config.providers[request.params.id]) throw configError("legacy_route", "Provider is not configured");
        snapshot.config.providers[request.params.id] = body.config;
      }));
    } catch (error) { return fail(reply, error); }
  });
  app.delete<{ Params: { id: string } }>("/api/model-config/providers/:id", async (request, reply) => {
    try {
      const body = z.object({ revision }).strict().parse(request.body);
      return publish(await service.update(body.revision, (snapshot) => {
        delete snapshot.config.providers[request.params.id]; delete snapshot.credential_refs[request.params.id];
        snapshot.keyless_providers = snapshot.keyless_providers.filter((id) => id !== request.params.id);
      }));
    } catch (error) { return fail(reply, error); }
  });
  app.put<{ Params: { id: string } }>("/api/model-config/providers/:id/credential", async (request, reply) => {
    try {
      const body = z.object({ revision, credential: credentialInput }).strict().parse(request.body);
      const snapshot = await service.setCredential(request.params.id, body.revision, body.credential);
      return { ...await publish(snapshot), provider: await service.view(request.params.id, snapshot) };
    } catch (error) { return fail(reply, error); }
  });
  app.register(async (discovery) => {
    await discovery.register(rateLimit, { global: false });
    discovery.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    discovery.post<{ Params: { id: string } }>("/api/model-config/providers/:id/discover", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
      try {
        z.object({}).strict().parse(request.body ?? {});
        const snapshot = service.readSync(), id = request.params.id, provider = snapshot.config.providers[id];
        if (builtinModels().getProvider(id) || !provider?.baseUrl || !provider.api || !(await service.view(id, snapshot)).authentication.resolved) throw configError("invalid_config", "A configured custom connection is required");
        const credential = await new ModelCredentialAdapter(service, snapshot).read(id);
        const result = await resources.testProviderConfiguration({ base_url: provider.baseUrl, protocol: provider.api === "anthropic-messages" ? "anthropic" : "openai", auth: credential?.type === "api_key" ? { kind: "api_key", secret: credential.key } : { kind: "none" } });
        return { models: result.models, inference_verified: false };
      } catch (error) { return fail(reply, error); }
    });
    discovery.post("/api/model-config/discover", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    try {
      const body = z.object({ base_url: z.string().url(), api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]), secret: z.string().max(16000).optional(), environment_variable: z.string().optional() }).strict()
        .refine((value) => value.secret === undefined || value.environment_variable === undefined).parse(request.body);
      let secret = body.secret;
      if (body.environment_variable !== undefined) {
        if (!isAllowedModelEnvRef(body.environment_variable) || !process.env[body.environment_variable]) throw configError("invalid_config", "Environment reference is reserved or missing");
        secret = process.env[body.environment_variable];
      }
      const result = await resources.testProviderConfiguration({ base_url: body.base_url, protocol: body.api === "anthropic-messages" ? "anthropic" : "openai", auth: secret ? { kind: "api_key", secret } : { kind: "none" } });
      return { models: result.models, inference_verified: false };
    } catch (error) { return fail(reply, error); }
  });
  });
  app.get("/api/model-config/migration", async (_request, reply) => {
    try { const { snapshot: _snapshot, ...report } = await migration.plan(); return report; }
    catch (error) { return fail(reply, error); }
  });
  app.post("/api/model-config/migration", async (request, reply) => {
    try { const body = z.object({ revision, source_revision: z.string().length(64), excluded_provider_ids: z.array(z.string()).default([]) }).strict().parse(request.body); return { ...await migration.apply(body.revision, body.source_revision, body.excluded_provider_ids), ...await publish(service.readSync()) }; }
    catch (error) { return fail(reply, error); }
  });
  // Tombstones run before validation, discovery, or mutation. No legacy CRUD is registered.
  for (const path of ["providers", "models", "endpoints", "credentials", "provider-endpoint-bindings", "custom-providers", "settings/api-key", "settings/custom-providers", "model-config/shadow"]) {
    for (const url of [`/api/${path}`, `/api/${path}/*`]) app.all(url, async (_request, reply) => reply.code(410).send({ code: "model_config_retired", error: "Use /api/model-config; old model configuration is no longer active" }));
  }
}
