import type { ProviderView } from "@pi-science/contracts";
import type { SettingsConfig } from "../../src/lib/settings/settings-types.ts";

/** Test data adapter only. Production reads the server's ProviderView contract. */
export function providerViewsFixture(config: Pick<SettingsConfig, "providers" | "available_models"> & { custom_providers?: SettingsConfig["custom_providers"] }): { providers: ProviderView[] } {
  const providers: SettingsConfig["providers"] = [...config.providers, ...(config.custom_providers ?? []).filter((item) => !config.providers.some((provider) => provider.id === `user-${item.id}`)).map((item) => ({ ...item, id: `user-${item.id}`, custom: true }))];
  return { providers: providers.map((provider): ProviderView => {
    const state = provider.credential_status === "invalid" ? "invalid" : provider.credential_status === "needs_login" || provider.auth?.kind === "oauth" ? "needs_login" : provider.has_key ? "ready" : "needs_key";
    const status = provider.enabled === false ? "disabled" : state;
    const available = status === "ready";
    const ids = provider.models.map((id) => typeof id === "string" ? id : String(id));
    const candidates = config.available_models.filter((model) => model.provider === provider.id);
    const rows = new Map(candidates.map((model) => [model.id, model]));
    for (const raw of ids) {
      const id = raw.startsWith(`${provider.id}/`) ? raw : `${provider.id}/${raw}`;
      if (!rows.has(id)) rows.set(id, { id, provider: provider.id, model: raw, label: raw, reasoning: false, thinking_levels: [], context_window: null, custom: Boolean(provider.custom), capability_source: "fallback" });
    }
    const models = [...rows.values()].map((model) => ({ input_formats: model.input_formats ?? (model.capability_source === "fallback" ? [] : ["text"]), id: model.id, provider_id: provider.id, model_id: model.model, display_name: model.label, enabled: true,
      available, ...(available ? {} : { availability_reason: state === "needs_login" ? "needs_login" : "missing_credential" }), routes: [],
      capabilities: { reasoning: model.reasoning, thinking_levels: model.thinking_levels ?? [], context_window: model.context_window ?? null, max_output_tokens: model.max_output_tokens ?? null, vision: model.vision ?? model.input_formats?.includes("image") }, capability_source: "manual" as const }));
    return { id: provider.id, name: provider.name, source: provider.custom ? "user" : "builtin", enabled: provider.enabled !== false, status,
      auth: { kind: provider.auth?.kind ?? "api_key", api_key_supported: provider.auth?.api_key_supported !== false, login_supported: false }, credential: { state, configured: provider.has_key },
      models, routing: { configured_model_count: models.length, selectable_model_count: available ? models.length : 0, issues: available ? [] : [{ code: state === "needs_login" ? "needs_login" : "missing_credential" }] },
      last_verification: { state: "never", checked_at: null },
      allowed_actions: provider.custom ? ["edit", provider.enabled === false ? "enable" : "disable", "delete", "discover"] : state === "needs_login" ? [] : ["replace_credential"] };
  }) };
}
