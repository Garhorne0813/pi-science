import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, getSupportedThinkingLevels, lazyApi, type Api, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { CredentialStore } from "../../../model-resources/credential-store.js";
import { ModelResourceRepository } from "../../../model-resources/model-resource-repository.js";
import { RuntimeModelResolver } from "../../../model-resources/runtime-model-resolver.js";
import { CANONICAL_THINKING_LEVELS } from "../../../model-resources/capability-resolver.js";
import { resolveContextWindow, type RuntimeSettings } from "../agent-runtime-settings.js";

const implementations: Record<string, ProviderStreams> = {
  "openai-completions": lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  "openai-responses": lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses")),
  "anthropic-messages": lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages")),
};

/** Resolve the same managed provider credentials shown by Settings for Pi's built-in providers. */
export function agentModels(settings: RuntimeSettings = {}) {
  const resources = new ModelResourceRepository();
  const credentials = new CredentialStore();
  const state = resources.readSync();
  const credentialFor = (providerId: string) => {
    const ref = state.credential_refs[providerId];
    return ref ? credentials.readSync(ref)?.secret ?? undefined : undefined;
  };
  const models = builtinModels({ credentials: {
    async read(providerId) {
      const key = credentialFor(providerId);
      return key ? { type: "api_key" as const, key } : undefined;
    },
    async list() {
      return Object.keys(resources.readSync().credential_refs)
        .filter((providerId) => Boolean(credentialFor(providerId)))
        .map((providerId) => ({ providerId, type: "api_key" as const }));
    },
    async modify() { throw new Error("Managed credentials must be changed in Settings"); },
    async delete() { throw new Error("Managed credentials must be changed in Settings"); },
  } });
  const resolved = new RuntimeModelResolver(resources, credentials).resolveStateSync(state);
  for (const provider of state.providers) {
    if (!provider.enabled || provider.auth_kind === "oauth") { models.deleteProvider(provider.id); continue; }
    const original = models.getProvider(provider.id);
    const canonicalIds = new Set(state.models.filter((item) => item.provider_id === provider.id).map((item) => item.model_id));
    const catalog: Model<Api>[] = [...(original?.getModels() ?? [])].filter((model) => !canonicalIds.has(model.id));
    const routes = new Map<string, { modelId: string; key?: string; api: ProviderStreams }>();
    for (const item of resolved.filter((item) => item.provider_id === provider.id && item.available)) {
      const route = item.routes[0]!;
      const base = original?.getModels().find((model) => model.id === item.model_id);
      const api = route.api && !["native", "ollama"].includes(route.api) ? route.api
        : route.protocol === "native" ? base?.api : route.protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
      const implementation = api ? implementations[api] ?? (api === base?.api ? original : undefined) : undefined;
      if (!api || !implementation) continue;
      const caps = item.capabilities;
      const useCapabilities = !base || item.capability_source !== "fallback";
      catalog.push({
        ...(base ?? {}), id: item.model_id, provider: provider.id, name: item.display_name, api,
        baseUrl: route.api === "ollama" ? `${route.base_url.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1` : route.base_url,
        reasoning: useCapabilities ? caps.reasoning : base!.reasoning,
        input: useCapabilities ? ["text", ...(caps.vision ? ["image" as const] : [])] : base!.input,
        contextWindow: useCapabilities ? caps.context_window ?? base?.contextWindow ?? 128000 : base!.contextWindow,
        maxTokens: caps.max_output_tokens ?? base?.maxTokens ?? 16384,
        cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { ...base?.headers, ...state.bindings.find((binding) => binding.id === route.binding_id)?.headers_policy },
        ...(useCapabilities ? { thinkingLevelMap: Object.fromEntries(CANONICAL_THINKING_LEVELS.map((level) => [level,
          caps.reasoning && caps.thinking_levels.includes(level) ? level : null])) } : {}),
      });
      const key = route.credential_ref ? credentials.readSync(route.credential_ref)?.secret ?? undefined : undefined;
      routes.set(item.model_id, { modelId: route.model_id, key, api: implementation });
    }
    if (!catalog.length) { models.deleteProvider(provider.id); continue; }
    const streams: ProviderStreams = {
      stream(model, context, options) {
        const route = routes.get(model.id);
        return route ? route.api.stream({ ...model, id: route.modelId }, context, { ...options, apiKey: route.key ?? "unused" })
          : original!.stream(model, context, options);
      },
      streamSimple(model, context, options) {
        const route = routes.get(model.id);
        return route ? route.api.streamSimple({ ...model, id: route.modelId }, context, { ...options, apiKey: route.key ?? "unused" })
          : original!.streamSimple(model, context, options);
      },
    };
    models.setProvider(createProvider({ id: provider.id, name: provider.name, models: catalog,
      filterModels: (available) => available.filter((model) => routes.has(model.id) || Boolean(credentialFor(provider.id))),
      auth: { apiKey: { name: "Settings-managed credentials", async resolve() {
        // Each canonical route supplies its own key at dispatch. Keyless local
        // endpoints are configured too; no secrets enter catalog responses.
        return await original?.auth.apiKey?.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal,
          credential: credentialFor(provider.id) ? { type: "api_key", key: credentialFor(provider.id) } : undefined }) ?? (routes.size ? { auth: {} } : undefined);
      } } }, api: streams,
    }));
  }
  // Cache fields in Settings are deliberately ignored. Explicit overrides are
  // bound to a model and affect the actual Harness model, not just its display.
  for (const provider of models.getProviders()) {
    const catalog = provider.getModels().map((model) => ({ ...model,
      contextWindow: resolveContextWindow(`${model.provider}/${model.id}`, model.contextWindow, settings) }));
    models.setProvider({ ...provider, getModels: () => catalog });
  }
  return models;
}

/** The agent-core catalog is authoritative even before a session worker starts. */
export async function agentModelCatalog(models = agentModels()) {
  return (await models.getAvailable()).map((model) => ({
    provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap,
    thinking_levels: getSupportedThinkingLevels(model), input: model.input,
  }));
}
