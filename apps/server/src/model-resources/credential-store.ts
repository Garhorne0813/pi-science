import { chmodSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  credentialMetadataSchema,
  type CredentialMetadata,
  type CreateCredentialRequest,
} from "@pi-science/contracts";
import { configPath, readJson, withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";

const CREDENTIAL_FILE = "credentials.json";
const CREDENTIAL_SCHEMA_VERSION = 1;

export type CredentialRuntimeValue = {
  metadata: CredentialMetadata;
  secret: string | null;
};

type StoredCredential = {
  metadata: CredentialMetadata;
  /** This is the only ordinary JSON file allowed to contain a managed secret. */
  secret?: string;
};

type CredentialState = {
  schema_version: 1;
  credentials: Record<string, StoredCredential>;
};

function credentialPath(): string {
  return configPath(CREDENTIAL_FILE);
}

function emptyState(): CredentialState {
  return { schema_version: CREDENTIAL_SCHEMA_VERSION, credentials: {} };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isEnvironmentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function parseState(value: unknown): CredentialState {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const raw = source.credentials && typeof source.credentials === "object" ? source.credentials as Record<string, unknown> : {};
  const credentials: Record<string, StoredCredential> = {};
  for (const [id, candidate] of Object.entries(raw)) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const metadata = credentialMetadataSchema.safeParse(item.metadata);
    if (!metadata.success) continue;
    const secret = typeof item.secret === "string" ? item.secret : undefined;
    credentials[id] = { metadata: metadata.data, ...(secret !== undefined ? { secret } : {}) };
  }
  return { schema_version: CREDENTIAL_SCHEMA_VERSION, credentials };
}

function statusFor(input: {
  kind: CredentialMetadata["kind"];
  backend: CredentialMetadata["backend"];
  secret?: string;
  environmentVariable?: string;
  externalRef?: string;
}): CredentialMetadata["status"] {
  if (input.kind === "none") return "connected";
  if (input.backend === "managed" || input.backend === "oauth") return input.secret ? "configured" : input.kind === "oauth" ? "needs_login" : "needs_key";
  if (input.backend === "environment") return input.environmentVariable && process.env[input.environmentVariable] ? "configured" : "needs_key";
  if (input.backend === "external") return input.externalRef ? "configured" : "needs_key";
  return "invalid";
}

function metadataFrom(input: {
  id: string;
  kind: CredentialMetadata["kind"];
  backend: CredentialMetadata["backend"];
  label?: string;
  environmentVariable?: string;
  externalProvider?: string;
  externalRef?: string;
  secret?: string;
  createdAt?: string;
  updatedAt?: string;
  lastValidatedAt?: string | null;
}): CredentialMetadata {
  const now = new Date().toISOString();
  const metadata: CredentialMetadata = {
    id: input.id,
    kind: input.kind,
    backend: input.backend,
    status: statusFor(input),
    ...(input.label ? { label: input.label } : {}),
    ...(input.environmentVariable ? { environment_variable: input.environmentVariable } : {}),
    ...(input.externalProvider ? { external_provider: input.externalProvider } : {}),
    ...(input.externalRef ? { external_ref: input.externalRef } : {}),
    created_at: input.createdAt ?? now,
    updated_at: input.updatedAt ?? now,
    last_validated_at: input.lastValidatedAt ?? null,
  };
  return credentialMetadataSchema.parse(metadata);
}

function publicMetadata(record: StoredCredential): CredentialMetadata {
  return clone(record.metadata);
}

/** Central credential backend. Its public methods either return metadata or a
 * runtime-only value. No caller receives the stored secret through a list/get
 * API. */
export class CredentialStore {
  private writes: Promise<void> = Promise.resolve();

  async listMetadata(): Promise<CredentialMetadata[]> {
    const state = parseState(await readJson<unknown>(credentialPath(), emptyState()));
    return Object.values(state.credentials).map((record) => this.refreshEnvironmentStatus(record.metadata, record.secret)).sort((a, b) => a.id.localeCompare(b.id));
  }

  async metadata(id: string): Promise<CredentialMetadata | null> {
    const state = parseState(await readJson<unknown>(credentialPath(), emptyState()));
    const record = state.credentials[id];
    return record ? this.refreshEnvironmentStatus(record.metadata, record.secret) : null;
  }

  /** Resolve a credential only for runtime projection/routing. */
  async getForRuntime(id: string): Promise<CredentialRuntimeValue | null> {
    const state = parseState(await readJson<unknown>(credentialPath(), emptyState()));
    const record = state.credentials[id];
    if (!record) return null;
    const metadata = this.refreshEnvironmentStatus(record.metadata, record.secret);
    let secret: string | null = null;
    if (metadata.kind !== "none") {
      if (metadata.backend === "managed" || metadata.backend === "oauth") secret = record.secret || null;
      else if (metadata.backend === "environment" && metadata.environment_variable) secret = process.env[metadata.environment_variable] || null;
      // external is deliberately unresolved until an external adapter is supplied.
    }
    return { metadata, secret };
  }

  async put(input: Partial<CreateCredentialRequest> & { id?: string }): Promise<CredentialMetadata> {
    return this.update((state) => {
      const id = input.id || `cred_${randomUUID().replaceAll("-", "")}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("Credential ID must be URL-safe");
      const existing = state.credentials[id];
      const kind = input.kind ?? existing?.metadata.kind ?? "api_key";
      const backend = input.backend ?? existing?.metadata.backend ?? "managed";
      const requestedSecret = typeof input.secret === "string" ? input.secret : typeof input.api_key === "string" ? input.api_key : undefined;
      const environmentVariable = input.environment_variable ?? existing?.metadata.environment_variable;
      if (backend === "environment" && !isEnvironmentName(environmentVariable)) throw new Error("environment_variable must be a valid environment variable name");
      if (backend === "environment" && requestedSecret) throw new Error("environment credentials store only the declared variable name");
      const storesSecret = kind !== "none" && (backend === "managed" || backend === "oauth");
      const secret = storesSecret ? requestedSecret !== undefined ? requestedSecret : existing?.secret : undefined;
      if (backend === "managed" && kind !== "none" && !secret) throw new Error("secret is required for a managed credential");
      const metadata = metadataFrom({
        id,
        kind,
        backend,
        label: input.label ?? existing?.metadata.label,
        environmentVariable,
        externalProvider: input.external_provider ?? existing?.metadata.external_provider,
        externalRef: input.external_ref ?? existing?.metadata.external_ref,
        secret,
        createdAt: existing?.metadata.created_at,
        lastValidatedAt: existing?.metadata.last_validated_at,
      });
      state.credentials[id] = { metadata, ...(secret !== undefined ? { secret } : {}) };
      return publicMetadata(state.credentials[id]!);
    });
  }

  async remove(id: string): Promise<CredentialMetadata | null> {
    return this.update((state) => {
      const existing = state.credentials[id];
      if (!existing) return null;
      delete state.credentials[id];
      return publicMetadata(existing);
    });
  }

  async validate(id: string): Promise<CredentialMetadata> {
    return this.update((state) => {
      const existing = state.credentials[id];
      if (!existing) throw Object.assign(new Error(`Credential '${id}' was not found`), { code: "resource_not_found" });
      const metadata = this.refreshEnvironmentStatus(existing.metadata, existing.secret, new Date().toISOString());
      existing.metadata = metadata;
      return publicMetadata(existing);
    });
  }

  /** Test and migration hook. Writes are still atomic and the raw value is not
   * part of the returned object. */
  async putRaw(id: string, metadata: Omit<CredentialMetadata, "id" | "status" | "created_at" | "updated_at">, secret?: string): Promise<CredentialMetadata> {
    return this.update((state) => {
      const existing = state.credentials[id];
      const nextMetadata = metadataFrom({
        id,
        kind: metadata.kind,
        backend: metadata.backend,
        label: metadata.label,
        environmentVariable: metadata.environment_variable,
        externalProvider: metadata.external_provider,
        externalRef: metadata.external_ref,
        secret,
        createdAt: existing?.metadata.created_at,
      });
      state.credentials[id] = { metadata: nextMetadata, ...(secret !== undefined ? { secret } : {}) };
      return publicMetadata(state.credentials[id]!);
    });
  }

  readSync(id: string): CredentialRuntimeValue | null {
    try {
      const state = parseState(JSON.parse(readFileSync(credentialPath(), "utf8")));
      const record = state.credentials[id];
      if (!record) return null;
      const metadata = this.refreshEnvironmentStatus(record.metadata, record.secret);
      const secret = metadata.backend === "environment" && metadata.environment_variable
        ? process.env[metadata.environment_variable] || null
        : record.secret || null;
      return { metadata, secret };
    } catch { return null; }
  }

  private refreshEnvironmentStatus(metadata: CredentialMetadata, secret?: string, validatedAt?: string): CredentialMetadata {
    return credentialMetadataSchema.parse({
      ...metadata,
      status: statusFor({ kind: metadata.kind, backend: metadata.backend, secret, environmentVariable: metadata.environment_variable, externalRef: metadata.external_ref }),
      updated_at: metadata.updated_at,
      ...(validatedAt ? { last_validated_at: validatedAt } : {}),
    });
  }

  private async update<T>(operation: (state: CredentialState) => T | Promise<T>): Promise<T> {
    const path = credentialPath();
    const pending = this.writes.catch(() => undefined).then(() => withFileWriteLock(path, async () => {
      const state = parseState(await readJson<unknown>(path, emptyState()));
      const result = await operation(state);
      await writeJsonAtomic(path, state, { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch { /* Windows and read-only volumes */ }
      return result;
    }));
    this.writes = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

export function credentialStorePath(): string {
  return credentialPath();
}
