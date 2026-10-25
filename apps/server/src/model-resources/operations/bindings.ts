import type { CreateBindingRequest, ProviderEndpointBinding, UpdateBindingRequest } from "@pi-science/contracts";
import { ModelResourceRepository } from "../model-resource-repository.js";
import { resourceError, now, secureHeaderPolicy } from "./validation.js";
import type { ModelResourceContext } from "./context.js";

type Context = Pick<ModelResourceContext, "ensureMigrated" | "repository">;

export async function listBindings(context: Context, filters: { provider_id?: string; endpoint_id?: string } = {}): Promise<ProviderEndpointBinding[]> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  return state.bindings.filter((binding) => (!filters.provider_id || binding.provider_id === filters.provider_id) && (!filters.endpoint_id || binding.endpoint_id === filters.endpoint_id)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export async function createBinding(context: Context, input: CreateBindingRequest): Promise<ProviderEndpointBinding> {
  await context.ensureMigrated();
  const headersPolicy = secureHeaderPolicy(input.headers_policy);
  const bindingId = input.id || ModelResourceRepository.bindingId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bindingId)) throw resourceError("invalid_resource", "Binding ID must be URL-safe");
  const binding: ProviderEndpointBinding = {
    id: bindingId,
    provider_id: input.provider_id,
    endpoint_id: input.endpoint_id,
    enabled: input.enabled,
    priority: input.priority,
    ...(input.model_allowlist ? { model_allowlist: input.model_allowlist } : {}),
    ...(input.model_aliases ? { model_aliases: input.model_aliases } : {}),
    ...(headersPolicy ? { headers_policy: headersPolicy } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    created_at: now(),
    updated_at: now(),
  };
  return context.repository.update((state) => {
    if (!state.providers.some((provider) => provider.id === binding.provider_id)) throw resourceError("resource_not_found", `Provider '${binding.provider_id}' was not found`);
    if (!state.endpoints.some((endpoint) => endpoint.id === binding.endpoint_id)) throw resourceError("resource_not_found", `Endpoint '${binding.endpoint_id}' was not found`);
    if (state.bindings.some((item) => item.provider_id === binding.provider_id && item.endpoint_id === binding.endpoint_id)) throw resourceError("provider_id_conflict", "A provider-endpoint binding already exists");
    state.bindings.push(binding);
    return structuredClone(binding);
  });
}

export async function updateBinding(context: Context, id: string, input: UpdateBindingRequest): Promise<ProviderEndpointBinding> {
  await context.ensureMigrated();
  const headersPolicy = secureHeaderPolicy(input.headers_policy);
  return context.repository.update((state) => {
    const binding = state.bindings.find((item) => item.id === id);
    if (!binding) throw resourceError("resource_not_found", `Binding '${id}' was not found`);
    if (input.enabled !== undefined) binding.enabled = input.enabled;
    if (input.priority !== undefined) binding.priority = input.priority;
    if (input.model_allowlist !== undefined) binding.model_allowlist = input.model_allowlist;
    if (input.model_aliases !== undefined) binding.model_aliases = input.model_aliases;
    if (input.headers_policy !== undefined) binding.headers_policy = headersPolicy;
    if (input.metadata !== undefined) binding.metadata = input.metadata;
    binding.updated_at = now();
    return structuredClone(binding);
  });
}

export async function deleteBinding(context: Context, id: string): Promise<{ id: string }> {
  await context.ensureMigrated();
  return context.repository.update((state) => {
    if (!state.bindings.some((binding) => binding.id === id)) throw resourceError("resource_not_found", `Binding '${id}' was not found`);
    state.bindings = state.bindings.filter((binding) => binding.id !== id);
    return { id };
  });
}
