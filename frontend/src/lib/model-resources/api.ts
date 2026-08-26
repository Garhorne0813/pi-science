import { apiRequest } from "../client/api";
import type { CredentialMetadata, CustomProviderResult, ModelEndpointResource, ModelPreferences, ModelProvider, ModelResource, ProviderEndpointBinding } from "./types";

export const modelResourceKeys = {
  providers: ["model-resources", "providers"] as const,
  models: (providerId?: string | null, available?: boolean) => ["model-resources", "models", providerId ?? null, available ?? null] as const,
  endpoints: ["model-resources", "endpoints"] as const,
  bindings: (providerId?: string | null, endpointId?: string | null) => ["model-resources", "bindings", providerId ?? null, endpointId ?? null] as const,
  credentials: ["model-resources", "credentials"] as const,
  preferences: ["model-resources", "preferences"] as const,
};

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

function query(params: Record<string, string | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const result = search.toString();
  return result ? `?${result}` : "";
}

export const modelResourcesApi = {
  providers(): Promise<{ providers: ModelProvider[] }> {
    return apiRequest("/api/providers");
  },
  models(filters: { provider_id?: string; available?: boolean } = {}): Promise<{ models: ModelResource[] }> {
    return apiRequest(`/api/models${query(filters)}`);
  },
  endpoints(): Promise<{ endpoints: ModelEndpointResource[] }> {
    return apiRequest("/api/endpoints");
  },
  bindings(filters: { provider_id?: string; endpoint_id?: string } = {}): Promise<{ bindings: ProviderEndpointBinding[] }> {
    return apiRequest(`/api/provider-endpoint-bindings${query(filters)}`);
  },
  credentials(): Promise<{ credentials: CredentialMetadata[] }> {
    return apiRequest("/api/credentials");
  },
  preferences(): Promise<ModelPreferences> {
    return apiRequest("/api/settings/model");
  },
  createProvider(body: { id?: string; name: string; adapter: string; catalog_mode: string; auth_kind: string; enabled?: boolean }): Promise<{ provider: ModelProvider }> {
    return apiRequest("/api/providers", { ...json("POST", body) });
  },
  createEndpoint(body: { name: string; base_url: string; protocol: string; credential_ref?: string | null; data_egress?: string }): Promise<{ endpoint: ModelEndpointResource }> {
    return apiRequest("/api/endpoints", { ...json("POST", body) });
  },
  createCredential(body: { kind: string; backend: string; secret?: string; label?: string }): Promise<{ credential: CredentialMetadata }> {
    return apiRequest("/api/credentials", { ...json("POST", body) });
  },
  createBinding(body: { provider_id: string; endpoint_id: string; priority?: number; enabled?: boolean }): Promise<{ binding: ProviderEndpointBinding }> {
    return apiRequest("/api/provider-endpoint-bindings", { ...json("POST", body) });
  },
  discover(providerId: string, bindingId?: string): Promise<{ models: ModelResource[] }> {
    return apiRequest(`/api/providers/${encodeURIComponent(providerId)}/discover`, { ...json("POST", bindingId ? { binding_id: bindingId } : {}) });
  },
  deleteProvider(providerId: string): Promise<unknown> {
    return apiRequest(`/api/providers/${encodeURIComponent(providerId)}?cascade=true`, { method: "DELETE" });
  },
  deleteEndpoint(endpointId: string): Promise<unknown> {
    return apiRequest(`/api/endpoints/${encodeURIComponent(endpointId)}?cascade=true`, { method: "DELETE" });
  },
  setEndpointEnabled(endpointId: string, enabled: boolean): Promise<unknown> {
    return apiRequest(`/api/endpoints/${encodeURIComponent(endpointId)}/enabled?enabled=${enabled}`, { method: "PUT" });
  },
  updateEndpoint(endpointId: string, body: { base_url?: string; name?: string }): Promise<{ endpoint: ModelEndpointResource }> {
    return apiRequest(`/api/endpoints/${encodeURIComponent(endpointId)}`, { ...json("PUT", body) });
  },
  probeEndpoint(endpointId: string): Promise<unknown> {
    return apiRequest(`/api/endpoints/${encodeURIComponent(endpointId)}/health`, { method: "POST" });
  },
  /** Aggregate custom-provider surface: one call owns the whole lifecycle. */
  createCustomProvider(body: { name: string; base_url: string; protocol: string; api?: string; auth?: { kind: "api_key" | "none"; secret?: string } | null; models?: string[] }): Promise<CustomProviderResult> {
    return apiRequest("/api/custom-providers", { ...json("POST", body) });
  },
  updateCustomProvider(providerId: string, body: { name?: string; base_url?: string; api?: string; auth?: { kind: "api_key"; secret: string } | { kind: "none" } }): Promise<CustomProviderResult> {
    return apiRequest(`/api/custom-providers/${encodeURIComponent(providerId)}`, { ...json("PUT", body) });
  },
  deleteCustomProvider(providerId: string): Promise<unknown> {
    return apiRequest(`/api/custom-providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  },
  testCustomProvider(body: { base_url: string; protocol: string; auth?: { kind: "api_key" | "none"; secret?: string } | null }): Promise<{ ok: true; health: "ready"; models: Array<{ id: string; display_name: string }> }> {
    return apiRequest("/api/custom-providers/test", { ...json("POST", body) });
  },
  refreshCustomProviderModels(providerId: string): Promise<unknown> {
    return apiRequest(`/api/custom-providers/${encodeURIComponent(providerId)}/refresh-models`, { method: "POST" });
  },
  setCustomProviderEnabled(providerId: string, enabled: boolean): Promise<unknown> {
    return apiRequest(`/api/custom-providers/${encodeURIComponent(providerId)}/enabled?enabled=${enabled}`, { method: "PUT" });
  },
  updateCustomProviderModels(providerId: string, body: { enabled: string[] }): Promise<unknown> {
    return apiRequest(`/api/custom-providers/${encodeURIComponent(providerId)}/models`, { ...json("PUT", body) });
  },
};
