import type {
  Endpoint,
  Model,
  ModelRead,
  ModelResourceState,
  Provider,
  ProviderEndpointBinding,
  ResolvedRoute,
  ResolvedRuntimeModel,
} from "@pi-science/contracts";
import { CredentialResolver } from "./credential-resolver.js";
import { CredentialStore } from "./credential-store.js";
import { ModelResourceRepository } from "./model-resource-repository.js";
import { resolveCapabilities } from "./capability-resolver.js";

export type RuntimeRoutePolicy = {
  allow_error_health?: boolean;
};

export function canonicalModelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function routeSort(a: ResolvedRoute, b: ResolvedRoute): number {
  return a.priority - b.priority || a.binding_id.localeCompare(b.binding_id);
}

function routeFailureReason(provider: Provider | undefined, bindings: ProviderEndpointBinding[], endpoints: Endpoint[], credentialMissing: boolean, modelEnabled = true): string {
  if (!provider) return "provider_missing";
  if (!modelEnabled) return "model_disabled";
  if (!provider.enabled) return "provider_disabled";
  if (bindings.length === 0) return "no_binding";
  if (credentialMissing) return "missing_credential";
  if (endpoints.some((endpoint) => !endpoint.enabled)) return "disabled_endpoint";
  if (endpoints.some((endpoint) => endpoint.health === "blocked")) return "blocked";
  if (endpoints.some((endpoint) => endpoint.health === "error")) return "endpoint_error";
  return "no_routable_endpoint";
}

export class RuntimeModelResolver {
  private readonly credentials: CredentialResolver;

  constructor(
    private readonly repository: ModelResourceRepository,
    credentials: CredentialStore | CredentialResolver,
    private readonly policy: RuntimeRoutePolicy = {},
  ) {
    this.credentials = credentials instanceof CredentialResolver ? credentials : new CredentialResolver(credentials);
  }

  async resolveAvailableModels(): Promise<ResolvedRuntimeModel[]> {
    const state = await this.repository.read();
    return Promise.all(state.models.map((model) => this.resolveModelFromStateAsync(state, model)));
  }

  resolveStateSync(state: ModelResourceState): ResolvedRuntimeModel[] {
    // The sync path is used by the runtime projection. It reads only the
    // already persisted resource snapshot; credential values are loaded by the
    // projection itself, while this resolver can still classify metadata.
    return state.models.map((model) => this.resolveModelFromState(state, model));
  }

  async resolveModelRoute(ref: string): Promise<ResolvedRoute | null> {
    const state = await this.repository.read();
    const canonical = state.aliases[ref] ?? ref;
    const resolved = (await Promise.all(state.models.map((model) => this.resolveModelFromStateAsync(state, model)))).find((item) => item.id === canonical);
    return resolved?.routes[0] ?? null;
  }

  private resolveModelFromState(state: ModelResourceState, model: Model): ResolvedRuntimeModel {
    const provider = state.providers.find((candidate) => candidate.id === model.provider_id);
    const bindings = state.bindings
      .filter((binding) => binding.provider_id === model.provider_id && binding.enabled)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const endpoints = state.endpoints;
    const routes: ResolvedRoute[] = [];
    let credentialMissing = false;
    for (const binding of bindings) {
      if (!provider?.enabled || !model.enabled) continue;
      const endpoint = endpoints.find((candidate) => candidate.id === binding.endpoint_id);
      if (!endpoint || !endpoint.enabled || endpoint.health === "blocked" || (!this.policy.allow_error_health && endpoint.health === "error")) continue;
      if (binding.model_allowlist && !binding.model_allowlist.includes(model.model_id)) continue;
      const modelId = binding.model_aliases?.[model.model_id] ?? model.model_id;
      if (provider?.auth_kind !== "none") {
        if (!endpoint.credential_ref) { credentialMissing = true; continue; }
        // This async-independent pass only has metadata from the state. The
        // full async resolver checks the secret below before accepting a route.
        const metadata = this.credentials.resolveSync(endpoint.credential_ref)?.metadata;
        if (!metadata || !["configured", "connected"].includes(metadata.status)) { credentialMissing = true; continue; }
      }
      routes.push(this.route(provider, endpoint, binding, modelId));
    }
    const capabilities = resolveCapabilities(model.model_id, [{ ...model.capabilities, source: model.capability_source, verified_at: model.verified_at }]);
    const available = Boolean(provider?.enabled && model.enabled && routes.length > 0);
    return {
      id: canonicalModelRef(model.provider_id, model.model_id),
      provider_id: model.provider_id,
      model_id: model.model_id,
      display_name: model.display_name,
      available,
      capabilities: capabilities.capabilities,
      capability_source: capabilities.capability_source,
      routes: routes.sort(routeSort),
      ...(available ? {} : { availability_reason: routeFailureReason(provider, bindings, endpoints.filter((endpoint) => bindings.some((binding) => binding.endpoint_id === endpoint.id)), credentialMissing, model.enabled) }),
    };
  }

