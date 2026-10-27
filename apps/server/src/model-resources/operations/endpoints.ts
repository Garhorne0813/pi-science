import type { CreateEndpointRequest, Endpoint, UpdateEndpointRequest } from "@pi-science/contracts";
import { egressAuditEnabled, recordEgress } from "../../security/egress-audit.js";
import { safeConnectorFetch, validateOutboundHttpUrl } from "../../security/outbound-security.js";
import { ModelResourceRepository } from "../model-resource-repository.js";
import type { HealthResult } from "./types.js";
import { resourceError, defaultDataEgress, now, normalizeProtocol, normalizeBaseUrl } from "./validation.js";
import { authHeaders, MAX_MODEL_DISCOVERY_BYTES, discoveryPath } from "./discovery-http.js";
import type { ModelResourceContext } from "./context.js";

type Context = Pick<ModelResourceContext, "credentials" | "ensureMigrated" | "getEndpoint" | "listEndpoints" | "repository" | "settings" | "updateEndpoint">;

export async function listEndpoints(context: Context): Promise<Endpoint[]> {
  await context.ensureMigrated();
  return (await context.repository.read()).endpoints;
}

export async function getEndpoint(context: Context, id: string): Promise<Endpoint> {
  const endpoint = (await context.listEndpoints()).find((item) => item.id === id);
  if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
  return endpoint;
}

export async function createEndpoint(context: Context, input: CreateEndpointRequest): Promise<Endpoint> {
  await context.ensureMigrated();
  const baseUrl = normalizeBaseUrl(input.base_url);
  const protocol = normalizeProtocol(input.protocol);
  if (input.credential_ref !== undefined && input.credential_ref !== null && !(await context.credentials.metadata(input.credential_ref))) throw resourceError("resource_not_found", `Credential '${input.credential_ref}' was not found`);
  const endpointId = input.id || ModelResourceRepository.endpointId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(endpointId)) throw resourceError("invalid_resource", "Endpoint ID must be URL-safe");
  const endpoint: Endpoint = {
    id: endpointId,
    name: input.name.trim(),
    base_url: baseUrl,
    protocol,
    ...(input.api ? { api: input.api } : {}),
    credential_ref: input.credential_ref ?? null,
    enabled: input.enabled,
    health: "unknown",
    data_egress: input.data_egress,
    ...(input.owner_provider_id ? { owner_provider_id: input.owner_provider_id } : {}),
    ...(input.rate_limit ? { rate_limit: input.rate_limit } : {}),
    ...(input.network_policy ? { network_policy: input.network_policy } : {}),
    last_checked_at: null,
    last_error: null,
    created_at: now(),
    updated_at: now(),
  };
  return context.repository.update((state) => {
    if (state.endpoints.some((item) => item.id === endpoint.id)) throw resourceError("provider_id_conflict", `Endpoint ID '${endpoint.id}' already exists`);
    state.endpoints.push(endpoint);
    return structuredClone(endpoint);
  });
}

export async function updateEndpoint(context: Context, id: string, input: UpdateEndpointRequest): Promise<Endpoint> {
  await context.ensureMigrated();
  if (input.credential_ref !== undefined && input.credential_ref !== null && !(await context.credentials.metadata(input.credential_ref))) throw resourceError("resource_not_found", `Credential '${input.credential_ref}' was not found`);
  return context.repository.update((state) => {
    const endpoint = state.endpoints.find((item) => item.id === id);
    if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
    if (input.name !== undefined) endpoint.name = input.name.trim();
    if (input.base_url !== undefined) {
      const baseUrl = normalizeBaseUrl(input.base_url);
      // Preserve an explicit classification, but never carry an inferred
      // local/remote label across an address change.
      if (baseUrl !== endpoint.base_url && input.data_egress === undefined) endpoint.data_egress = defaultDataEgress(baseUrl);
      endpoint.base_url = baseUrl;
    }
    if (input.protocol !== undefined) endpoint.protocol = normalizeProtocol(input.protocol);
    if (input.api !== undefined) endpoint.api = input.api;
    if (input.credential_ref !== undefined) endpoint.credential_ref = input.credential_ref;
    if (input.enabled !== undefined) {
      endpoint.enabled = input.enabled;
      if (input.enabled) {
        endpoint.health = "unknown";
        endpoint.last_error = null;
      } else {
        endpoint.health = "blocked";
      }
    }
    if (input.data_egress !== undefined) endpoint.data_egress = input.data_egress;
    if (input.rate_limit !== undefined) endpoint.rate_limit = input.rate_limit;
    if (input.network_policy !== undefined) endpoint.network_policy = input.network_policy;
    endpoint.updated_at = now();
    return structuredClone(endpoint);
  });
}

export async function deleteEndpoint(context: Context, id: string, cascade = false): Promise<{ id: string; removed_bindings: number }> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  if (!state.endpoints.some((endpoint) => endpoint.id === id)) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
  const bindings = state.bindings.filter((binding) => binding.endpoint_id === id);
  if (bindings.length > 0 && !cascade) throw resourceError("resource_in_use", `Endpoint '${id}' is still referenced by bindings`);
  await context.repository.update((current) => {
    current.endpoints = current.endpoints.filter((endpoint) => endpoint.id !== id);
    current.bindings = current.bindings.filter((binding) => binding.endpoint_id !== id);
  });
  return { id, removed_bindings: bindings.length };
}

export async function setEndpointEnabled(context: Context, id: string, enabled: boolean): Promise<Endpoint> {
  return context.updateEndpoint(id, { enabled });
}

export async function probeEndpoint(context: Context, id: string): Promise<HealthResult> {
  await context.ensureMigrated();
  const endpoint = await context.getEndpoint(id);
  if (!endpoint.enabled) {
    return updateHealth(context, id, "blocked", "endpoint disabled");
  }
  try {
    const settings = await context.settings.read();
    const allowPrivate = endpoint.network_policy?.allow_private ?? (settings.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0");
    await validateOutboundHttpUrl(endpoint.base_url, { allowPrivate });
    if (await egressAuditEnabled()) await recordEgress({ connector_type: "connector", connector_id: `endpoint-health:${endpoint.id}`, target_domain: endpoint.base_url, approved: true, note: `endpoint_id=${endpoint.id}` });
    const credential = endpoint.credential_ref ? await context.credentials.getForRuntime(endpoint.credential_ref) : null;
    const response = await safeConnectorFetch(discoveryPath(endpoint), {
      allowPrivate,
      maxRedirects: 3,
      maxResponseBytes: MAX_MODEL_DISCOVERY_BYTES,
      timeoutMs: 8_000,
      headers: { ...authHeaders(endpoint.protocol, credential?.secret ?? null) },
    });
    await response.body?.cancel();
    return updateHealth(context, id, response.ok ? "ready" : "degraded", response.ok ? null : `endpoint returned ${response.status}`);
  } catch (error) {
    return updateHealth(context, id, "error", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
  }
}

export async function updateHealth(context: Pick<ModelResourceContext, "repository">, id: string, health: Endpoint["health"], error: string | null): Promise<HealthResult> {
  return context.repository.update((state) => {
    const endpoint = state.endpoints.find((item) => item.id === id);
    if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
    endpoint.health = health;
    endpoint.last_checked_at = now();
    endpoint.last_error = error;
    endpoint.updated_at = now();
    return structuredClone(endpoint);
  });
}
