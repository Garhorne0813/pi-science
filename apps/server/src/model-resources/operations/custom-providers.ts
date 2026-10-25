import type { CredentialMetadata, Endpoint, Provider, ProviderEndpointBinding } from "@pi-science/contracts";
import { ModelResourceRepository } from "../model-resource-repository.js";
import { canonicalModelRef } from "../runtime-model-resolver.js";
import { resourceError, defaultDataEgress, normalizeProtocol, adapterForEndpoint, normalizeBaseUrl } from "./validation.js";
import type { ModelResourceContext } from "./context.js";

type Context = Pick<ModelResourceContext, "createBinding" | "createEndpoint" | "createProvider" | "credentials" | "deleteEndpoint" | "deleteProvider" | "discover" | "ensureMigrated" | "repository" | "settings" | "updateEndpoint" | "updateProvider">;

export async function createCustomProvider(context: Context, input: { name: string; base_url: string; protocol?: Endpoint["protocol"]; api?: Endpoint["api"]; data_egress?: Endpoint["data_egress"]; auth?: { kind: "api_key" | "none"; secret?: string } | null; models?: string[] }): Promise<{ provider: Provider; endpoint: Endpoint; credential: CredentialMetadata | null; binding: ProviderEndpointBinding; discovery?: { model_count: number }; discovery_error?: string }> {
  await context.ensureMigrated();
  const providerId = ModelResourceRepository.providerId(input.name);
  if ((await context.repository.read()).providers.some((item) => item.id === providerId)) throw resourceError("provider_id_conflict", `Provider ID '${providerId}' already exists`);
  const protocol = normalizeProtocol(input.protocol ?? "openai");
  let credential: CredentialMetadata | null = null;
  let endpoint!: Endpoint;
  let provider!: Provider;
  let binding!: ProviderEndpointBinding;
  const compensation = async (): Promise<void> => {
    if (binding) { await context.repository.update((state) => { state.bindings = state.bindings.filter((item) => item.id !== binding.id); }); }
    if (provider) { await context.repository.update((state) => { state.providers = state.providers.filter((item) => item.id !== provider.id); state.models = state.models.filter((item) => item.provider_id !== provider.id); }); }
    if (endpoint) { await context.deleteEndpoint(endpoint.id, true); }
    if (credential) { await context.credentials.remove(credential.id); }
  };
  try {
    if (input.auth?.kind === "api_key" && input.auth.secret) {
      credential = await context.credentials.put({ kind: "api_key", backend: "managed", secret: input.auth.secret, label: `${input.name} key`, owner_provider_id: providerId });
    }
    endpoint = await context.createEndpoint({
      name: `${input.name} connection`,
      base_url: input.base_url,
      protocol,
      api: input.api,
      credential_ref: credential?.id ?? null,
      enabled: true,
      data_egress: input.data_egress ?? defaultDataEgress(input.base_url),
      owner_provider_id: providerId,
    });
    provider = await context.createProvider({ name: input.name, adapter: adapterForEndpoint(protocol), catalog_mode: "hybrid", auth_kind: input.auth?.kind ?? "none", enabled: true });
    binding = await context.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, priority: 100, enabled: true });
  } catch (error) {
    await compensation();
    throw error;
  }
  try {
    const discovered = await context.discover(provider.id, binding.id);
    // The UI confirms a model selection after testing; persist that choice
    // instead of leaving every discovered model enabled.
    if (input.models) {
      const selected = new Set(input.models);
      await context.repository.update((current) => {
        for (const model of current.models) {
          if (model.provider_id === provider.id) model.enabled = selected.has(model.model_id);
        }
      });
    }
    return { provider, endpoint, credential, binding, discovery: { model_count: discovered.models.length } };
  } catch (error) {
    return { provider, endpoint, credential, binding, discovery_error: error instanceof Error ? error.message : String(error) };
  }
}

