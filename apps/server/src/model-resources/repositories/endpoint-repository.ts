import type { Endpoint } from "@pi-science/contracts";
import { ModelResourceRepository } from "../model-resource-repository.js";

export class EndpointRepository {
  constructor(private readonly resources: ModelResourceRepository = new ModelResourceRepository()) {}

  async list(): Promise<Endpoint[]> { return (await this.resources.read()).endpoints; }
  async get(id: string): Promise<Endpoint | null> { return (await this.resources.read()).endpoints.find((item) => item.id === id) ?? null; }
  async upsert(endpoint: Endpoint): Promise<Endpoint> { return this.resources.update((state) => { state.endpoints = [...state.endpoints.filter((item) => item.id !== endpoint.id), structuredClone(endpoint)]; return structuredClone(endpoint); }); }
  async remove(id: string): Promise<void> { await this.resources.update((state) => { state.endpoints = state.endpoints.filter((item) => item.id !== id); }); }
}
