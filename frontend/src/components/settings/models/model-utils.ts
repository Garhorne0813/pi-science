import type { Provider as SettingsProvider, SettingsConfig } from "../../../lib/settings";

export type ModelView = {
  id: string;
  name: string;
  vendor?: string;
  reasoning: boolean;
  inputFormats: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  thinkingLevels: string[];
  source?: string;
  available?: boolean;
};

export type Service = {
  id: string;
  name: string;
  status: "connected" | "needs_key" | "needs_login" | "unreachable" | "disabled";
  models: ModelView[];
  custom: boolean;
  auth?: SettingsProvider["auth"];
  provider?: Pick<SettingsProvider, "id" | "name">;
};

export function isConnected(provider: { credential_status?: string; has_key: boolean; enabled?: boolean; auth?: { api_key_supported: boolean; kind?: string } }) {
  if (provider.enabled === false) return false;
  if (provider.auth?.api_key_supported === false && provider.auth.kind !== "none") return false;
  if (provider.credential_status !== undefined) return provider.credential_status === "configured" || provider.credential_status === "connected";
  return provider.has_key || provider.auth?.kind === "none" && provider.enabled === true;
}

function customStatus(provider: SettingsProvider): Service["status"] {
  if (provider.enabled === false) return "disabled";
  if (provider.credential_status === "needs_login" || provider.auth?.api_key_supported === false && provider.auth.kind !== "none") return "needs_login";
  if (provider.credential_status === "invalid" || provider.credential_status === "needs_key") return "needs_key";
  return isConnected(provider) ? "connected" : "needs_key";
}

export function buildServices(config: SettingsConfig): Service[] {
  const available = config.available_models || [];
  const serviceModels = (id: string, names: string[]): ModelView[] => {
    const providerIds = /^(?:custom|user)-/.test(id) ? [`user-${customProviderId(id)}`, `custom-${customProviderId(id)}`] : [id];
    const models: ModelView[] = available
      .filter((model) => providerIds.includes(model.provider) || providerIds.some((providerId) => model.id.startsWith(`${providerId}/`)) || names.includes(model.id))
      .map((model) => ({
      id: model.id,
      name: shortModelName(model.label, model.model),
      vendor: model.label.includes("·") ? model.label.slice(0, model.label.indexOf("·")).trim() : undefined,
      reasoning: model.reasoning,
      inputFormats: Array.isArray(model.input_formats) && model.input_formats.length > 0
        ? model.input_formats
        : ["text", ...(model.vision ? ["image"] : [])],
      contextWindow: model.context_window ?? null,
      maxOutputTokens: model.max_output_tokens ?? null,
      vision: model.vision,
      tools: model.tools,
      structuredOutput: model.structured_output,
      thinkingLevels: model.thinking_levels || [],
      source: model.capability_source,
      available: true,
    }));
    // Keep configured inventory visible even when the available-model catalog
    // omits an unauthenticated or disabled custom provider. Do not guess facts.
    if (/^(?:custom|user)-/.test(id)) for (const name of names) {
      const modelName = providerIds.reduce((value, prefix) => value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : value, name);
      if (!models.some((model) => providerIds.some((prefix) => model.id === `${prefix}/${modelName}`))) models.push({ id: `${id}/${modelName}`, name: modelName, reasoning: false, inputFormats: [], contextWindow: null, maxOutputTokens: null, thinkingLevels: [], available: false });
    }
    return models;
  };
  const builtin = config.providers.filter((provider) => !provider.custom && isConnected(provider)).map((provider) => ({
    id: provider.id,
    name: provider.name,
    status: provider.credential_status === "needs_key" ? "needs_key" as const : provider.enabled === false ? "disabled" as const : "connected" as const,
    models: serviceModels(provider.id, provider.models),
    custom: false,
    provider,
  }));
  const canonicalCustom = mergeCustomProviders(config.providers.filter((provider) => provider.custom));
  const custom = [
    ...canonicalCustom.map((provider) => ({
      id: `user-${customProviderId(provider.id)}`,
      name: provider.name,
      status: customStatus(provider),
      models: serviceModels(`user-${customProviderId(provider.id)}`, provider.models).map((model) => ({ ...model, available: isConnected(provider) && model.available })),
      custom: true,
      auth: provider.auth,
    })),
    ...(config.custom_providers || [])
      .filter((provider) => !canonicalCustom.some((item) => customProviderId(item.id) === customProviderId(provider.id)))
      .map((provider) => ({
        id: `user-${customProviderId(provider.id)}`,
        name: provider.name,
        status: provider.has_key ? "connected" as const : "needs_key" as const,
        models: serviceModels(`user-${customProviderId(provider.id)}`, provider.models).map((model) => ({ ...model, available: provider.has_key && model.available })),
        custom: true,
      })),
  ];
  return [...builtin, ...custom];
}

function customProviderId(id: string): string {
  return id.replace(/^(?:user|custom)-/, "");
}

function mergeCustomProviders(providers: SettingsProvider[]): SettingsProvider[] {
  const merged = new Map<string, SettingsProvider>();
  for (const provider of providers) {
    const identity = customProviderId(provider.id);
    const current = merged.get(identity);
    if (!current) { merged.set(identity, provider); continue; }
    const preferred = provider.id.startsWith("user-") ? provider : current;
    const fallback = preferred === provider ? current : provider;
    merged.set(identity, { ...fallback, ...preferred, models: [...new Set([...current.models, ...provider.models])], has_key: current.has_key || provider.has_key });
  }
  return [...merged.values()];
}

export function shortModelName(label: string, model: string) {
  const separator = label.indexOf("·");
  return separator >= 0 ? label.slice(separator + 1).trim() || model : label || model;
}

export function formatContext(value: number | null) {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}
