import type { CredentialStore as PiCredentialStore, Credential } from "@earendil-works/pi-ai";
import type { ModelConfigSnapshot } from "@pi-science/contracts";
import { configPath, withFileWriteLock } from "../storage/persistence.js";
import { readOAuthCredential, oauthCredential } from "./oauth-credential.js";
import { ModelConfigService, modelConfigPath, configError, isAllowedModelEnvRef } from "./model-config-service.js";

/** Only explicitly mapped credentials. OAuth refresh can rotate an existing grant, never change a snapshot's provider binding. */
export class ModelCredentialAdapter implements PiCredentialStore {
  constructor(private readonly service = new ModelConfigService(), private readonly snapshot?: ModelConfigSnapshot) {}
  private state() { return this.snapshot ?? this.service.readSync(); }
  async read(providerId: string): Promise<Credential | undefined> {
    const ref = this.state().credential_refs[providerId];
    const item = ref ? await this.service.credentials.getForRuntime(ref) : null;
    if (item?.metadata.backend === "oauth" && item.metadata.kind === "oauth") {
      // A retired Worker cannot consume a newly authorized account or resurrect logout.
      if (this.service.readSync().credential_refs[providerId] !== ref || item.metadata.owner_kind !== "provider" || item.metadata.owner_id !== providerId || item.metadata.owner_provider_id !== providerId) return undefined;
      return readOAuthCredential(item.secret);
    }
    if (item?.metadata.backend === "environment" && !isAllowedModelEnvRef(item.metadata.environment_variable)) return undefined;
    return item?.secret && item.metadata.kind === "api_key" && ["managed", "environment"].includes(item.metadata.backend)
      ? { type: "api_key", key: item.secret } : undefined;
  }
  async list() {
    const state = this.state();
    const metadata = await this.service.credentials.listMetadata();
    const entries = new Map(metadata.map((item) => [item.id, item]));
    return Object.entries(state.credential_refs).flatMap(([providerId, ref]) => { const entry = entries.get(ref); return entry && (entry.kind === "api_key" || entry.kind === "oauth") ? [{ providerId, type: entry.kind }] : []; });
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    const ref = this.state().credential_refs[providerId];
    const stored = await this.read(providerId);
    if (stored?.type === "oauth" && ref) {
      // Per-grant cross-process lock: network refresh never holds the config lock.
      return withFileWriteLock(configPath(`model-oauth-locks/${ref}`), async () => {
        options?.signal?.throwIfAborted();
        if (this.service.readSync().credential_refs[providerId] !== ref) return undefined;
        const item = await this.service.credentials.getForRuntime(ref);
        if (item?.metadata.kind !== "oauth" || item.metadata.backend !== "oauth" || item.metadata.owner_kind !== "provider" || item.metadata.owner_id !== providerId) throw configError("unsupported_auth", "OAuth refresh requires a dedicated native grant");
        const current = readOAuthCredential(item.secret);
        if (!current) return undefined;
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next === undefined) return current;
        const updated = oauthCredential(next);
        if (updated.expires <= Date.now()) throw configError("invalid_oauth_grant", "Refreshed authorization is expired");
        return withFileWriteLock(modelConfigPath(), async () => {
          options?.signal?.throwIfAborted();
          if (this.service.readSync().credential_refs[providerId] !== ref) return undefined;
          await this.service.credentials.rotateOwnedOAuth(ref, providerId, JSON.stringify(updated));
          return updated;
        });
      });
    }
    if (this.snapshot) throw configError("snapshot_readonly", "Worker credential snapshots are read-only; change credentials in Settings");
    let created: string | undefined;
    let result: Credential | undefined;
    try { await this.service.update(undefined, async (state) => {
      if (!state.config.providers[providerId] || state.legacy_providers.includes(providerId)) throw configError("legacy_route", "Provider is not managed by the native backend");
      const current = await this.read(providerId);
      result = await fn(current);
      if (result === undefined) { result = current; return; }
      if (result.type !== "api_key" || !result.key || result.env) throw configError("unsupported_auth", "API-key mutations must contain a managed key");
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
