import type { CreateEndpointRequest, Endpoint, UpdateEndpointRequest } from "@pi-science/contracts";
import { ModelResourceService, type HealthResult } from "./model-resource-service.js";

export class EndpointService {
  constructor(private readonly resources: ModelResourceService = new ModelResourceService()) {}
  list(): Promise<Endpoint[]> { return this.resources.listEndpoints(); }
  get(id: string): Promise<Endpoint> { return this.resources.getEndpoint(id); }
  create(input: CreateEndpointRequest): Promise<Endpoint> { return this.resources.createEndpoint(input); }
  update(id: string, input: UpdateEndpointRequest): Promise<Endpoint> { return this.resources.updateEndpoint(id, input); }
  remove(id: string, cascade = false): Promise<{ id: string; removed_bindings: number }> { return this.resources.deleteEndpoint(id, cascade); }
  probe(id: string): Promise<HealthResult> { return this.resources.probeEndpoint(id); }
}
