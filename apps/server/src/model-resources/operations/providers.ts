import type { CreateProviderRequest, Endpoint, Model, Provider, ProviderEndpointBinding, UpdateProviderRequest } from "@pi-science/contracts";
import { resolveCapabilities, type CapabilityPatch } from "../capability-resolver.js";
import { ModelResourceRepository } from "../model-resource-repository.js";
import { canonicalModelRef } from "../runtime-model-resolver.js";
import { resourceError, slug, now, normalizeProtocol, adapterForEndpoint, normalizeBaseUrl } from "./validation.js";
import { modelResourceHash } from "./compatibility.js";
import type { ModelResourceContext } from "./context.js";

type Context = Pick<ModelResourceContext, "credentials" | "ensureMigrated" | "repository" | "settings">;

export async function createProvider(context: Context, input: CreateProviderRequest): Promise<Provider> {
  await context.ensureMigrated();
  const requested = input.id?.trim();
  const id = requested ? (requested.startsWith("user-") ? requested : `user-${slug(requested)}`) : ModelResourceRepository.providerId(input.name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw resourceError("invalid_resource", "Provider ID must be URL-safe");
  const item: Provider = {
    id,
    name: input.name.trim(),
    kind: "user",
    adapter: input.adapter,
    enabled: input.enabled,
    catalog_mode: input.catalog_mode,
    auth_kind: input.auth_kind,
    source: "user",
    created_at: now(),
    updated_at: now(),
  };
  return context.repository.update((state) => {
    if (state.providers.some((provider) => provider.id === id)) throw resourceError("provider_id_conflict", `Provider ID '${id}' already exists`);
    state.providers.push(item);
    return structuredClone(item);
  });
}

export async function upsertLegacyProvider(context: Context, input: {
  id: string;
  name: string;
  base_url: string;
  api: string;
  models: string[];
  api_key?: string;
  reasoning?: boolean;
  context_window?: number;
  model_hints?: Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string }>;
  }): Promise<{ provider: Provider; endpoint: Endpoint; binding: ProviderEndpointBinding; models: Model[] }> {
  await context.ensureMigrated();
  const id = input.id.startsWith("user-") ? input.id : `user-${slug(input.id)}`;
  const protocol = normalizeProtocol(input.api);
  const baseUrl = normalizeBaseUrl(input.base_url);
  const result = await context.repository.update(async (state) => {
    let provider = state.providers.find((item) => item.id === id);
    if (provider && provider.kind === "system") throw resourceError("provider_id_conflict", `Provider ID '${id}' conflicts with a system provider`);
    if (!provider) {
      provider = {
        id,
        name: input.name.trim() || "Provider",
        kind: "user",
        adapter: adapterForEndpoint(protocol),
        enabled: true,
        catalog_mode: "hybrid",
        auth_kind: input.api_key ? "api_key" : "none",
        source: "user",
        created_at: now(),
        updated_at: now(),
      };
      state.providers.push(provider);
    } else {
      provider.name = input.name.trim() || provider.name;
      provider.adapter = adapterForEndpoint(protocol);
      provider.auth_kind = input.api_key ? "api_key" : provider.auth_kind;
      provider.updated_at = now();
    }
    let endpoint = state.endpoints.find((item) => item.base_url === baseUrl && item.protocol === protocol);
    if (!endpoint) {
      endpoint = {
        id: `ep_legacy_${modelResourceHash(`${baseUrl}:${protocol}`)}`,
        name: `${provider.name} connection`,
        base_url: baseUrl,
        protocol,
        api: ["openai-responses", "anthropic-messages", "ollama", "native"].includes(input.api) ? input.api as Endpoint["api"] : "openai-completions",
        credential_ref: null,
        enabled: true,
        health: "unknown",
        data_egress: baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") ? "local" : "remote",
        last_checked_at: null,
        last_error: null,
      };
      state.endpoints.push(endpoint);
    } else if (input.api) endpoint.api = input.api as Endpoint["api"];
    if (input.api_key) {
      const credentialId = `cred_${modelResourceHash(`legacy-api:${id}:${baseUrl}`)}`;
      await context.credentials.putRaw(credentialId, { kind: "api_key", backend: "managed", label: `${provider.name} key` }, input.api_key);
      endpoint.credential_ref = credentialId;
      provider.auth_kind = "api_key";
    }
    let binding = state.bindings.find((item) => item.provider_id === provider.id && item.endpoint_id === endpoint.id);
    if (!binding) {
      binding = { id: `bind_legacy_${modelResourceHash(`${provider.id}:${endpoint.id}`)}`, provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 100, metadata: { api: input.api || "openai-completions" }, created_at: now(), updated_at: now() };
      state.bindings.push(binding);
    } else {
      binding.enabled = true;
      binding.metadata = { ...(binding.metadata ?? {}), api: input.api || binding.metadata?.api || "openai-completions" };
      binding.updated_at = now();
    }
    const requestedModels = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
    state.models = state.models.filter((model) => model.provider_id !== provider.id || requestedModels.includes(model.model_id));
    const models: Model[] = [];
    for (const modelId of requestedModels) {
      const existing = state.models.find((model) => model.provider_id === provider.id && model.model_id === modelId);
      const hint = input.model_hints?.[modelId];
      const patches: CapabilityPatch[] = [
        ...(input.reasoning !== undefined || input.context_window !== undefined ? [{ reasoning: input.reasoning, context_window: input.context_window, source: "manual" as const }] : []),
        ...(hint ? [{ ...hint, source: hint.source === "runtime" ? "runtime" as const : hint.source === "discovery" ? "discovery" as const : "manual" as const }] : []),
        ...(existing ? [{ ...existing.capabilities, source: existing.capability_source, verified_at: existing.verified_at }] : []),
      ];
      const capabilities = resolveCapabilities(modelId, patches);
      const next: Model = { provider_id: provider.id, model_id: modelId, display_name: `${provider.name} · ${modelId}`, enabled: existing?.enabled ?? true, capabilities: capabilities.capabilities, capability_source: capabilities.capability_source, verified_at: capabilities.verified_at, discovered_at: existing?.discovered_at ?? null };
      if (existing) Object.assign(existing, next);
      else state.models.push(next);
      models.push(next);
    }
    return { provider: structuredClone(provider), endpoint: structuredClone(endpoint), binding: structuredClone(binding), models: structuredClone(models) };
  });
  return result;
}

