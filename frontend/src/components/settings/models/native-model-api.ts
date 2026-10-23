import { useQuery } from "@tanstack/react-query";
import type { ModelCapabilitySources, ModelConfigSnapshot, ModelConfigBackend, ProviderConfigView, ProviderAuthCapabilities } from "@pi-science/contracts";
import { apiRequest } from "../../../lib/client/api";

export type Configuration = ModelConfigSnapshot & { backend: ModelConfigBackend; providers: ProviderConfigView[] };
export type CatalogProvider = ProviderConfigView & {
  name: string; subscription_name?: string; source: "builtin" | "user"; auth_capabilities: ProviderAuthCapabilities; allowed_actions: string[];
  models: Array<{ id: string; name: string; available: boolean; contextWindow: number | null; maxTokens?: number | null; thinking_levels?: string[] | null; input?: string[] | null; capability_sources?: ModelCapabilitySources; source: string }>;
};
export const useModelConfig = () => useQuery({ queryKey: ["model-config"], queryFn: () => apiRequest<Configuration>("/api/model-config"), staleTime: 3000, retry: false });
export const send = <T,>(path: string, method: string, body: unknown) => apiRequest<T>(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
export const field = "min-h-10 w-full rounded-input border border-border bg-bg px-3 py-2 text-ui-caption text-text outline-none focus:border-accent";
export const button = "min-h-9 rounded-input border border-border px-3 text-ui-caption text-text hover:bg-surface-hover disabled:opacity-40";
export const primary = "min-h-9 rounded-input bg-accent-fill px-3 text-ui-caption font-medium text-accent-fg disabled:opacity-40";
