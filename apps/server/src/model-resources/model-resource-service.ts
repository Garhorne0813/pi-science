import type { CreateBindingRequest, CreateEndpointRequest, CreateProviderRequest, CredentialMetadata, Endpoint, Model, ModelCapabilities, ModelRead, Provider, ProviderView, ProviderEndpointBinding, UpdateBindingRequest, UpdateEndpointRequest, UpdateProviderRequest } from "@pi-science/contracts";
import type { RuntimeCatalog, RuntimeCatalogService } from "../runtime/agent/runtime-catalog.js";
import { SettingsStore } from "../storage/settings-store.js";
import { CredentialStore } from "./credential-store.js";
import type { CapabilityPatch } from "./capability-resolver.js";
import type { MigrationResult } from "./migration/migrate-custom-providers.js";
import { ModelResourceRepository } from "./model-resource-repository.js";
import { RuntimeModelResolver } from "./runtime-model-resolver.js";
import type { ModelResourceContext } from "./operations/context.js";
import type { ProviderRead, DiscoveryResult, HealthResult } from "./operations/types.js";
import { isModelAvailable, listProviders, providerViews, getProvider, listModels, getModel } from "./operations/reads.js";
import { createProvider, upsertLegacyProvider, updateProvider, deleteProvider } from "./operations/providers.js";
import { createCustomProvider, updateCustomProvider, deleteCustomProvider } from "./operations/custom-providers.js";
import { listEndpoints, getEndpoint, createEndpoint, updateEndpoint, deleteEndpoint, setEndpointEnabled, probeEndpoint } from "./operations/endpoints.js";
import { listBindings, createBinding, updateBinding, deleteBinding } from "./operations/bindings.js";
import { updateModel, applyRuntimeCapabilities, deleteModel } from "./operations/models.js";
import { testProviderConfiguration, discover } from "./operations/discovery.js";

