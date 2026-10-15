import { lstatSync, readFileSync } from "node:fs";
import { copyFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { modelConfigBackendSchema, modelConfigSnapshotSchema, modelConfigSchema, type ModelConfig, type ModelConfigSnapshot, type ProviderConfig, type ProviderConfigView } from "@pi-science/contracts";
import { configPath, withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";
import { CredentialStore } from "../model-resources/credential-store.js";
import { SettingsStore } from "../storage/settings-store.js";
import { validateOutboundHttpUrl } from "../security/outbound-security.js";

export function modelConfigBackend() { return modelConfigBackendSchema.parse(process.env.PI_SCIENCE_MODEL_CONFIG_BACKEND ?? "legacy"); }
export function isAllowedModelEnvRef(name: string | undefined): name is string {
  return Boolean(name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^(PI_SCIENCE_|NCBI_|OPENALEX_|OPENFDA_|HTTP_|HTTPS_|ALL_PROXY$|NO_PROXY$|SSL_CERT_|NODE_|PATH$|HOME$)/i.test(name));
}
export function configError(code: string, message: string) { return Object.assign(new Error(message), { code }); }
export const modelConfigPath = () => configPath("models.json");

export class ModelConfigService {
  constructor(readonly credentials = new CredentialStore()) {}
  readSync(): ModelConfigSnapshot {
    const path = modelConfigPath();
    try {
      if (!lstatSync(path).isFile()) throw configError("invalid_config", "models.json must be a regular file");
      const { providers, ...metadata } = JSON.parse(readFileSync(path, "utf8"));
      return modelConfigSnapshotSchema.parse({ ...metadata, config: { providers: providers ?? {} } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return modelConfigSnapshotSchema.parse({});
      throw configError("invalid_config", "models.json is invalid; repair it before using the native backend");
    }
  }
  async preflight(config: ModelConfig) {
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    const builtin = builtinModels();
    const settings = await new SettingsStore().read();
    for (const [id, provider] of Object.entries(config.providers)) {
      const native = builtin.getProvider(id);
      if (native && provider.api && !native.getModels().some((model) => model.api === provider.api)) throw configError("invalid_config", "API override is not supported by this native provider");
      if (!builtin.getProvider(id) && (!provider.api || !provider.baseUrl || !provider.models?.length)) throw configError("invalid_config", "Custom providers require api, baseUrl and models");
      if (provider.baseUrl) await validateOutboundHttpUrl(provider.baseUrl, { allowPrivate: settings.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0" });
      const known = new Set([...(builtin.getProvider(id)?.getModels().map((model) => model.id) ?? []), ...(provider.models?.map((model) => model.id) ?? [])]);
      if (Object.keys(provider.modelOverrides ?? {}).some((model) => !known.has(model))) throw configError("invalid_config", "Override refers to an unknown model");
    }
  }
  async update(revision: number | undefined, operation: (snapshot: ModelConfigSnapshot) => void | Promise<void>) {
    return withFileWriteLock(modelConfigPath(), async () => {
      const snapshot = this.readSync();
      if (revision !== undefined && snapshot.revision !== revision) throw configError("revision_conflict", "Configuration changed; reload before saving");
      await operation(snapshot);
      const parsed = modelConfigSnapshotSchema.parse(snapshot);
      await this.preflight(parsed.config);
      parsed.revision += 1;
      const { config, ...manifest } = parsed;
      await writeJsonAtomic(modelConfigPath(), { ...manifest, providers: config.providers }, { mode: 0o600 });
      return parsed;
    });
  }
  async createProvider(revision: number, id: string, config: ProviderConfig, credential?: { source: "managed" | "keyless"; secret?: string }) {
    const validated = modelConfigSchema.parse({ providers: { [id]: config } });
    let created: string | undefined;
    try {
      return await this.update(revision, async (snapshot) => {
        if (snapshot.config.providers[id] || snapshot.legacy_providers.includes(id)) throw configError("legacy_route", "Provider already exists");
        Object.assign(snapshot.config.providers, validated.providers);
        if (credential?.source === "managed") {
          const metadata = await this.credentials.put({ kind: "api_key", backend: "managed", secret: credential.secret, owner_kind: "provider", owner_id: id, owner_provider_id: id });
          created = metadata.id; snapshot.credential_refs[id] = created;
        } else if (credential?.source === "keyless") snapshot.keyless_providers.push(id);
      });
    } catch (error) { if (created) await this.credentials.remove(created); throw error; }
  }
  async replace(revision: number, config: unknown) {
    const parsed = modelConfigSchema.parse(config);
    return this.update(revision, (snapshot) => {
      if (Object.keys(parsed.providers).some((id) => snapshot.legacy_providers.includes(id))) throw configError("legacy_route", "Legacy providers require an explicit migration");
      snapshot.config = parsed;
      for (const id of Object.keys(snapshot.credential_refs)) if (!parsed.providers[id]) delete snapshot.credential_refs[id];
      snapshot.keyless_providers = snapshot.keyless_providers.filter((id) => Boolean(parsed.providers[id]));
    });
  }
  async view(id: string, snapshot = this.readSync()): Promise<ProviderConfigView> {
    const ref = snapshot.credential_refs[id];
    const credential = ref ? await this.credentials.getForRuntime(ref) : null;
    const source = snapshot.keyless_providers.includes(id) ? "keyless" : !credential ? "unconfigured"
      : credential.metadata.backend === "environment" ? "environment" : credential.metadata.backend === "managed" ? "managed" : "unsupported";
    return { id, revision: snapshot.revision, config: snapshot.config.providers[id] ?? null,
      legacy: snapshot.legacy_providers.includes(id), editable: !snapshot.legacy_providers.includes(id),
      authentication: { source, resolved: source === "keyless" || (source !== "unsupported" && Boolean(credential?.secret)),
        ...(source === "environment" ? { environment_variable: credential!.metadata.environment_variable, restart_required: true } : {}) } };
  }
  // Copy-on-write credential replacement never mutates/deletes a credential shared with MCP.
  async setCredential(id: string, revision: number, input: { source: "managed" | "environment" | "keyless" | "remove"; secret?: string; environment_variable?: string }) {
    let created: string | undefined;
    try {
      return await this.update(revision, async (snapshot) => {
        if (snapshot.legacy_providers.includes(id)) throw configError("legacy_route", "Provider uses legacy routes");
        if (!Object.hasOwn(snapshot.config.providers, id)) {
          const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
          if (!builtinModels().getProvider(id)) throw configError("legacy_route", "Provider is missing");
          snapshot.config.providers[id] = {};
        }
        if (input.source === "environment" && !isAllowedModelEnvRef(input.environment_variable)) throw configError("invalid_config", "Environment reference is reserved or missing");
        if (input.source === "managed" || input.source === "environment") {
          const metadata = await this.credentials.put({ kind: "api_key", backend: input.source, secret: input.secret,
            environment_variable: input.environment_variable, owner_kind: "provider", owner_id: id, owner_provider_id: id });
          created = metadata.id;
          snapshot.credential_refs[id] = created;
        } else delete snapshot.credential_refs[id];
        snapshot.keyless_providers = snapshot.keyless_providers.filter((provider) => provider !== id);
        if (input.source === "keyless") snapshot.keyless_providers.push(id);
      });
    } catch (error) { if (created) await this.credentials.remove(created); throw error; }
  }
  async backup() {
    const directory = configPath(join("model-config-backups", randomUUID()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of ["models.json", "model-resources.json", "credentials.json", "config.json"]) {
      const source = configPath(name);
      try { if (!lstatSync(source).isFile()) throw configError("invalid_config", "Backup source must be a regular file"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const destination = join(directory, name);
      await copyFile(source, destination); await chmod(destination, 0o600);
    }
    return directory;
  }
}
