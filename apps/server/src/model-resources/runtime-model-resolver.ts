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
import { CredentialStore, type CredentialRuntimeValue } from "./credential-store.js";
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

type ResolutionIndex = {
  providers: Map<string, Provider>;
  endpoints: Map<string, Endpoint>;
  bindings: Map<string, ProviderEndpointBinding[]>;
  providerEndpoints: Map<string, Endpoint[]>;
  allowlists: Map<string, Set<string>>;
  syncCredentials: Map<string, CredentialRuntimeValue | null>;
  asyncCredentials: Map<string, Promise<CredentialRuntimeValue | null>>;
};

/** Indexes and credentials live for one resource snapshot, never across reads. */
function indexState(state: ModelResourceState): ResolutionIndex {
  const index: ResolutionIndex = {
    providers: new Map(state.providers.map((provider) => [provider.id, provider])),
    endpoints: new Map(state.endpoints.map((endpoint) => [endpoint.id, endpoint])),
    bindings: new Map(), providerEndpoints: new Map(), allowlists: new Map(),
    syncCredentials: new Map(), asyncCredentials: new Map(),
  };
  for (const binding of state.bindings) {
    if (!binding.enabled) continue;
    const bindings = index.bindings.get(binding.provider_id) ?? [];
    bindings.push(binding);
    index.bindings.set(binding.provider_id, bindings);
    if (binding.model_allowlist) index.allowlists.set(binding.id, new Set(binding.model_allowlist));
  }
  for (const [provider, bindings] of index.bindings) {
    bindings.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    index.providerEndpoints.set(provider, [...new Set(bindings.map((binding) => index.endpoints.get(binding.endpoint_id)).filter((endpoint): endpoint is Endpoint => Boolean(endpoint)))]);
  }
  return index;
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
    return this.resolveState(state);
  }

  async resolveState(state: ModelResourceState): Promise<ResolvedRuntimeModel[]> {
    const index = indexState(state);
    return Promise.all(state.models.map((model) => this.resolveModelFromStateAsync(index, model)));
  }

  resolveStateSync(state: ModelResourceState): ResolvedRuntimeModel[] {
    const index = indexState(state);
    return state.models.map((model) => this.resolveModelFromState(index, model));
  }

  async resolveModelRoute(ref: string): Promise<ResolvedRoute | null> {
    const state = await this.repository.read();
    const canonical = state.aliases[ref] ?? ref;
    const model = state.models.find((item) => canonicalModelRef(item.provider_id, item.model_id) === canonical);
    if (!model) return null;
    const resolved = await this.resolveModelFromStateAsync(indexState(state), model);
    return resolved.routes[0] ?? null;
  }

  private resolveModelFromState(index: ResolutionIndex, model: Model): ResolvedRuntimeModel {
    const provider = index.providers.get(model.provider_id);
    const bindings = index.bindings.get(model.provider_id) ?? [];
    const routes: ResolvedRoute[] = [];
    let credentialMissing = false;
    for (const binding of bindings) {
      if (!provider?.enabled || !model.enabled) continue;
      const endpoint = index.endpoints.get(binding.endpoint_id);
      if (!endpoint || !endpoint.enabled || endpoint.health === "blocked" || (!this.policy.allow_error_health && endpoint.health === "error")) continue;
      if (index.allowlists.has(binding.id) && !index.allowlists.get(binding.id)!.has(model.model_id)) continue;
      const modelId = binding.model_aliases?.[model.model_id] ?? model.model_id;
      if (provider?.auth_kind !== "none") {
        if (!endpoint.credential_ref) { credentialMissing = true; continue; }
        // This async-independent pass only has metadata from the state. The
        // full async resolver checks the secret below before accepting a route.
        if (!index.syncCredentials.has(endpoint.credential_ref)) index.syncCredentials.set(endpoint.credential_ref, this.credentials.resolveSync(endpoint.credential_ref));
        const metadata = index.syncCredentials.get(endpoint.credential_ref)?.metadata;
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
      ...(available ? {} : { availability_reason: routeFailureReason(provider, bindings, index.providerEndpoints.get(model.provider_id) ?? [], credentialMissing, model.enabled) }),
    };
  }

  private async resolveModelFromStateAsync(index: ResolutionIndex, model: Model): Promise<ResolvedRuntimeModel> {
    const provider = index.providers.get(model.provider_id);
    const bindings = index.bindings.get(model.provider_id) ?? [];
    const routes: ResolvedRoute[] = [];
    let credentialMissing = false;
    for (const binding of bindings) {
      if (!provider?.enabled || !model.enabled) continue;
      const endpoint = index.endpoints.get(binding.endpoint_id);
      if (!endpoint || !endpoint.enabled || endpoint.health === "blocked" || (!this.policy.allow_error_health && endpoint.health === "error")) continue;
      if (index.allowlists.has(binding.id) && !index.allowlists.get(binding.id)!.has(model.model_id)) continue;
      const modelId = binding.model_aliases?.[model.model_id] ?? model.model_id;
      if (provider?.auth_kind !== "none") {
        if (!endpoint.credential_ref) { credentialMissing = true; continue; }
        if (!index.asyncCredentials.has(endpoint.credential_ref)) index.asyncCredentials.set(endpoint.credential_ref, this.credentials.resolve(endpoint.credential_ref));
        const credential = await index.asyncCredentials.get(endpoint.credential_ref);
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
      ...(available ? {} : { availability_reason: routeFailureReason(provider, bindings, index.providerEndpoints.get(model.provider_id) ?? [], credentialMissing, model.enabled) }),
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
