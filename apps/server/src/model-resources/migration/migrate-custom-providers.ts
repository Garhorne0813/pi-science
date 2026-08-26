import { createHash } from "node:crypto";
import { readJson } from "../../storage/persistence.js";
import { configPath } from "../../storage/persistence.js";
import { SettingsStore, type SettingsData } from "../../storage/settings-store.js";
import {
  type Endpoint,
  type Model,
  type ModelCapabilities,
  type Provider,
  type ProviderEndpointBinding,
} from "@pi-science/contracts";
import { CredentialStore } from "../credential-store.js";
import { ModelResourceRepository } from "../model-resource-repository.js";
import { resolveCapabilities, type CapabilityPatch } from "../capability-resolver.js";

export const MODEL_RESOURCE_MIGRATION_VERSION = 1;
const MIGRATION_VERSION = MODEL_RESOURCE_MIGRATION_VERSION;

type LegacyModelHint = { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string };
type LegacyProvider = Omit<NonNullable<SettingsData["custom_providers"]>[number], "model_hints"> & { model_hints?: Record<string, LegacyModelHint> };
type LegacyEndpoint = {
  endpoint_id?: unknown;
  id?: unknown;
  name?: unknown;
  base_url?: unknown;
  protocol?: unknown;
  api?: unknown;
  enabled?: unknown;
  health?: unknown;
  data_egress?: unknown;
  secret_ref?: unknown;
  credential_ref?: unknown;
  model_schema?: unknown;
  rate_limit?: unknown;
};

