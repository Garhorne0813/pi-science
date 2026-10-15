import rateLimit from "@fastify/rate-limit";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { modelConfigSchema, providerConfigSchema } from "@pi-science/contracts";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { ModelConfigService, configError, modelConfigBackend } from "../../model-config/model-config-service.js";
import { ModelConfigMigration } from "../../model-config/model-config-migration.js";
import { ModelRegistryService } from "../../model-config/model-registry-service.js";

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
    return reply.code(code === "revision_conflict" || code === "legacy_route" || code === "import_blocked" ? 409 : 400).send({ code, error: code === "revision_conflict" ? "Configuration changed; reload before saving" : "Model configuration request failed validation",
      ...(error instanceof z.ZodError ? { fields: error.issues.map((issue) => ({ path: issue.path, code: issue.code })) } : {}) });
  };
  const publish = async (snapshot: { revision: number }) => {
    try { await sessions.reloadConfiguration(); return { ok: true, revision: snapshot.revision, runtime: "published", busy_workers: "after_current_turn" }; }
    catch { return { ok: true, revision: snapshot.revision, runtime: "reload_pending" }; }
  };
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
      const providers = await Promise.all(models.getProviders().map(async (provider) => ({
        ...await service.view(provider.id, snapshot), editable: Boolean(provider.auth.apiKey), name: snapshot.config.providers[provider.id]?.name ?? provider.name,
        models: provider.getModels().map((model) => {
          const config = snapshot.config.providers[provider.id];
          const declared = config?.models?.find((entry) => entry.id === model.id);
          const override = config?.modelOverrides?.[model.id];
          const known = builtin.getModel(provider.id, model.id);
          const reasoningKnown = Boolean(known) || declared?.reasoning !== undefined || override?.reasoning !== undefined;
          return { id: model.id, name: model.name, available: available.has(`${provider.id}/${model.id}`),
            contextWindow: known ? model.contextWindow : override?.contextWindow ?? declared?.contextWindow ?? null,
            maxTokens: known ? model.maxTokens : override?.maxTokens ?? declared?.maxTokens ?? null,
            reasoning: reasoningKnown ? model.reasoning : null, thinking_levels: reasoningKnown ? getSupportedThinkingLevels(model) : null,
            input: known ? model.input : override?.input ?? declared?.input ?? null,
            source: declared || override ? "configured" : known ? "pi-ai" : "unknown" };
        }),
      })));
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
        credential: z.discriminatedUnion("source", [z.object({ source: z.literal("managed"), secret: z.string().min(1).max(16000) }).strict(), z.object({ source: z.literal("keyless") }).strict()]).optional(),
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
    discovery.post("/api/model-config/discover", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    try {
      const body = z.object({ base_url: z.string().url(), api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]), secret: z.string().max(16000).optional() }).strict().parse(request.body);
      const result = await resources.testProviderConfiguration({ base_url: body.base_url, protocol: body.api === "anthropic-messages" ? "anthropic" : "openai", auth: body.secret ? { kind: "api_key", secret: body.secret } : { kind: "none" } });
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
