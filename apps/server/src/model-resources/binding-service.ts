import type { CreateBindingRequest, ProviderEndpointBinding, UpdateBindingRequest } from "@pi-science/contracts";
import { ModelResourceService } from "./model-resource-service.js";

export class BindingService {
  constructor(private readonly resources: ModelResourceService = new ModelResourceService()) {}
  list(filters: { provider_id?: string; endpoint_id?: string } = {}): Promise<ProviderEndpointBinding[]> { return this.resources.listBindings(filters); }
  create(input: CreateBindingRequest): Promise<ProviderEndpointBinding> { return this.resources.createBinding(input); }
  update(id: string, input: UpdateBindingRequest): Promise<ProviderEndpointBinding> { return this.resources.updateBinding(id, input); }
  remove(id: string): Promise<{ id: string }> { return this.resources.deleteBinding(id); }
}
