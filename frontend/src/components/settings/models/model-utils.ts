import type { ProviderView } from "@pi-science/contracts";

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
  reason?: string;
};

export type Service = {
  id: string;
  name: string;
  status: ProviderView["status"];
  models: ModelView[];
  custom: boolean;
  auth?: ProviderView["auth"];
  view: ProviderView;
  provider?: Pick<ProviderView, "id" | "name">;
};

/** Adapt presentation fields only: availability and actions are backend facts. */
export function buildServices(providers: ProviderView[]): Service[] {
  return providers.map((view) => ({
    id: view.id, name: view.name, custom: view.source === "user", status: view.status,
    auth: view.auth, provider: { id: view.id, name: view.name }, view,
    models: view.models.map((model) => ({ id: model.id, name: shortModelName(model.display_name, model.model_id), reasoning: model.capabilities.reasoning,
      inputFormats: model.input_formats ?? [], contextWindow: model.capabilities.context_window, maxOutputTokens: model.capabilities.max_output_tokens,
      vision: model.capabilities.vision, tools: model.capabilities.tools, structuredOutput: model.capabilities.structured_output,
      thinkingLevels: model.capabilities.thinking_levels, source: model.capability_source, available: model.available, reason: model.availability_reason })),
  }));
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
