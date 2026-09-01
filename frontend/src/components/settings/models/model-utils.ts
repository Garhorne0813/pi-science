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
  provider?: Pick<SettingsProvider, "id" | "name">;
};

export function isConnected(provider: { credential_status?: string; has_key: boolean; enabled?: boolean }) {
  return provider.credential_status === "configured"
    || provider.credential_status === "connected"
    || (provider.credential_status === undefined && provider.has_key)
    || provider.enabled === true && provider.has_key;
}

export function buildServices(config: SettingsConfig): Service[] {
  const available = config.available_models || [];
  const serviceModels = (id: string, names: string[]): ModelView[] => {
    const providerIds = id.startsWith("custom-") ? [id, `user-${id.slice("custom-".length)}`] : [id];
    return available
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
    ...canonicalCustom.filter(isConnected).map((provider) => ({
      id: provider.id,
      name: provider.name,
      status: provider.enabled === false ? "disabled" as const : "connected" as const,
      models: serviceModels(provider.id, provider.models),
      custom: true,
    })),
    ...(config.custom_providers || [])
      .filter((provider) => provider.has_key && !canonicalCustom.some((item) => customProviderId(item.id) === customProviderId(provider.id)))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        status: "connected" as const,
        models: serviceModels(`custom-${provider.id}`, provider.models),
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
