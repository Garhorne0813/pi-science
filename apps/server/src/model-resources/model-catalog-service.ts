import type { ModelCapabilities, ModelRead } from "@pi-science/contracts";
import { ModelResourceService } from "./model-resource-service.js";

export class ModelCatalogService {
  constructor(private readonly resources: ModelResourceService = new ModelResourceService()) {}
  list(filters: { provider_id?: string; available?: boolean } = {}): Promise<ModelRead[]> { return this.resources.listModels(filters); }
  get(providerId: string, modelId: string): Promise<ModelRead> { return this.resources.getModel(providerId, modelId); }
  update(providerId: string, modelId: string, body: Record<string, unknown>): Promise<ModelRead> { return this.resources.updateModel(providerId, modelId, body); }
  applyRuntime(providerId: string, modelId: string, capabilities: Partial<ModelCapabilities>) { return this.resources.applyRuntimeCapabilities(providerId, modelId, capabilities); }
}
