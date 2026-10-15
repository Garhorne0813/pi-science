import { validateOutboundHttpUrl } from "../security/outbound-security.js";
import { SettingsStore } from "../storage/settings-store.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, lazyApi, type Api, type Model, type MutableModels, type ProviderStreams } from "@earendil-works/pi-ai";
import type { ModelConfigSnapshot } from "@pi-science/contracts";
import { ModelCredentialAdapter } from "./model-credential-adapter.js";
import { ModelConfigService } from "./model-config-service.js";

const implementations: Record<string, ProviderStreams> = {
  "openai-completions": lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  "openai-responses": lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses")),
  "anthropic-messages": lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages")),
};

export class ModelRegistryService {
  constructor(private readonly service = new ModelConfigService()) {}
  compile(snapshot = this.service.readSync(), legacy?: MutableModels, deploymentAllowPrivate = process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0") {
    // Preserve streaming and trusted proxy/CA handling; pin the control-plane
    // deployment policy even though this variable is deliberately absent in Workers.
    const guardedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const settings = await new SettingsStore().read();
      await validateOutboundHttpUrl(request.url, { allowPrivate: settings.allow_private_providers !== false && deploymentAllowPrivate });
      return fetch(request, { redirect: "error" });
    };
    const models = builtinModels({ credentials: new ModelCredentialAdapter(this.service, snapshot),
      authContext: { env: async () => undefined, fileExists: async () => false } });
    for (const [id, config] of Object.entries(snapshot.config.providers)) {
      if (snapshot.legacy_providers.includes(id)) continue;
      const native = models.getProvider(id);
      const catalog = new Map((native?.getModels() ?? []).map((model) => [model.id, model]));
      for (const model of config.models ?? []) {
        const base = catalog.get(model.id);
        catalog.set(model.id, { ...(base ?? {}), ...model, provider: id, name: model.name ?? base?.name ?? model.id,
          api: config.api ?? base?.api ?? native?.getModels()[0]?.api ?? "openai-completions", baseUrl: config.baseUrl ?? base?.baseUrl ?? native?.baseUrl ?? "",
          reasoning: model.reasoning ?? base?.reasoning ?? false, input: model.input ?? base?.input ?? ["text"],
          contextWindow: model.contextWindow ?? base?.contextWindow ?? 128000, maxTokens: model.maxTokens ?? base?.maxTokens ?? 16384,
          cost: model.cost ?? base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as Model<Api>);
      }
      const catalogModels = [...catalog.values()].map((model) => ({ ...model, ...config.modelOverrides?.[model.id],
        ...(config.api ? { api: config.api } : {}), ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        headers: { ...model.headers, ...config.headers, ...config.modelOverrides?.[model.id]?.headers } }));
      if (native) {
        // Preserve native factory, auth and stream dispatch. Only project model metadata.
        models.setProvider({ ...native, getModels: () => catalogModels,
          ...(config.baseUrl ? {
            stream: ((model, context, options) => native.stream<Api>(model, context, { ...options, fetch: guardedFetch })) as typeof native.stream,
            streamSimple: ((model, context, options) => native.streamSimple(model, context, { ...options, fetch: guardedFetch })) as typeof native.streamSimple,
          } : {}) });
      } else {
        const implementation = implementations[config.api ?? "openai-completions"]!;
        // Keep the provider's stream parser; inject only the existing egress policy.
        // Reject redirects so auth cannot be forwarded to a different destination.
        const api: ProviderStreams = {
          stream: (model, context, options) => implementation.stream(model, context, { ...options, fetch: guardedFetch }),
          streamSimple: (model, context, options) => implementation.streamSimple(model, context, { ...options, fetch: guardedFetch }),
        };
        models.setProvider(createProvider({ id, name: config.name ?? id, baseUrl: config.baseUrl, models: catalogModels, api,
          auth: { apiKey: { name: "Explicit credentials", async resolve({ credential }) {
            return credential?.type === "api_key" && credential.key ? { auth: { apiKey: credential.key } }
              : snapshot.keyless_providers.includes(id) ? { auth: { apiKey: "unused" } } : undefined;
          } } } }));
      }
    }
    for (const id of snapshot.legacy_providers) {
      const provider = legacy?.getProvider(id);
      if (provider) models.setProvider(provider);
      else models.deleteProvider(id);
    }
    return models;
  }
  async compare(snapshot: ModelConfigSnapshot, legacy: MutableModels) {
    const native = this.compile(snapshot, legacy);
    const ids = async (models: MutableModels) => new Map((await models.getAvailable()).map((model) => [`${model.provider}/${model.id}`, model]));
    const before = await ids(legacy), after = await ids(native);
    return { revision: snapshot.revision, added: [...after.keys()].filter((id) => !before.has(id)), removed: [...before.keys()].filter((id) => !after.has(id)),
      changed: [...before].filter(([id, model]) => { const other = after.get(id); return other && (model.contextWindow !== other.contextWindow || model.maxTokens !== other.maxTokens || model.reasoning !== other.reasoning || JSON.stringify(model.input) !== JSON.stringify(other.input) || JSON.stringify(model.thinkingLevelMap) !== JSON.stringify(other.thinkingLevelMap)); }).map(([id]) => id) };
  }
}