export async function updateCustomProvider(context: Context, id: string, input: { name?: string; base_url?: string; api?: Endpoint["api"]; auth?: { kind?: "api_key" | "none"; secret?: string } | null }): Promise<{ provider: Provider; endpoint: Endpoint; binding: ProviderEndpointBinding }> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  const provider = state.providers.find((item) => item.id === id);
  if (!provider || provider.kind !== "user") throw resourceError("resource_not_found", `Custom provider '${id}' was not found`);
  const baseUrl = input.base_url ? normalizeBaseUrl(input.base_url) : undefined;
  let binding = state.bindings.find((item) => item.provider_id === id);
  let endpoint = state.endpoints.find((item) => item.id === binding?.endpoint_id);
  let repairCredential: CredentialMetadata | undefined;
  if (!binding) {
    const owned = state.endpoints.filter((item) => item.owner_provider_id === id);
    if (owned.length > 1) throw resourceError("invalid_resource", "Multiple owned endpoints exist; repair the binding explicitly");
    endpoint = owned[0];
    if (!endpoint) {
      if (!baseUrl) throw resourceError("invalid_resource", "A base URL is required to rebuild this connection");
      if (!["openai-compatible", "anthropic-compatible", "ollama"].includes(provider.adapter)) throw resourceError("invalid_resource", "This adapter requires an explicit endpoint repair");
      const credentials = (await context.credentials.listMetadata()).filter((item) => item.owner_provider_id === id && item.owner_kind !== "mcp");
      if (provider.auth_kind !== "none" && credentials.length > 1) throw resourceError("invalid_resource", "Multiple owned credentials exist; repair the connection explicitly");
      repairCredential = provider.auth_kind === "none" ? undefined : credentials[0];
    }
  } else if (!endpoint) throw resourceError("resource_not_found", `Provider '${id}' connection endpoint was not found`);

  const replacingKey = input.auth?.kind === "api_key" && Boolean(input.auth.secret);
  const changesConnection = endpoint && (
    baseUrl !== undefined && baseUrl !== endpoint.base_url ||
    input.api !== undefined && input.api !== endpoint.api ||
    replacingKey || input.auth?.kind === "none" && Boolean(endpoint.credential_ref)
  );
  // Preflight the entire aggregate before changing provider metadata, endpoint
  // configuration, or secrets (including a missing-binding repair).
  const endpointId = endpoint?.id;
  if (endpoint && changesConnection && state.bindings.some((item) => item.endpoint_id === endpointId && item.provider_id !== id)) {
    throw resourceError("resource_in_use", `Endpoint '${endpoint.id}' is shared with another provider`);
  }
  const credentialRef = endpoint?.credential_ref ?? repairCredential?.id;
  if (replacingKey && credentialRef && (
    state.endpoints.some((item) => item.id !== endpoint?.id && item.credential_ref === credentialRef) ||
    Object.values(state.credential_refs).includes(credentialRef)
  )) throw resourceError("resource_in_use", `Credential '${credentialRef}' is shared with another connection or builtin provider`);

  if (!endpoint) {
    endpoint = await context.createEndpoint({ name: `${provider.name} endpoint`, base_url: baseUrl!, protocol: provider.adapter === "anthropic-compatible" ? "anthropic" : provider.adapter === "ollama" ? "ollama" : "openai", ...(input.api ? { api: input.api } : {}), credential_ref: repairCredential?.id ?? null, enabled: true, data_egress: defaultDataEgress(baseUrl!), owner_provider_id: id });
  }
  if (input.name) await context.updateProvider(id, { name: input.name });
  if (baseUrl !== undefined && baseUrl !== endpoint.base_url || input.api !== undefined && input.api !== endpoint.api) {
    await context.updateEndpoint(endpoint.id, { ...(baseUrl ? { base_url: baseUrl } : {}), ...(input.api ? { api: input.api } : {}) });
  }
  if (input.auth?.kind === "api_key" && input.auth.secret) {
    if (endpoint.credential_ref) {
      await context.credentials.put({ id: endpoint.credential_ref, kind: "api_key", backend: "managed", secret: input.auth.secret, owner_provider_id: provider.id });
    } else {
      const created = await context.credentials.put({ kind: "api_key", backend: "managed", secret: input.auth.secret, label: `${provider.name} key`, owner_provider_id: provider.id });
      await context.updateEndpoint(endpoint.id, { credential_ref: created.id });
    }
  } else if (input.auth?.kind === "none") {
    const endpointRef = endpoint.credential_ref;
    const refs = new Set((await context.credentials.listMetadata()).filter((item) => item.owner_provider_id === provider.id).map((item) => item.id));
    if (endpointRef) refs.add(endpointRef);
    if (endpointRef) await context.updateEndpoint(endpoint.id, { credential_ref: null });
    for (const ref of refs) {
      const current = await context.repository.read();
      const metadata = await context.credentials.metadata(ref);
      const shared = Object.values(current.credential_refs).includes(ref) || current.endpoints.some((item) => item.credential_ref === ref);
      const owned = metadata?.owner_provider_id === provider.id || ref === endpointRef && metadata?.owner_provider_id === undefined;
      if (!shared && owned) await context.credentials.remove(ref);
    }
  }
  if (input.auth?.kind) await context.updateProvider(id, { auth_kind: input.auth.kind });
  if (!binding) {
    try { binding = await context.createBinding({ provider_id: id, endpoint_id: endpoint.id, enabled: true, priority: 100 }); }
    catch { throw resourceError("connection_repair_incomplete", "Connection changes were saved, but the endpoint binding could not be created. Review the saved connection and retry to complete the repair."); }
  }
  const updated = await context.repository.read();
  return { provider: structuredClone(updated.providers.find((item) => item.id === id)!), endpoint: structuredClone(updated.endpoints.find((item) => item.id === endpoint.id)!), binding: structuredClone(updated.bindings.find((item) => item.id === binding.id)!) };
}