/** Public model-resource API; operations share one repository/credential context. */
export class ModelResourceService {
  readonly repository: ModelResourceRepository;
  readonly credentials: CredentialStore;
  private readonly settings: SettingsStore;
  private readonly runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">;
  private readonly context: ModelResourceContext;
  constructor(options: { repository?: ModelResourceRepository; credentials?: CredentialStore; settings?: SettingsStore; runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog"> } = {}) {
    this.repository = options.repository ?? new ModelResourceRepository();
    this.credentials = options.credentials ?? new CredentialStore();
    this.settings = options.settings ?? new SettingsStore();
    this.runtimeCatalog = options.runtimeCatalog;
      this.context = {
      repository: this.repository, credentials: this.credentials, settings: this.settings, runtimeCatalog: this.runtimeCatalog,
      ensureMigrated: (...args) => this.ensureMigrated(...args),
      resolveAvailableModels: (...args) => this.resolveAvailableModels(...args),
      resolveModelRoute: (...args) => this.resolveModelRoute(...args),
      isModelAvailable: (...args) => this.isModelAvailable(...args),
      listProviders: (...args) => this.listProviders(...args),
      providerViews: (...args) => this.providerViews(...args),
      getProvider: (...args) => this.getProvider(...args),
      createProvider: (...args) => this.createProvider(...args),
      upsertLegacyProvider: (...args) => this.upsertLegacyProvider(...args),
      updateProvider: (...args) => this.updateProvider(...args),
      deleteProvider: (...args) => this.deleteProvider(...args),
      createCustomProvider: (...args) => this.createCustomProvider(...args),
      updateCustomProvider: (...args) => this.updateCustomProvider(...args),
      deleteCustomProvider: (...args) => this.deleteCustomProvider(...args),
      testProviderConfiguration: (...args) => this.testProviderConfiguration(...args),
      listEndpoints: (...args) => this.listEndpoints(...args),
      getEndpoint: (...args) => this.getEndpoint(...args),
      createEndpoint: (...args) => this.createEndpoint(...args),
      updateEndpoint: (...args) => this.updateEndpoint(...args),
      deleteEndpoint: (...args) => this.deleteEndpoint(...args),
      setEndpointEnabled: (...args) => this.setEndpointEnabled(...args),
      probeEndpoint: (...args) => this.probeEndpoint(...args),
      listBindings: (...args) => this.listBindings(...args),
      createBinding: (...args) => this.createBinding(...args),
      updateBinding: (...args) => this.updateBinding(...args),
      deleteBinding: (...args) => this.deleteBinding(...args),
      listModels: (...args) => this.listModels(...args),
      getModel: (...args) => this.getModel(...args),
      updateModel: (...args) => this.updateModel(...args),
      applyRuntimeCapabilities: (...args) => this.applyRuntimeCapabilities(...args),
      deleteModel: (...args) => this.deleteModel(...args),
      discover: (...args) => this.discover(...args),
      migrationStatus: (...args) => this.migrationStatus(...args),
      modelPreferences: (...args) => this.modelPreferences(...args),
    };
  }
  async ensureMigrated(): Promise<MigrationResult> {
    // Archived resource tooling must never activate old settings during normal use.
    return { migrated: false, provider_count: 0, model_count: 0, endpoint_count: 0, binding_count: 0, warnings: [] };
  }
  async resolveAvailableModels() {
    await this.ensureMigrated();
    return new RuntimeModelResolver(this.repository, this.credentials).resolveAvailableModels();
  }
  async resolveModelRoute(ref: string) {
    await this.ensureMigrated();
    return new RuntimeModelResolver(this.repository, this.credentials).resolveModelRoute(ref);
  }
  isModelAvailable(ref: string): Promise<boolean> { return isModelAvailable(this.context, ref); }
  listProviders(catalog?: RuntimeCatalog): Promise<ProviderRead[]> { return listProviders(this.context, catalog); }
  providerViews(selectable: Set<string>, inputFormats: Map<string, string[]> = new Map(), catalogAvailable = true): Promise<ProviderView[]> { return providerViews(this.context, selectable, inputFormats, catalogAvailable); }
  getProvider(id: string): Promise<ProviderRead> { return getProvider(this.context, id); }
  createProvider(input: CreateProviderRequest): Promise<Provider> { return createProvider(this.context, input); }
  upsertLegacyProvider(input: {
    id: string;
    name: string;
    base_url: string;
    api: string;
    models: string[];
    api_key?: string;
    reasoning?: boolean;
    context_window?: number;
    model_hints?: Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string }>;
  }): Promise<{ provider: Provider; endpoint: Endpoint; binding: ProviderEndpointBinding; models: Model[] }> { return upsertLegacyProvider(this.context, input); }
  updateProvider(id: string, input: UpdateProviderRequest): Promise<Provider> { return updateProvider(this.context, id, input); }
  deleteProvider(id: string, cascade = false): Promise<{ id: string; removed_models: number; removed_bindings: number }> { return deleteProvider(this.context, id, cascade); }
  createCustomProvider(input: { name: string; base_url: string; protocol?: Endpoint["protocol"]; api?: Endpoint["api"]; data_egress?: Endpoint["data_egress"]; auth?: { kind: "api_key" | "none"; secret?: string } | null; models?: string[] }): Promise<{ provider: Provider; endpoint: Endpoint; credential: CredentialMetadata | null; binding: ProviderEndpointBinding; discovery?: { model_count: number }; discovery_error?: string }> { return createCustomProvider(this.context, input); }
  updateCustomProvider(id: string, input: { name?: string; base_url?: string; api?: Endpoint["api"]; auth?: { kind?: "api_key" | "none"; secret?: string } | null }): Promise<{ provider: Provider; endpoint: Endpoint; binding: ProviderEndpointBinding }> { return updateCustomProvider(this.context, id, input); }
  deleteCustomProvider(id: string): Promise<{ id: string; removed_endpoints: number; removed_credentials: number }> { return deleteCustomProvider(this.context, id); }
  testProviderConfiguration(input: { protocol: Endpoint["protocol"]; base_url: string; api?: Endpoint["api"]; auth?: { kind: "api_key" | "none"; secret?: string } | null }): Promise<{ ok: true; health: "ready"; models: Array<{ id: string; display_name: string; kind?: "chat" | "embedding" | "rerank" | "unknown"; capabilities: CapabilityPatch }> }> { return testProviderConfiguration(this.context, input); }
  listEndpoints(): Promise<Endpoint[]> { return listEndpoints(this.context); }
  getEndpoint(id: string): Promise<Endpoint> { return getEndpoint(this.context, id); }
  createEndpoint(input: CreateEndpointRequest): Promise<Endpoint> { return createEndpoint(this.context, input); }
  updateEndpoint(id: string, input: UpdateEndpointRequest): Promise<Endpoint> { return updateEndpoint(this.context, id, input); }
  deleteEndpoint(id: string, cascade = false): Promise<{ id: string; removed_bindings: number }> { return deleteEndpoint(this.context, id, cascade); }
  setEndpointEnabled(id: string, enabled: boolean): Promise<Endpoint> { return setEndpointEnabled(this.context, id, enabled); }
  probeEndpoint(id: string): Promise<HealthResult> { return probeEndpoint(this.context, id); }
  listBindings(filters: { provider_id?: string; endpoint_id?: string } = {}): Promise<ProviderEndpointBinding[]> { return listBindings(this.context, filters); }
  createBinding(input: CreateBindingRequest): Promise<ProviderEndpointBinding> { return createBinding(this.context, input); }
  updateBinding(id: string, input: UpdateBindingRequest): Promise<ProviderEndpointBinding> { return updateBinding(this.context, id, input); }
  deleteBinding(id: string): Promise<{ id: string }> { return deleteBinding(this.context, id); }
  listModels(filters: { provider_id?: string; available?: boolean } = {}, catalog?: RuntimeCatalog): Promise<ModelRead[]> { return listModels(this.context, filters, catalog); }
  getModel(providerId: string, modelId: string): Promise<ModelRead> { return getModel(this.context, providerId, modelId); }
  updateModel(providerId: string, modelId: string, body: Record<string, unknown>): Promise<ModelRead> { return updateModel(this.context, providerId, modelId, body); }
  applyRuntimeCapabilities(providerId: string, modelId: string, patch: Partial<ModelCapabilities>): Promise<Model | null> { return applyRuntimeCapabilities(this.context, providerId, modelId, patch); }
  deleteModel(providerId: string, modelId: string): Promise<{ provider_id: string; model_id: string; default_cleared: boolean }> { return deleteModel(this.context, providerId, modelId); }
  discover(providerId: string, bindingId?: string): Promise<DiscoveryResult> { return discover(this.context, providerId, bindingId); }
  async migrationStatus(): Promise<MigrationResult> {
    return this.ensureMigrated();
  }
  async modelPreferences(): Promise<{ default_model: string | null; thinking: string; compaction_enabled: boolean; compaction_threshold_percent: number }> {
    await this.ensureMigrated();
    const settings = await this.settings.read();
    return {
      default_model: typeof settings.model === "string" && settings.model ? settings.model : null,
      thinking: typeof settings.thinking === "string" && settings.thinking ? settings.thinking : "off",
      compaction_enabled: settings.compaction_enabled !== false,
      compaction_threshold_percent: typeof settings.compaction_threshold_percent === "number" ? settings.compaction_threshold_percent : 85,
    };
  }
}
export type { ProviderRead, DiscoveryResult, HealthResult } from "./operations/types.js";
export { providerReadToLegacy, modelResourceHash } from "./operations/compatibility.js";
