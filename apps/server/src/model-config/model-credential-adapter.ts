import type { CredentialStore as PiCredentialStore, Credential } from "@earendil-works/pi-ai";
import type { ModelConfigSnapshot } from "@pi-science/contracts";
import { ModelConfigService, configError, isAllowedModelEnvRef } from "./model-config-service.js";

/** No ambient environment or file auth. Only explicitly mapped API keys are exposed. */
export class ModelCredentialAdapter implements PiCredentialStore {
  constructor(private readonly service = new ModelConfigService(), private readonly snapshot?: ModelConfigSnapshot) {}
  private state() { return this.snapshot ?? this.service.readSync(); }
  async read(providerId: string): Promise<Credential | undefined> {
    const ref = this.state().credential_refs[providerId];
    const item = ref ? await this.service.credentials.getForRuntime(ref) : null;
    if (item?.metadata.backend === "environment" && !isAllowedModelEnvRef(item.metadata.environment_variable)) return undefined;
    return item?.secret && item.metadata.kind === "api_key" && ["managed", "environment"].includes(item.metadata.backend)
      ? { type: "api_key", key: item.secret } : undefined;
  }
  async list() {
    const state = this.state();
    const metadata = await this.service.credentials.listMetadata();
    return Object.entries(state.credential_refs).flatMap(([providerId, ref]) => metadata.some((item) => item.id === ref && item.kind === "api_key") ? [{ providerId, type: "api_key" as const }] : []);
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    if (this.snapshot) throw configError("snapshot_readonly", "Worker credential snapshots are read-only; change credentials in Settings");
    let created: string | undefined;
    let result: Credential | undefined;
    try { await this.service.update(undefined, async (state) => {
      if (!state.config.providers[providerId] || state.legacy_providers.includes(providerId)) throw configError("legacy_route", "Provider is not managed by the native backend");
      const current = await this.read(providerId);
      result = await fn(current);
      if (result === undefined) { result = current; return; }
      if (result.type !== "api_key" || !result.key || result.env) throw configError("unsupported_auth", "Only managed API keys are supported; OAuth login is disabled");
      const metadata = await this.service.credentials.put({ kind: "api_key", backend: "managed", secret: result.key, owner_kind: "provider", owner_id: providerId, owner_provider_id: providerId });
      created = metadata.id; state.credential_refs[providerId] = metadata.id;
      state.keyless_providers = state.keyless_providers.filter((id) => id !== providerId);
    }); } catch (error) { if (created) await this.service.credentials.remove(created); throw error; }
    return result;
  }
  async delete(providerId: string) {
    if (this.snapshot) throw configError("snapshot_readonly", "Change credentials in Settings");
    await this.service.update(undefined, (state) => { delete state.credential_refs[providerId]; state.keyless_providers = state.keyless_providers.filter((id) => id !== providerId); });
  }
}
