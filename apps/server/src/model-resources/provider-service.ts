import type { CreateProviderRequest, Provider, UpdateProviderRequest } from "@pi-science/contracts";
import { ModelResourceService, type ProviderRead } from "./model-resource-service.js";

/** Provider-focused facade used by HTTP adapters and future orchestration
 * commands. The aggregate service remains the transaction boundary. */
export class ProviderService {
  constructor(private readonly resources: ModelResourceService = new ModelResourceService()) {}
  list(): Promise<ProviderRead[]> { return this.resources.listProviders(); }
  get(id: string): Promise<ProviderRead> { return this.resources.getProvider(id); }
  create(input: CreateProviderRequest): Promise<Provider> { return this.resources.createProvider(input); }
  update(id: string, input: UpdateProviderRequest): Promise<Provider> { return this.resources.updateProvider(id, input); }
  remove(id: string, cascade = false): Promise<{ id: string; removed_models: number; removed_bindings: number }> { return this.resources.deleteProvider(id, cascade); }
}