  private async resolveModelFromStateAsync(state: ModelResourceState, model: Model): Promise<ResolvedRuntimeModel> {
    const provider = state.providers.find((candidate) => candidate.id === model.provider_id);
    const bindings = state.bindings
      .filter((binding) => binding.provider_id === model.provider_id && binding.enabled)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const routes: ResolvedRoute[] = [];
    let credentialMissing = false;
    for (const binding of bindings) {
      if (!provider?.enabled || !model.enabled) continue;
      const endpoint = state.endpoints.find((candidate) => candidate.id === binding.endpoint_id);
      if (!endpoint || !endpoint.enabled || endpoint.health === "blocked" || (!this.policy.allow_error_health && endpoint.health === "error")) continue;
      if (binding.model_allowlist && !binding.model_allowlist.includes(model.model_id)) continue;
      const modelId = binding.model_aliases?.[model.model_id] ?? model.model_id;
      if (provider?.auth_kind !== "none") {
        if (!endpoint.credential_ref) { credentialMissing = true; continue; }
        const credential = await this.credentials.resolve(endpoint.credential_ref);
        if (!credential || !["configured", "connected"].includes(credential.metadata.status) || (credential.metadata.kind !== "none" && !credential.secret)) {
          credentialMissing = true;
          continue;
        }
      }
      routes.push(this.route(provider, endpoint, binding, modelId));
    }
    const capabilities = resolveCapabilities(model.model_id, [{ ...model.capabilities, source: model.capability_source, verified_at: model.verified_at }]);
    const available = Boolean(provider?.enabled && model.enabled && routes.length > 0);
    return {
      id: canonicalModelRef(model.provider_id, model.model_id),
      provider_id: model.provider_id,
      model_id: model.model_id,
      display_name: model.display_name,
      available,
      capabilities: capabilities.capabilities,
      capability_source: capabilities.capability_source,
      routes: routes.sort(routeSort),
      ...(available ? {} : { availability_reason: routeFailureReason(provider, bindings, state.endpoints.filter((endpoint) => bindings.some((binding) => binding.endpoint_id === endpoint.id)), credentialMissing, model.enabled) }),
    };
  }

  private route(provider: Provider | undefined, endpoint: Endpoint, binding: ProviderEndpointBinding, modelId: string): ResolvedRoute {
    return {
      binding_id: binding.id,
      provider_id: provider?.id ?? binding.provider_id,
      endpoint_id: endpoint.id,
      base_url: endpoint.base_url,
      protocol: endpoint.protocol,
      ...(binding.metadata?.api || endpoint.api ? { api: binding.metadata?.api ?? endpoint.api } : {}),
      model_id: modelId,
      priority: binding.priority,
      health: endpoint.health,
      credential_ref: endpoint.credential_ref,
      unverified: endpoint.health === "unknown",
    };
  }
}

export function resolvedModelToRead(model: ResolvedRuntimeModel, sourceModel?: Model): ModelRead {
  return {
    provider_id: model.provider_id,
    model_id: model.model_id,
    display_name: model.display_name,
    enabled: sourceModel?.enabled ?? true,
    capabilities: model.capabilities,
    capability_source: model.capability_source,
    verified_at: sourceModel?.verified_at ?? null,
    discovered_at: sourceModel?.discovered_at ?? null,
    id: model.id,
    available: model.available,
    ...(model.availability_reason ? { availability_reason: model.availability_reason } : {}),
    routes: model.routes.map((route) => ({
      binding_id: route.binding_id,
      endpoint_id: route.endpoint_id,
      health: route.health,
      priority: route.priority,
      ...(route.api ? { api: route.api } : {}),
      model_id: route.model_id,
    })),
  };
}
