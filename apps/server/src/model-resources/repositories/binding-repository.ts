import type { ProviderEndpointBinding } from "@pi-science/contracts";
import { ModelResourceRepository } from "../model-resource-repository.js";

export class BindingRepository {
  constructor(private readonly resources: ModelResourceRepository = new ModelResourceRepository()) {}

  async list(filters: { provider_id?: string; endpoint_id?: string } = {}): Promise<ProviderEndpointBinding[]> {
    return (await this.resources.read()).bindings.filter((item) => (!filters.provider_id || item.provider_id === filters.provider_id) && (!filters.endpoint_id || item.endpoint_id === filters.endpoint_id));
  }
  async get(id: string): Promise<ProviderEndpointBinding | null> { return (await this.resources.read()).bindings.find((item) => item.id === id) ?? null; }
  async upsert(binding: ProviderEndpointBinding): Promise<ProviderEndpointBinding> { return this.resources.update((state) => { state.bindings = [...state.bindings.filter((item) => item.id !== binding.id), structuredClone(binding)]; return structuredClone(binding); }); }
  async remove(id: string): Promise<void> { await this.resources.update((state) => { state.bindings = state.bindings.filter((item) => item.id !== id); }); }
}
