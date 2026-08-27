import { readFileSync, chmodSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  bindingSchema,
  endpointSchema,
  modelResourceStateSchema,
  modelSchema,
  providerSchema,
  type Model,
  type ModelResourceState,
  type Provider,
  type Endpoint,
  type ProviderEndpointBinding,
} from "@pi-science/contracts";
import { configPath, readJson, withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";

export const MODEL_RESOURCE_SCHEMA_VERSION = 1;
export const MODEL_RESOURCE_FILE = "model-resources.json";

export function modelResourcePath(): string {
  return configPath(MODEL_RESOURCE_FILE);
}

export function emptyModelResourceState(): ModelResourceState {
  return {
    schema_version: MODEL_RESOURCE_SCHEMA_VERSION,
    providers: [],
    models: [],
    endpoints: [],
    bindings: [],
    aliases: {},
    credential_refs: {},
  };
}

function parseState(value: unknown): ModelResourceState {
  const parsed = modelResourceStateSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const state = emptyModelResourceState();
  if (Array.isArray(source.providers)) state.providers = source.providers.flatMap((item) => { const result = providerSchema.safeParse(item); return result.success ? [result.data] : []; });
  if (Array.isArray(source.models)) state.models = source.models.flatMap((item) => { const result = modelSchema.safeParse(item); return result.success ? [result.data] : []; });
  if (Array.isArray(source.endpoints)) state.endpoints = source.endpoints.flatMap((item) => { const result = endpointSchema.safeParse(item); return result.success ? [result.data] : []; });
  if (Array.isArray(source.bindings)) state.bindings = source.bindings.flatMap((item) => { const result = bindingSchema.safeParse(item); return result.success ? [result.data] : []; });
  if (source.aliases && typeof source.aliases === "object") state.aliases = Object.fromEntries(Object.entries(source.aliases as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (source.credential_refs && typeof source.credential_refs === "object") state.credential_refs = Object.fromEntries(Object.entries(source.credential_refs as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const migration = source.migration;
  if (migration && typeof migration === "object") {
    const version = Number((migration as Record<string, unknown>).version);
    const completedAt = (migration as Record<string, unknown>).completed_at;
    if (Number.isInteger(version) && version >= 0 && typeof completedAt === "string") state.migration = { version, completed_at: completedAt };
  }
  return state;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Canonical JSON repository for provider/model/endpoint/binding resources.
 *  Secrets never enter this file; CredentialStore owns those values. */
export class ModelResourceRepository {
  private writes: Promise<void> = Promise.resolve();

  async read(): Promise<ModelResourceState> {
    return clone(parseState(await readJson<unknown>(modelResourcePath(), emptyModelResourceState())));
  }

  readSync(): ModelResourceState {
    try { return clone(parseState(JSON.parse(readFileSync(modelResourcePath(), "utf8")))); }
    catch { return emptyModelResourceState(); }
  }

  async update<T>(operation: (state: ModelResourceState) => T | Promise<T>): Promise<T> {
    const path = modelResourcePath();
    const pending = this.writes.catch(() => undefined).then(() => withFileWriteLock(path, async () => {
      const state = parseState(await readJson<unknown>(path, emptyModelResourceState()));
      const result = await operation(state);
      await writeJsonAtomic(path, state);
      return result;
    }));
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async replace(state: ModelResourceState): Promise<void> {
    await this.update((current) => {
      current.schema_version = MODEL_RESOURCE_SCHEMA_VERSION;
      current.providers = clone(state.providers);
      current.models = clone(state.models);
      current.endpoints = clone(state.endpoints);
      current.bindings = clone(state.bindings);
      current.aliases = clone(state.aliases);
      current.credential_refs = clone(state.credential_refs);
      current.migration = state.migration ? clone(state.migration) : undefined;
    });
  }

  static providerId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "provider";
    return `user-${slug}`;
  }

  static endpointId(): string {
    return `ep_${randomUUID().replaceAll("-", "")}`;
  }

  static bindingId(): string {
    return `bind_${randomUUID().replaceAll("-", "")}`;
  }

  static modelKey(providerId: string, modelId: string): string {
    return `${providerId}/${modelId}`;
  }

  /** Keep the resource file private when a caller has created it manually. */
  static secureFileMode(): void {
    try { chmodSync(modelResourcePath(), 0o600); } catch { /* Windows and read-only volumes */ }
  }
}

export type ResourceCollections = Pick<ModelResourceState, "providers" | "models" | "endpoints" | "bindings">;
export type ResourceEntity = Provider | Model | Endpoint | ProviderEndpointBinding;

export function writeResourceStateSync(state: ModelResourceState): void {
  const path = modelResourcePath();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  ModelResourceRepository.secureFileMode();
}
