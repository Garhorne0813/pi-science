import { validateOutboundHttpUrl } from "../security/outbound-security.js";
import { SettingsStore } from "../storage/settings-store.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, lazyApi, type Api, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_CONTEXT_WINDOW, modelConfigSnapshotSchema} from "@pi-science/contracts";
import { ModelCredentialAdapter } from "./model-credential-adapter.js";
import { ModelConfigService, configError } from "./model-config-service.js";
import { anthropicBaseUrl } from "./protocol-endpoints.js";

const implementations: Record<string, ProviderStreams> = {
  "openai-completions": lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  "openai-responses": lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses")),
  "anthropic-messages": lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages")),
};

export class ModelRegistryService {
  constructor(private readonly service = new ModelConfigService()) {}
  compile(snapshot = this.service.readSync(), deploymentAllowPrivate = process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0") {
    modelConfigSnapshotSchema.parse(snapshot);
    // Preserve streaming and trusted proxy/CA handling; pin the control-plane
    // deployment policy even though this variable is deliberately absent in Workers.
    const guardedFetch = (keyless = false): typeof fetch => async (input, init) => {
      const request = new Request(input, init);
      // Pi 0.99.2 requires a truthy key before constructing its protocol clients.
      // Explicit keyless connections remove SDK-generated auth at the last boundary,
      // before any bytes reach the network. Managed/OAuth paths keep their headers.
      if (keyless) for (const name of ["authorization", "x-api-key", "api-key", "proxy-authorization", "cookie"]) request.headers.delete(name);
      const settings = await new SettingsStore().read();
      await validateOutboundHttpUrl(request.url, { allowPrivate: settings.allow_private_providers !== false && deploymentAllowPrivate });
      return fetch(request, { redirect: "error" });
    };
    const models = builtinModels({ credentials: new ModelCredentialAdapter(this.service, snapshot),
      authContext: { env: async () => undefined, fileExists: async () => false } });
    for (const [id, config] of Object.entries(snapshot.config.providers)) {
      const providerFetch = guardedFetch(snapshot.keyless_providers.includes(id));
      const native = models.getProvider(id);
      if (native && config.baseUrl && config.baseUrl !== native.baseUrl) {
        const ref = snapshot.credential_refs[id], metadata = ref ? this.service.credentials.readSync(ref)?.metadata : null;
        if (metadata?.kind === "oauth" && metadata.backend === "oauth") throw configError("unsupported_auth", "OAuth credentials cannot be routed to an overridden endpoint");
      }
      const catalog = new Map((native?.getModels() ?? []).map((model) => [model.id, model]));
      for (const entry of config.models ?? []) {
        const { discoveredFields: _discoveredFields, ...model } = entry;
        const base = catalog.get(model.id);
        catalog.set(model.id, { ...(base ?? {}), ...model, provider: id, name: model.name ?? base?.name ?? model.id,
          api: config.api ?? base?.api ?? native?.getModels()[0]?.api ?? "openai-completions", baseUrl: config.baseUrl ?? base?.baseUrl ?? native?.baseUrl ?? "",
          reasoning: model.reasoning ?? base?.reasoning ?? false, input: model.input ?? base?.input ?? ["text"],
          contextWindow: model.contextWindow ?? base?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW, maxTokens: model.maxTokens ?? base?.maxTokens ?? 16384,
          cost: model.cost ?? base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as Model<Api>);
      }
      const catalogModels = [...catalog.values()].map((model) => {
        const effective = { ...model, ...config.modelOverrides?.[model.id] };
        return { ...effective, ...(!native && effective.reasoning && !effective.thinkingLevelMap ? { thinkingLevelMap: { xhigh: "high", max: "high" } } : {}),
        ...(config.api ? { api: config.api } : {}), ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...((config.api ?? model.api) === "anthropic-messages" ? { baseUrl: anthropicBaseUrl(config.baseUrl ?? model.baseUrl) } : {}),
        headers: { ...model.headers, ...config.headers, ...config.modelOverrides?.[model.id]?.headers } }; });
      if (native) {
        // Preserve native factory, auth and stream dispatch. Only project model metadata.
        models.setProvider({ ...native, getModels: () => catalogModels,
          ...(config.baseUrl ? {
            stream: ((model, context, options) => native.stream<Api>(model, context, { ...options, fetch: providerFetch })) as typeof native.stream,
            streamSimple: ((model, context, options) => native.streamSimple(model, context, { ...options, fetch: providerFetch })) as typeof native.streamSimple,
          } : {}) });
      } else {
        const implementation = implementations[config.api ?? "openai-completions"]!;
        // Keep the provider's stream parser; inject only the existing egress policy.
        // Reject redirects so auth cannot be forwarded to a different destination.
        const api: ProviderStreams = {
          stream: (model, context, options) => implementation.stream(model, context, { ...options, fetch: providerFetch }),
          streamSimple: (model, context, options) => implementation.streamSimple(model, context, { ...options, fetch: providerFetch }),
        };
        models.setProvider(createProvider({ id, name: config.name ?? id, baseUrl: config.baseUrl, models: catalogModels, api,
          auth: { apiKey: { name: "Explicit credentials", async resolve({ credential }) {
            return credential?.type === "api_key" && credential.key ? { auth: { apiKey: credential.key } }
              : snapshot.keyless_providers.includes(id) ? { auth: { apiKey: "unused" } } : undefined;
          } } } }));
      }
    }
    return models;
  }
}