export async function updateProvider(context: Context, id: string, input: UpdateProviderRequest): Promise<Provider> {
  await context.ensureMigrated();
  return context.repository.update((state) => {
    const item = state.providers.find((provider) => provider.id === id);
    if (!item) throw resourceError("resource_not_found", `Provider '${id}' was not found`);
    if (item.kind === "system") throw resourceError("invalid_resource", "System providers are read-only");
    if (input.name !== undefined) item.name = input.name.trim();
    if (input.adapter !== undefined) item.adapter = input.adapter;
    if (input.enabled !== undefined) item.enabled = input.enabled;
    if (input.catalog_mode !== undefined) item.catalog_mode = input.catalog_mode;
    if (input.auth_kind !== undefined) item.auth_kind = input.auth_kind;
    item.updated_at = now();
    return structuredClone(item);
  });
}

export async function deleteProvider(context: Context, id: string, cascade = false): Promise<{ id: string; removed_models: number; removed_bindings: number }> {
  await context.ensureMigrated();
  const settings = await context.settings.read();
  const state = await context.repository.read();
  const item = state.providers.find((provider) => provider.id === id);
  if (!item) throw resourceError("resource_not_found", `Provider '${id}' was not found`);
  if (item.kind === "system") throw resourceError("invalid_resource", "System providers cannot be deleted");
  const modelIds = state.models.filter((model) => model.provider_id === id).map((model) => canonicalModelRef(id, model.model_id));
  const aliases = Object.entries(state.aliases).filter(([, target]) => modelIds.includes(target)).map(([alias]) => alias);
  const defaultModel = String(settings.model ?? "");
  const bindings = state.bindings.filter((binding) => binding.provider_id === id);
  if (!cascade && (bindings.length > 0 || modelIds.some((model) => model === defaultModel || aliases.includes(defaultModel)))) throw resourceError("resource_in_use", `Provider '${id}' is still referenced`);
  await context.repository.update((current) => {
    current.providers = current.providers.filter((provider) => provider.id !== id);
    current.models = current.models.filter((model) => model.provider_id !== id);
    current.bindings = current.bindings.filter((binding) => binding.provider_id !== id);
    for (const alias of aliases) delete current.aliases[alias];
  });
  if (cascade && (modelIds.includes(defaultModel) || aliases.includes(defaultModel))) await context.settings.update((current) => { current.model = ""; });
  return { id, removed_models: modelIds.length, removed_bindings: bindings.length };
}