export type MigrationResult = {
  migrated: boolean;
  provider_count: number;
  model_count: number;
  endpoint_count: number;
  binding_count: number;
  warnings: string[];
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "provider";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function providerId(legacy: LegacyProvider, state: Awaited<ReturnType<ModelResourceRepository["read"]>>): string {
  const requested = String(legacy.id || legacy.name || "provider");
  const base = requested.startsWith("user-") ? requested : `user-${slug(requested)}`;
  const conflict = state.providers.some((item) => item.id === base && item.source !== "user");
  return conflict ? `${base}-${digest(requested).slice(0, 8)}` : base;
}

function normalizeBaseUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

function protocolFromLegacy(value: unknown): Endpoint["protocol"] {
  const api = String(value ?? "").toLowerCase();
  if (api.includes("anthropic")) return "anthropic";
  if (api.includes("ollama")) return "ollama";
  if (api === "native") return "native";
  return "openai";
}

function adapterFromLegacy(value: unknown): Provider["adapter"] {
  const api = String(value ?? "").toLowerCase();
  if (api.includes("anthropic")) return "anthropic-compatible";
  if (api.includes("ollama")) return "ollama";
  if (api === "native") return "native";
  return "openai-compatible";
}

function capabilitySource(value: unknown): CapabilityPatch["source"] {
  const source = String(value ?? "").toLowerCase();
  if (source.includes("runtime") || source.includes("pi-runtime")) return "runtime";
  if (source.includes("manual")) return "manual";
  if (source.includes("discover") || source === "models" || source.includes("probe") || source.includes("detail")) return "discovery";
  if (source.includes("provider") || source.includes("pi-ai")) return "provider";
  return undefined;
}

function legacyHints(provider: LegacyProvider, modelId: string): CapabilityPatch[] {
  const hints = provider.model_hints?.[modelId];
  const patches: CapabilityPatch[] = [];
  if (typeof provider.reasoning === "boolean" || provider.context_window) {
    patches.push({
      ...(typeof provider.reasoning === "boolean" ? { reasoning: provider.reasoning } : {}),
      ...(provider.context_window ? { context_window: provider.context_window } : {}),
      source: "manual",
    });
  }
  if (hints) {
    patches.push({
      ...hints,
      source: capabilitySource(hints.source) ?? "manual",
    });
  }
  return patches;
}

function modelFromLegacy(provider: LegacyProvider, providerIdValue: string, modelId: string): Model {
  const resolved = resolveCapabilities(modelId, legacyHints(provider, modelId));
  const capabilities: ModelCapabilities = resolved.capabilities;
  const hint = provider.model_hints?.[modelId];
  const verifiedAt = capabilitySource(hint?.source) === "runtime" ? new Date().toISOString() : null;
  return {
    provider_id: providerIdValue,
    model_id: modelId,
    display_name: `${String(provider.name || "Provider")} · ${modelId}`,
    enabled: true,
    capabilities,
    capability_source: resolved.capability_source,
    verified_at: verifiedAt,
    discovered_at: capabilitySource(hint?.source) === "discovery" ? new Date().toISOString() : null,
  };
}

function endpointFromLegacy(row: LegacyEndpoint, index: number): Endpoint | null {
  const baseUrl = normalizeBaseUrl(row.base_url);
  if (!baseUrl) return null;
  const id = String(row.id ?? row.endpoint_id ?? `ep_legacy_${digest(`${baseUrl}:${index}`)}`);
  const health = ["unknown", "ready", "degraded", "error", "blocked"].includes(String(row.health)) ? String(row.health) as Endpoint["health"] : "unknown";
  const protocol = ["openai", "anthropic", "ollama", "native"].includes(String(row.protocol)) ? String(row.protocol) as Endpoint["protocol"] : "openai";
  const api = ["openai-completions", "openai-responses", "anthropic-messages", "ollama", "native"].includes(String(row.api)) ? String(row.api) as Endpoint["api"] : undefined;
  return {
    id,
    name: String(row.name ?? "Imported endpoint"),
    base_url: baseUrl,
    protocol,
    ...(api ? { api } : {}),
    credential_ref: typeof row.credential_ref === "string" ? row.credential_ref : typeof row.secret_ref === "string" ? row.secret_ref : null,
    enabled: row.enabled !== false,
    health,
    data_egress: row.data_egress === "local" ? "local" : "remote",
    ...(row.rate_limit && typeof row.rate_limit === "object" ? { rate_limit: row.rate_limit as Endpoint["rate_limit"] } : {}),
    last_checked_at: null,
    last_error: null,
  };
}

function deterministicCredentialId(namespace: string): string {
  return `cred_legacy_${digest(namespace)}`;
}

function legacyEnvironmentName(provider: LegacyProvider): string {
  return `PI_SCIENCE_CUSTOM_${slug(String(provider.id || provider.name || "API")).toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

async function importSystemCredentials(state: Awaited<ReturnType<ModelResourceRepository["read"]>>, credentials: CredentialStore, settings: SettingsData): Promise<void> {
  for (const [providerId, secret] of Object.entries(settings.api_keys ?? {})) {
    if (typeof secret !== "string" || !secret) continue;
    const id = deterministicCredentialId(`system:${providerId}`);
    await credentials.putRaw(id, { kind: "api_key", backend: "managed", label: `Imported ${providerId}` }, secret);
    state.credential_refs[providerId] = id;
  }
}

async function cleanupLegacySettings(settingsStore: SettingsStore, aliases: Record<string, string>): Promise<void> {
  await settingsStore.update((settings) => {
    if (typeof settings.model === "string" && aliases[settings.model]) settings.model = aliases[settings.model];
    // Keep a secret-free custom-provider projection until the compatibility
    // route removal gate. It is not a source of truth; it keeps older clients
    // able to render a provider while all new writes use model-resources.json.
    if (Array.isArray(settings.custom_providers)) {
      settings.custom_providers = settings.custom_providers.map(({ api_key: _apiKey, ...provider }) => provider);
    }
    delete settings.api_keys;
    delete settings.model_endpoints;
  });
}

/** Idempotently converts the old settings/custom provider shape into the
 * canonical resource files. The migration marker is written only after every
 * resource has been normalized; cleanup is retried on later calls if a second
 * file write is interrupted. */
export async function migrateLegacyModelResources(
  repository: ModelResourceRepository,
  credentials: CredentialStore,
  settingsStore: SettingsStore,
): Promise<MigrationResult> {
  const current = await repository.read();
  const legacy = await settingsStore.read();
  if (current.migration?.version === MIGRATION_VERSION) {
    await cleanupLegacySettings(settingsStore, current.aliases);
    return { migrated: false, provider_count: current.providers.length, model_count: current.models.length, endpoint_count: current.endpoints.length, binding_count: current.bindings.length, warnings: [] };
  }

  const warnings: string[] = [];
  const legacyRows = Array.isArray(legacy.model_endpoints) && legacy.model_endpoints.length > 0 ? legacy.model_endpoints : await readJson<unknown[]>(configPath("model-endpoints.json"), []);
  await repository.update(async (state) => {
    await importSystemCredentials(state, credentials, legacy);
    const importedEndpoints = (legacyRows as unknown[]).flatMap((row, index) => row && typeof row === "object" ? [endpointFromLegacy(row as LegacyEndpoint, index)].filter((endpoint): endpoint is Endpoint => Boolean(endpoint)) : []);
    for (const endpoint of importedEndpoints) if (!state.endpoints.some((item) => item.id === endpoint.id || (item.base_url === endpoint.base_url && item.protocol === endpoint.protocol))) state.endpoints.push(endpoint);

    for (const legacyProvider of legacy.custom_providers ?? []) {
      const canonicalProviderId = providerId(legacyProvider, state);
      let provider = state.providers.find((item) => item.id === canonicalProviderId);
      if (!provider) {
        provider = {
          id: canonicalProviderId,
          name: String(legacyProvider.name || "Imported Provider"),
          kind: "user",
          adapter: adapterFromLegacy(legacyProvider.api),
          enabled: true,
          catalog_mode: "hybrid",
          auth_kind: legacyProvider.api_key || process.env[legacyEnvironmentName(legacyProvider)] ? "api_key" : "api_key_or_oauth",
          source: "user",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.providers.push(provider);
      }
      const baseUrl = normalizeBaseUrl(legacyProvider.base_url);
      if (!baseUrl) { warnings.push(`Skipped provider '${legacyProvider.id}': invalid base_url`); continue; }
      const protocol = protocolFromLegacy(legacyProvider.api);
      let endpoint = state.endpoints.find((item) => item.base_url === baseUrl && item.protocol === protocol);
      if (!endpoint) {
        endpoint = {
          id: `ep_legacy_${digest(`${baseUrl}:${protocol}`)}`,
          name: `${provider.name} endpoint`,
          base_url: baseUrl,
          protocol,
          api: ["openai-responses", "anthropic-messages", "ollama", "native"].includes(String(legacyProvider.api)) ? String(legacyProvider.api) as Endpoint["api"] : "openai-completions",
          credential_ref: null,
          enabled: true,
          health: "unknown",
          data_egress: baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") ? "local" : "remote",
          last_checked_at: null,
          last_error: null,
        };
        state.endpoints.push(endpoint);
      }
      const secret = typeof legacyProvider.api_key === "string" && legacyProvider.api_key
        ? legacyProvider.api_key
        : process.env[legacyEnvironmentName(legacyProvider)];
      if (!endpoint.credential_ref && secret) {
        const credentialId = deterministicCredentialId(`provider:${legacyProvider.id}:${baseUrl}`);
        await credentials.putRaw(credentialId, { kind: "api_key", backend: "managed", label: `${provider.name} key` }, secret);
        endpoint.credential_ref = credentialId;
      }
      let binding = state.bindings.find((item) => item.provider_id === provider.id && item.endpoint_id === endpoint.id);
      if (!binding) {
        binding = {
          id: `bind_legacy_${digest(`${provider.id}:${endpoint.id}`)}`,
          provider_id: provider.id,
          endpoint_id: endpoint.id,
          enabled: true,
          priority: 100,
          ...(String(legacyProvider.api) ? { metadata: { api: String(legacyProvider.api) } } : {}),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.bindings.push(binding);
      }
      for (const rawModel of legacyProvider.models ?? []) {
        const modelId = String(rawModel).trim();
        if (!modelId) continue;
        const next = modelFromLegacy(legacyProvider, provider.id, modelId);
        const existing = state.models.find((item) => item.provider_id === provider.id && item.model_id === modelId);
        if (existing) Object.assign(existing, next);
        else state.models.push(next);
        const canonical = `${provider.id}/${modelId}`;
        const legacyId = slug(String(legacyProvider.id || legacyProvider.name || "provider"));
        state.aliases[`custom-${legacyId}/${modelId}`] = canonical;
        state.aliases[`${legacyId}/${modelId}`] = canonical;
      }
    }
    state.migration = { version: MIGRATION_VERSION, completed_at: new Date().toISOString() };
  });
  const after = await repository.read();
  await cleanupLegacySettings(settingsStore, after.aliases);
  return { migrated: true, provider_count: after.providers.length, model_count: after.models.length, endpoint_count: after.endpoints.length, binding_count: after.bindings.length, warnings };
}
