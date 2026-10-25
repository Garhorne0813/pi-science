import type { Endpoint, ModelRead, Provider } from "@pi-science/contracts";

export type ProviderRead = Provider & {
  models: string[];
  has_key: boolean;
  credential_status: "configured" | "connected" | "needs_key" | "needs_login" | "invalid";
  routes: number;
};

export type DiscoveryResult = {
  provider: ProviderRead;
  binding_id: string;
  endpoint_id: string;
  models: ModelRead[];
  warnings: string[];
};

export type HealthResult = Endpoint & { error?: string | null };