export async function deleteCustomProvider(context: Context, id: string): Promise<{ id: string; removed_endpoints: number; removed_credentials: number }> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  const providerExists = state.providers.some((item) => item.id === id);
  const bindingEndpointIds = new Set(state.bindings.filter((binding) => binding.provider_id === id).map((binding) => binding.endpoint_id));
  const otherBindings = state.bindings.filter((binding) => binding.provider_id !== id);
  const removableEndpoints = state.endpoints.filter((endpoint) => {
    const owned = endpoint.owner_provider_id === id || (endpoint.owner_provider_id === undefined && bindingEndpointIds.has(endpoint.id));
    return owned && !otherBindings.some((binding) => binding.endpoint_id === endpoint.id);
  });
  const removableEndpointIds = new Set(removableEndpoints.map((endpoint) => endpoint.id));
  const systemCredentialRefs = new Set(Object.values(state.credential_refs));
  const credentialMetadata = await context.credentials.listMetadata();
  const removableCredentialRefs = new Set<string>();
  for (const endpoint of removableEndpoints) {
    const ref = endpoint.credential_ref;
    if (!ref || systemCredentialRefs.has(ref)) continue;
    const metadata = credentialMetadata.find((item) => item.id === ref);
    if (!metadata || (metadata.owner_provider_id !== id && metadata.owner_provider_id !== undefined)) continue;
    if (state.endpoints.some((item) => !removableEndpointIds.has(item.id) && item.credential_ref === ref)) continue;
    removableCredentialRefs.add(ref);
  }
  for (const metadata of credentialMetadata) {
    if (metadata.owner_provider_id !== id || systemCredentialRefs.has(metadata.id)) continue;
    if (state.endpoints.some((endpoint) => !removableEndpointIds.has(endpoint.id) && endpoint.credential_ref === metadata.id)) continue;
    removableCredentialRefs.add(metadata.id);
  }

  let removedCredentials = 0;
  for (const ref of removableCredentialRefs) if (await context.credentials.remove(ref)) removedCredentials += 1;
  let removedEndpoints = 0;
  for (const endpoint of removableEndpoints) {
    try { await context.deleteEndpoint(endpoint.id, true); removedEndpoints += 1; }
    catch (error) { if (!(error instanceof Error) || !String(error.message).includes("was not found")) throw error; }
  }

  if (providerExists) await context.deleteProvider(id, true);
  else {
    const legacyId = id.startsWith("user-") ? id.slice("user-".length) : id;
    await context.repository.update((current) => {
      const modelRefs = current.models.filter((model) => model.provider_id === id).map((model) => canonicalModelRef(id, model.model_id));
      current.providers = current.providers.filter((provider) => provider.id !== id);
      current.models = current.models.filter((model) => model.provider_id !== id);
      current.bindings = current.bindings.filter((binding) => binding.provider_id !== id);
      for (const [alias, target] of Object.entries(current.aliases)) if (modelRefs.includes(target) || target.startsWith(`${id}/`)) delete current.aliases[alias];
    });
    await context.settings.update((current) => {
      const model = String(current.model ?? "");
      if (model.startsWith(`${id}/`) || model.startsWith(`custom-${legacyId}/`) || model.startsWith(`${legacyId}/`)) current.model = "";
    });
  }
  return { id, removed_endpoints: removedEndpoints, removed_credentials: removedCredentials };
}
