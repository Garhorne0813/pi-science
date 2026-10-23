import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { modelCapabilitySources, type ProviderView } from "@pi-science/contracts";
import { ModelConfigService } from "./model-config-service.js";
import { ModelRegistryService } from "./model-registry-service.js";

/** Compatibility DTO compiled from exactly the same registry as new Workers. */
export async function nativeProviderViews(): Promise<ProviderView[]> {
  const service = new ModelConfigService(), snapshot = service.readSync();
  const registry = new ModelRegistryService(service).compile(snapshot);
  const builtin = builtinModels();
  const selectable = new Set((await registry.getAvailable()).map((model) => `${model.provider}/${model.id}`));
  const views = await Promise.all(registry.getProviders().map(async (provider): Promise<ProviderView> => {
    const view = await service.view(provider.id, snapshot);
    const native = builtin.getProvider(provider.id);
    const count = provider.getModels().filter((model) => selectable.has(`${provider.id}/${model.id}`)).length;
    return { id: provider.id, configured: view.configured, name: snapshot.config.providers[provider.id]?.name ?? provider.name, source: native ? "builtin" : "user", enabled: true,
      status: view.authentication.source === "oauth" && !view.authentication.resolved ? "needs_login" : count ? "ready" : view.authentication.resolved ? "unavailable" : "needs_key",
      auth: { kind: view.authentication.source === "oauth" ? "oauth" : view.authentication.source === "keyless" ? "none" : "api_key", api_key_supported: Boolean(provider.auth.apiKey), login_supported: Boolean(provider.auth.oauth?.isSubscription) },
      credential: { state: view.authentication.resolved ? "ready" : view.authentication.source === "oauth" ? "needs_login" : "needs_key", configured: view.authentication.resolved },
      routing: { selectable_model_count: count, configured_model_count: provider.getModels().length, issues: view.legacy ? [{ code: "legacy_route" }] : [] },
      last_verification: { state: "never", checked_at: null },
      allowed_actions: view.legacy ? [] : native ? ["replace_credential", "remove_credential"] : ["edit", "delete", "replace_credential", "remove_credential"],
      models: provider.getModels().map((model) => {
        const configured = snapshot.config.providers[provider.id];
        const declared = configured?.models?.find((item) => item.id === model.id);
        const override = configured?.modelOverrides?.[model.id];
        const known = native?.getModels().some((item) => item.id === model.id);
        const available = selectable.has(`${provider.id}/${model.id}`);
        return { id: `${provider.id}/${model.id}`, provider_id: provider.id, model_id: model.id, display_name: model.name, enabled: true, available,
          ...(available ? {} : { availability_reason: "missing_credential" }), routes: [],
          capabilities: { reasoning: model.reasoning, thinking_levels: getSupportedThinkingLevels(model),
            vision: model.input.includes("image"), context_window: model.contextWindow, max_output_tokens: model.maxTokens },
          capability_sources: modelCapabilitySources(configured, model.id, Boolean(known)),
          input_formats: known || declared?.input || override?.input ? [...model.input] : [],
          capability_source: override && Object.keys(override).length ? "manual" : declared?.discoveredFields?.length ? "discovery" : declared ? "manual" : known ? "runtime" : "fallback" };
      }),
    };
  }));
  return views;
}
