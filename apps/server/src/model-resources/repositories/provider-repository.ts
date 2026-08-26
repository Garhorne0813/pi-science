import type { Provider } from "@pi-science/contracts";
import { ModelResourceRepository } from "../model-resource-repository.js";

export class ProviderRepository {
  constructor(private readonly resources: ModelResourceRepository = new ModelResourceRepository()) {}

  async list(): Promise<Provider[]> { return (await this.resources.read()).providers; }
  async get(id: string): Promise<Provider | null> { return (await this.resources.read()).providers.find((item) => item.id === id) ?? null; }
  async upsert(provider: Provider): Promise<Provider> { return this.resources.update((state) => { state.providers = [...state.providers.filter((item) => item.id !== provider.id), structuredClone(provider)]; return structuredClone(provider); }); }
  async remove(id: string): Promise<void> { await this.resources.update((state) => { state.providers = state.providers.filter((item) => item.id !== id); }); }
}
