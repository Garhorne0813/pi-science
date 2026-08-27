import type { Model } from "@pi-science/contracts";
import { ModelResourceRepository } from "../model-resource-repository.js";

export class ModelRepository {
  constructor(private readonly resources: ModelResourceRepository = new ModelResourceRepository()) {}

  async list(providerId?: string): Promise<Model[]> { return (await this.resources.read()).models.filter((item) => !providerId || item.provider_id === providerId); }
  async get(providerId: string, modelId: string): Promise<Model | null> { return (await this.list(providerId)).find((item) => item.model_id === modelId) ?? null; }
  async upsert(model: Model): Promise<Model> { return this.resources.update((state) => { state.models = [...state.models.filter((item) => item.provider_id !== model.provider_id || item.model_id !== model.model_id), structuredClone(model)]; return structuredClone(model); }); }
  async remove(providerId: string, modelId: string): Promise<void> { await this.resources.update((state) => { state.models = state.models.filter((item) => item.provider_id !== providerId || item.model_id !== modelId); }); }
}
