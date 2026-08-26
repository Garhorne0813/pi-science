import { createHash } from "node:crypto";
import {
  type CreateBindingRequest,
  type CreateCredentialRequest,
  type CreateEndpointRequest,
  type CreateProviderRequest,
  type Endpoint,
  type Model,
  type ModelCapabilities,
  type ModelRead,
  type Provider,
  type ProviderEndpointBinding,
  type UpdateBindingRequest,
  type UpdateEndpointRequest,
  type UpdateProviderRequest,
} from "@pi-science/contracts";
import { loadPiAiCatalog } from "../config/model-catalog-fallback.js";
import { hasEnvApiKey, loadPiAiProviderCatalog } from "../config/pi-ai-provider-catalog.js";
import { egressAuditEnabled, recordEgress } from "../security/egress-audit.js";
import { safeConnectorFetch, validateOutboundHttpUrl } from "../security/outbound-security.js";
import { SettingsStore } from "../storage/settings-store.js";
import { CredentialStore } from "./credential-store.js";
import { resolveCapabilities, normalizeContextWindow, normalizeThinkingLevels, type CapabilityPatch } from "./capability-resolver.js";
import { migrateLegacyModelResources, type MigrationResult } from "./migration/migrate-custom-providers.js";
import { ModelResourceRepository } from "./model-resource-repository.js";
import { canonicalModelRef, resolvedModelToRead, RuntimeModelResolver } from "./runtime-model-resolver.js";

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

function resourceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "provider";
}

function now(): string {
  return new Date().toISOString();
}

function normalizeProtocol(value: unknown): Endpoint["protocol"] {
  const raw = String(value ?? "openai").toLowerCase();
  if (raw === "anthropic" || raw === "anthropic-messages" || raw === "anthropic-compatible") return "anthropic";
  if (raw === "ollama") return "ollama";
  if (raw === "native") return "native";
  return "openai";
}

function adapterForEndpoint(protocol: Endpoint["protocol"]): Provider["adapter"] {
  if (protocol === "anthropic") return "anthropic-compatible";
  if (protocol === "ollama") return "ollama";
  if (protocol === "native") return "native";
  return "openai-compatible";
}

function normalizeBaseUrl(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  if (!raw) throw resourceError("invalid_resource", "base_url is required");
  let url: URL;
  try { url = new URL(raw); } catch { throw resourceError("invalid_resource", "base_url must be a valid absolute URL"); }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw resourceError("invalid_resource", "only http(s) endpoint URLs are allowed");
  if (url.username || url.password) throw resourceError("invalid_resource", "URL credentials are not allowed");
  return url.toString().replace(/\/$/, "");
}

function secureHeaderPolicy(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw resourceError("invalid_resource", "headers_policy must be an object");
  const forbidden = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key", "set-cookie"]);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) throw resourceError("invalid_resource", `sensitive header is not allowed: ${key}`);
    result[key] = String(raw);
  }
  return result;
}

function modelRows(payload: Record<string, unknown>): Array<{ id: string; raw: unknown }> {
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const seen = new Set<string>();
  const result: Array<{ id: string; raw: unknown }> = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row.trim() : row && typeof row === "object" ? String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).name ?? "").trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, raw: row });
  }
  return result;
}

const CONTEXT_KEYS = new Set(["context_window", "context_length", "max_model_len", "max_context_length", "max_position_embeddings", "contextwindow"]);
const THINKING_LEVEL_SET = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function capabilityPatchFromPayload(value: unknown): CapabilityPatch {
  const patch: CapabilityPatch = {};
  const visit = (current: unknown, depth: number): void => {
    if (depth > 5 || current === null || current === undefined) return;
    if (Array.isArray(current)) { for (const item of current.slice(0, 100)) visit(item, depth + 1); return; }
    if (typeof current !== "object") return;
    for (const [rawKey, child] of Object.entries(current as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (CONTEXT_KEYS.has(key) && patch.context_window === undefined) {
        const context = normalizeContextWindow(child);
        if (context) patch.context_window = context;
      }
      if ((key === "reasoning" || key === "supports_reasoning") && typeof child === "boolean" && patch.reasoning === undefined) patch.reasoning = child;
      if ((key === "thinking_levels" || key === "supported_thinking_levels") && Array.isArray(child) && patch.thinking_levels === undefined) {
        const levels = normalizeThinkingLevels(child.filter((level) => THINKING_LEVEL_SET.has(String(level))));
        if (levels) patch.thinking_levels = levels;
      }
      if (key === "thinkinglevelmap" && child && typeof child === "object" && patch.thinking_levels === undefined) {
        const levels = normalizeThinkingLevels(Object.entries(child as Record<string, unknown>).filter(([, mapped]) => mapped !== null).map(([level]) => level));
        if (levels) patch.thinking_levels = levels;
      }
      if ((key === "vision" || key === "supports_vision") && typeof child === "boolean" && patch.vision === undefined) patch.vision = child;
      if ((key === "tools" || key === "supports_tools") && typeof child === "boolean" && patch.tools === undefined) patch.tools = child;
      if ((key === "structured_output" || key === "supports_structured_output") && typeof child === "boolean" && patch.structured_output === undefined) patch.structured_output = child;
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return patch;
}

function manualCapabilityPatch(body: Record<string, unknown>): CapabilityPatch {
  const source = body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities)
    ? body.capabilities as Record<string, unknown>
    : body;
  const patch: CapabilityPatch = { source: "manual" };
  if (typeof source.reasoning === "boolean") patch.reasoning = source.reasoning;
  const levels = normalizeThinkingLevels(source.thinking_levels);
  if (levels) patch.thinking_levels = levels;
  if (source.context_window !== undefined) patch.context_window = normalizeContextWindow(source.context_window);
  const maxOutput = Number(source.max_output_tokens);
  if (source.max_output_tokens !== undefined && Number.isInteger(maxOutput) && maxOutput > 0) patch.max_output_tokens = maxOutput;
  for (const key of ["vision", "tools", "structured_output"] as const) if (typeof source[key] === "boolean") patch[key] = source[key] as boolean;
  return patch;
}

function redactSecret(message: string, secret: string | null | undefined): string {
  return secret ? message.replaceAll(secret, "[redacted]") : message;
}

function authHeaders(protocol: Endpoint["protocol"], secret: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (!secret) return headers;
  if (protocol === "anthropic") {
    headers["x-api-key"] = secret;
    headers["anthropic-version"] = "2023-06-01";
  } else headers.authorization = `Bearer ${secret}`;
  return headers;
}

const MAX_MODEL_DISCOVERY_BYTES = 8 * 1024 * 1024;

async function readBoundedJson(response: Response, maxBytes = MAX_MODEL_DISCOVERY_BYTES): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw resourceError("endpoint_probe_failed", "endpoint response is too large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw resourceError("endpoint_probe_failed", "endpoint response is too large");
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return text ? { message: text } : {}; }
}

function discoveryPath(endpoint: Endpoint): string {
  if (endpoint.protocol === "ollama") return `${endpoint.base_url}/api/tags`;
  return `${endpoint.base_url}/models`;
}

export class ModelResourceService {
  readonly repository: ModelResourceRepository;
  readonly credentials: CredentialStore;
  private readonly settings: SettingsStore;
  private migrationPromise: Promise<MigrationResult> | undefined;

  constructor(options: { repository?: ModelResourceRepository; credentials?: CredentialStore; settings?: SettingsStore } = {}) {
    this.repository = options.repository ?? new ModelResourceRepository();
    this.credentials = options.credentials ?? new CredentialStore();
    this.settings = options.settings ?? new SettingsStore();
  }

  async ensureMigrated(): Promise<MigrationResult> {
    if (!this.migrationPromise) this.migrationPromise = migrateLegacyModelResources(this.repository, this.credentials, this.settings).catch((error) => {
      this.migrationPromise = undefined;
      throw error;
    });
    return this.migrationPromise;
  }

  async resolveAvailableModels() {
    await this.ensureMigrated();
    return new RuntimeModelResolver(this.repository, this.credentials).resolveAvailableModels();
  }

  async resolveModelRoute(ref: string) {
    await this.ensureMigrated();
    return new RuntimeModelResolver(this.repository, this.credentials).resolveModelRoute(ref);
  }

  async isModelAvailable(ref: string): Promise<boolean> {
    await this.ensureMigrated();
    const state = await this.repository.read();
    const canonical = state.aliases[ref] ?? ref;
    if (canonical.startsWith("user-")) return (await this.listModels({ available: true })).some((model) => model.id === canonical);
    return true;
  }

  async listProviders(): Promise<ProviderRead[]> {
    await this.ensureMigrated();
    const state = await this.repository.read();
    const result: ProviderRead[] = [];
    const systemCatalog = await loadPiAiProviderCatalog();
    for (const entry of systemCatalog) {
      const ref = state.credential_refs[entry.id];
      const credential = ref ? await this.credentials.getForRuntime(ref) : null;
      const hasKey = Boolean(credential?.secret) || (entry.apiKeySupported && await hasEnvApiKey(entry.id));
      const connected = Boolean(credential?.metadata.status === "connected");
      const status = hasKey ? "configured" : connected ? "connected" : !entry.apiKeySupported && entry.oauthSupported ? "needs_login" : entry.apiKeySupported ? "needs_key" : "connected";
      result.push({
        id: entry.id,
        name: entry.name,
        kind: "system",
        adapter: "pi-ai",
        enabled: hasKey || connected,
        catalog_mode: "runtime",
        auth_kind: entry.apiKeySupported && entry.oauthSupported ? "api_key_or_oauth" : entry.oauthSupported ? "oauth" : entry.apiKeySupported ? "api_key" : "none",
        source: "pi-ai",
        models: entry.modelIds,
        has_key: hasKey,
        credential_status: status,
        routes: 0,
      });
    }
    const resolver = new RuntimeModelResolver(this.repository, this.credentials);
    const resolved = await resolver.resolveAvailableModels();
    for (const provider of state.providers) {
      const models = state.models.filter((model) => model.provider_id === provider.id).map((model) => model.model_id);
      const providerModels = resolved.filter((model) => model.provider_id === provider.id);
      const providerEndpointIds = new Set(state.bindings.filter((binding) => binding.provider_id === provider.id).map((binding) => binding.endpoint_id));
      const hasConfiguredCredential = provider.auth_kind === "none" || state.endpoints
        .filter((endpoint) => providerEndpointIds.has(endpoint.id) && endpoint.credential_ref)
        .some((endpoint) => Boolean(endpoint.credential_ref && state.credential_refs[endpoint.credential_ref]) || Boolean(endpoint.credential_ref && this.credentials.readSync(endpoint.credential_ref)?.secret));
      const needsLogin = provider.auth_kind === "oauth" && !hasConfiguredCredential;
      result.push({
        ...provider,
        models,
        has_key: provider.auth_kind !== "none" && hasConfiguredCredential,
        credential_status: provider.auth_kind === "none" ? "connected" : hasConfiguredCredential ? "configured" : needsLogin ? "needs_login" : "needs_key",
        routes: providerModels.reduce((count, model) => count + model.routes.length, 0),
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getProvider(id: string): Promise<ProviderRead> {
    const provider = (await this.listProviders()).find((item) => item.id === id);
    if (!provider) throw resourceError("resource_not_found", `Provider '${id}' was not found`);
    return provider;
  }

  async createProvider(input: CreateProviderRequest): Promise<Provider> {
    await this.ensureMigrated();
    const requested = input.id?.trim();
    const id = requested ? (requested.startsWith("user-") ? requested : `user-${slug(requested)}`) : ModelResourceRepository.providerId(input.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw resourceError("invalid_resource", "Provider ID must be URL-safe");
    const item: Provider = {
      id,
      name: input.name.trim(),
      kind: "user",
      adapter: input.adapter,
      enabled: input.enabled,
      catalog_mode: input.catalog_mode,
      auth_kind: input.auth_kind,
      source: "user",
      created_at: now(),
      updated_at: now(),
    };
    return this.repository.update((state) => {
      if (state.providers.some((provider) => provider.id === id)) throw resourceError("provider_id_conflict", `Provider ID '${id}' already exists`);
      state.providers.push(item);
      return structuredClone(item);
    });
  }

  async upsertLegacyProvider(input: {
    id: string;
    name: string;
    base_url: string;
    api: string;
    models: string[];
    api_key?: string;
    reasoning?: boolean;
    context_window?: number;
    model_hints?: Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string }>;
  }): Promise<{ provider: Provider; endpoint: Endpoint; binding: ProviderEndpointBinding; models: Model[] }> {
    await this.ensureMigrated();
    const id = input.id.startsWith("user-") ? input.id : `user-${slug(input.id)}`;
    const protocol = normalizeProtocol(input.api);
    const baseUrl = normalizeBaseUrl(input.base_url);
    const result = await this.repository.update(async (state) => {
      let provider = state.providers.find((item) => item.id === id);
      if (provider && provider.kind === "system") throw resourceError("provider_id_conflict", `Provider ID '${id}' conflicts with a system provider`);
      if (!provider) {
        provider = {
          id,
          name: input.name.trim() || "Provider",
          kind: "user",
          adapter: adapterForEndpoint(protocol),
          enabled: true,
          catalog_mode: "hybrid",
          auth_kind: input.api_key ? "api_key" : "none",
          source: "user",
          created_at: now(),
          updated_at: now(),
        };
        state.providers.push(provider);
      } else {
        provider.name = input.name.trim() || provider.name;
        provider.adapter = adapterForEndpoint(protocol);
        provider.auth_kind = input.api_key ? "api_key" : provider.auth_kind;
        provider.updated_at = now();
      }
      let endpoint = state.endpoints.find((item) => item.base_url === baseUrl && item.protocol === protocol);
      if (!endpoint) {
        endpoint = {
          id: `ep_legacy_${modelResourceHash(`${baseUrl}:${protocol}`)}`,
          name: `${provider.name} connection`,
          base_url: baseUrl,
          protocol,
          api: ["openai-responses", "anthropic-messages", "ollama", "native"].includes(input.api) ? input.api as Endpoint["api"] : "openai-completions",
          credential_ref: null,
          enabled: true,
          health: "unknown",
          data_egress: baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") ? "local" : "remote",
          last_checked_at: null,
          last_error: null,
        };
        state.endpoints.push(endpoint);
      } else if (input.api) endpoint.api = input.api as Endpoint["api"];
      if (input.api_key) {
        const credentialId = `cred_${modelResourceHash(`legacy-api:${id}:${baseUrl}`)}`;
        await this.credentials.putRaw(credentialId, { kind: "api_key", backend: "managed", label: `${provider.name} key` }, input.api_key);
        endpoint.credential_ref = credentialId;
        provider.auth_kind = "api_key";
      }
      let binding = state.bindings.find((item) => item.provider_id === provider.id && item.endpoint_id === endpoint.id);
      if (!binding) {
        binding = { id: `bind_legacy_${modelResourceHash(`${provider.id}:${endpoint.id}`)}`, provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 100, metadata: { api: input.api || "openai-completions" }, created_at: now(), updated_at: now() };
        state.bindings.push(binding);
      } else {
        binding.enabled = true;
        binding.metadata = { ...(binding.metadata ?? {}), api: input.api || binding.metadata?.api || "openai-completions" };
        binding.updated_at = now();
      }
      const requestedModels = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
      state.models = state.models.filter((model) => model.provider_id !== provider.id || requestedModels.includes(model.model_id));
      const models: Model[] = [];
      for (const modelId of requestedModels) {
        const existing = state.models.find((model) => model.provider_id === provider.id && model.model_id === modelId);
        const hint = input.model_hints?.[modelId];
        const patches: CapabilityPatch[] = [
          ...(input.reasoning !== undefined || input.context_window !== undefined ? [{ reasoning: input.reasoning, context_window: input.context_window, source: "manual" as const }] : []),
          ...(hint ? [{ ...hint, source: hint.source === "runtime" ? "runtime" as const : hint.source === "discovery" ? "discovery" as const : "manual" as const }] : []),
          ...(existing ? [{ ...existing.capabilities, source: existing.capability_source, verified_at: existing.verified_at }] : []),
        ];
        const capabilities = resolveCapabilities(modelId, patches);
        const next: Model = { provider_id: provider.id, model_id: modelId, display_name: `${provider.name} · ${modelId}`, enabled: existing?.enabled ?? true, capabilities: capabilities.capabilities, capability_source: capabilities.capability_source, verified_at: capabilities.verified_at, discovered_at: existing?.discovered_at ?? null };
        if (existing) Object.assign(existing, next);
        else state.models.push(next);
        models.push(next);
      }
      return { provider: structuredClone(provider), endpoint: structuredClone(endpoint), binding: structuredClone(binding), models: structuredClone(models) };
    });
    return result;
  }

  async updateProvider(id: string, input: UpdateProviderRequest): Promise<Provider> {
    await this.ensureMigrated();
    return this.repository.update((state) => {
      const item = state.providers.find((provider) => provider.id === id);
      if (!item) throw resourceError("resource_not_found", `Provider '${id}' was not found`);
      if (item.kind === "system") throw resourceError("invalid_resource", "System providers are read-only");
      if (input.name !== undefined) item.name = input.name.trim();
      if (input.adapter !== undefined) item.adapter = input.adapter;
      if (input.enabled !== undefined) item.enabled = input.enabled;
      if (input.catalog_mode !== undefined) item.catalog_mode = input.catalog_mode;
      if (input.auth_kind !== undefined) item.auth_kind = input.auth_kind;
      item.updated_at = now();
      return structuredClone(item);
    });
  }

  async deleteProvider(id: string, cascade = false): Promise<{ id: string; removed_models: number; removed_bindings: number }> {
    await this.ensureMigrated();
    const settings = await this.settings.read();
    const state = await this.repository.read();
    const item = state.providers.find((provider) => provider.id === id);
    if (!item) throw resourceError("resource_not_found", `Provider '${id}' was not found`);
    if (item.kind === "system") throw resourceError("invalid_resource", "System providers cannot be deleted");
    const modelIds = state.models.filter((model) => model.provider_id === id).map((model) => canonicalModelRef(id, model.model_id));
    const aliases = Object.entries(state.aliases).filter(([, target]) => modelIds.includes(target)).map(([alias]) => alias);
    const defaultModel = String(settings.model ?? "");
    const bindings = state.bindings.filter((binding) => binding.provider_id === id);
    if (!cascade && (bindings.length > 0 || modelIds.some((model) => model === defaultModel || aliases.includes(defaultModel)))) throw resourceError("resource_in_use", `Provider '${id}' is still referenced`);
    await this.repository.update((current) => {
      current.providers = current.providers.filter((provider) => provider.id !== id);
      current.models = current.models.filter((model) => model.provider_id !== id);
      current.bindings = current.bindings.filter((binding) => binding.provider_id !== id);
      for (const alias of aliases) delete current.aliases[alias];
    });
    if (cascade && (modelIds.includes(defaultModel) || aliases.includes(defaultModel))) await this.settings.update((current) => { current.model = ""; });
    return { id, removed_models: modelIds.length, removed_bindings: bindings.length };
  }

  async listEndpoints(): Promise<Endpoint[]> {
    await this.ensureMigrated();
    return (await this.repository.read()).endpoints;
  }

  async getEndpoint(id: string): Promise<Endpoint> {
    const endpoint = (await this.listEndpoints()).find((item) => item.id === id);
    if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
    return endpoint;
  }

  async createEndpoint(input: CreateEndpointRequest): Promise<Endpoint> {
    await this.ensureMigrated();
    const baseUrl = normalizeBaseUrl(input.base_url);
    const protocol = normalizeProtocol(input.protocol);
    if (input.credential_ref !== undefined && input.credential_ref !== null && !(await this.credentials.metadata(input.credential_ref))) throw resourceError("resource_not_found", `Credential '${input.credential_ref}' was not found`);
    const endpointId = input.id || ModelResourceRepository.endpointId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(endpointId)) throw resourceError("invalid_resource", "Endpoint ID must be URL-safe");
    const endpoint: Endpoint = {
      id: endpointId,
      name: input.name.trim(),
      base_url: baseUrl,
      protocol,
      ...(input.api ? { api: input.api } : {}),
      credential_ref: input.credential_ref ?? null,
      enabled: input.enabled,
      health: "unknown",
      data_egress: input.data_egress,
      ...(input.rate_limit ? { rate_limit: input.rate_limit } : {}),
      ...(input.network_policy ? { network_policy: input.network_policy } : {}),
      last_checked_at: null,
      last_error: null,
      created_at: now(),
      updated_at: now(),
    };
    return this.repository.update((state) => {
      if (state.endpoints.some((item) => item.id === endpoint.id)) throw resourceError("provider_id_conflict", `Endpoint ID '${endpoint.id}' already exists`);
      state.endpoints.push(endpoint);
      return structuredClone(endpoint);
    });
  }

  async updateEndpoint(id: string, input: UpdateEndpointRequest): Promise<Endpoint> {
    await this.ensureMigrated();
    if (input.credential_ref !== undefined && input.credential_ref !== null && !(await this.credentials.metadata(input.credential_ref))) throw resourceError("resource_not_found", `Credential '${input.credential_ref}' was not found`);
    return this.repository.update((state) => {
      const endpoint = state.endpoints.find((item) => item.id === id);
      if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
      if (input.name !== undefined) endpoint.name = input.name.trim();
      if (input.base_url !== undefined) endpoint.base_url = normalizeBaseUrl(input.base_url);
      if (input.protocol !== undefined) endpoint.protocol = normalizeProtocol(input.protocol);
      if (input.api !== undefined) endpoint.api = input.api;
      if (input.credential_ref !== undefined) endpoint.credential_ref = input.credential_ref;
      if (input.enabled !== undefined) {
        endpoint.enabled = input.enabled;
        if (!input.enabled) endpoint.health = "blocked";
      }
      if (input.data_egress !== undefined) endpoint.data_egress = input.data_egress;
      if (input.rate_limit !== undefined) endpoint.rate_limit = input.rate_limit;
      if (input.network_policy !== undefined) endpoint.network_policy = input.network_policy;
      endpoint.updated_at = now();
      return structuredClone(endpoint);
    });
  }

  async deleteEndpoint(id: string, cascade = false): Promise<{ id: string; removed_bindings: number }> {
    await this.ensureMigrated();
    const state = await this.repository.read();
    if (!state.endpoints.some((endpoint) => endpoint.id === id)) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
    const bindings = state.bindings.filter((binding) => binding.endpoint_id === id);
    if (bindings.length > 0 && !cascade) throw resourceError("resource_in_use", `Endpoint '${id}' is still referenced by bindings`);
    await this.repository.update((current) => {
      current.endpoints = current.endpoints.filter((endpoint) => endpoint.id !== id);
      current.bindings = current.bindings.filter((binding) => binding.endpoint_id !== id);
    });
    return { id, removed_bindings: bindings.length };
  }

  async setEndpointEnabled(id: string, enabled: boolean): Promise<Endpoint> {
    return this.updateEndpoint(id, { enabled });
  }

  async probeEndpoint(id: string): Promise<HealthResult> {
    await this.ensureMigrated();
    const endpoint = await this.getEndpoint(id);
    if (!endpoint.enabled) {
      return this.updateHealth(id, "blocked", "endpoint disabled");
    }
    try {
      const settings = await this.settings.read();
      const allowPrivate = endpoint.network_policy?.allow_private ?? (settings.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0");
      await validateOutboundHttpUrl(endpoint.base_url, { allowPrivate });
      if (await egressAuditEnabled()) await recordEgress({ connector_type: "connector", connector_id: `endpoint-health:${endpoint.id}`, target_domain: endpoint.base_url, approved: true, note: `endpoint_id=${endpoint.id}` });
      const credential = endpoint.credential_ref ? await this.credentials.getForRuntime(endpoint.credential_ref) : null;
      const response = await safeConnectorFetch(discoveryPath(endpoint), {
        allowPrivate,
        maxRedirects: 3,
        maxResponseBytes: MAX_MODEL_DISCOVERY_BYTES,
        timeoutMs: 8_000,
        headers: { ...authHeaders(endpoint.protocol, credential?.secret ?? null) },
      });
      await response.body?.cancel();
      return this.updateHealth(id, response.ok ? "ready" : "degraded", response.ok ? null : `endpoint returned ${response.status}`);
    } catch (error) {
      return this.updateHealth(id, "error", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
    }
  }

  async listBindings(filters: { provider_id?: string; endpoint_id?: string } = {}): Promise<ProviderEndpointBinding[]> {
    await this.ensureMigrated();
    const state = await this.repository.read();
    return state.bindings.filter((binding) => (!filters.provider_id || binding.provider_id === filters.provider_id) && (!filters.endpoint_id || binding.endpoint_id === filters.endpoint_id)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  async createBinding(input: CreateBindingRequest): Promise<ProviderEndpointBinding> {
    await this.ensureMigrated();
    const headersPolicy = secureHeaderPolicy(input.headers_policy);
    const bindingId = input.id || ModelResourceRepository.bindingId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bindingId)) throw resourceError("invalid_resource", "Binding ID must be URL-safe");
    const binding: ProviderEndpointBinding = {
      id: bindingId,
      provider_id: input.provider_id,
      endpoint_id: input.endpoint_id,
      enabled: input.enabled,
      priority: input.priority,
      ...(input.model_allowlist ? { model_allowlist: input.model_allowlist } : {}),
      ...(input.model_aliases ? { model_aliases: input.model_aliases } : {}),
      ...(headersPolicy ? { headers_policy: headersPolicy } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      created_at: now(),
      updated_at: now(),
    };
    return this.repository.update((state) => {
      if (!state.providers.some((provider) => provider.id === binding.provider_id)) throw resourceError("resource_not_found", `Provider '${binding.provider_id}' was not found`);
      if (!state.endpoints.some((endpoint) => endpoint.id === binding.endpoint_id)) throw resourceError("resource_not_found", `Endpoint '${binding.endpoint_id}' was not found`);
      if (state.bindings.some((item) => item.provider_id === binding.provider_id && item.endpoint_id === binding.endpoint_id)) throw resourceError("provider_id_conflict", "A provider-endpoint binding already exists");
      state.bindings.push(binding);
      return structuredClone(binding);
    });
  }

  async updateBinding(id: string, input: UpdateBindingRequest): Promise<ProviderEndpointBinding> {
    await this.ensureMigrated();
    const headersPolicy = secureHeaderPolicy(input.headers_policy);
    return this.repository.update((state) => {
      const binding = state.bindings.find((item) => item.id === id);
      if (!binding) throw resourceError("resource_not_found", `Binding '${id}' was not found`);
      if (input.enabled !== undefined) binding.enabled = input.enabled;
      if (input.priority !== undefined) binding.priority = input.priority;
      if (input.model_allowlist !== undefined) binding.model_allowlist = input.model_allowlist;
      if (input.model_aliases !== undefined) binding.model_aliases = input.model_aliases;
      if (input.headers_policy !== undefined) binding.headers_policy = headersPolicy;
      if (input.metadata !== undefined) binding.metadata = input.metadata;
      binding.updated_at = now();
      return structuredClone(binding);
    });
  }

  async deleteBinding(id: string): Promise<{ id: string }> {
    await this.ensureMigrated();
    return this.repository.update((state) => {
      if (!state.bindings.some((binding) => binding.id === id)) throw resourceError("resource_not_found", `Binding '${id}' was not found`);
      state.bindings = state.bindings.filter((binding) => binding.id !== id);
      return { id };
    });
  }

  async listModels(filters: { provider_id?: string; available?: boolean } = {}): Promise<ModelRead[]> {
    await this.ensureMigrated();
    const state = await this.repository.read();
    const resolver = new RuntimeModelResolver(this.repository, this.credentials);
    const resolved = await resolver.resolveAvailableModels();
    const userModels = state.models
      .filter((model) => !filters.provider_id || model.provider_id === filters.provider_id)
      .map((model) => resolvedModelToRead(resolved.find((item) => item.id === canonicalModelRef(model.provider_id, model.model_id)) ?? {
        id: canonicalModelRef(model.provider_id, model.model_id), provider_id: model.provider_id, model_id: model.model_id, display_name: model.display_name, available: false, capabilities: model.capabilities, capability_source: model.capability_source, routes: [], availability_reason: "no_routable_endpoint",
      }, model));
    const systemProviderIds = new Set((await loadPiAiProviderCatalog()).map((provider) => provider.id));
    const systemModels = filters.provider_id && !systemProviderIds.has(filters.provider_id)
      ? []
      : await this.systemModelReads();
    const all = [...userModels, ...systemModels].filter((model) => filters.available === undefined || model.available === filters.available);
    return all.sort((a, b) => a.id.localeCompare(b.id));
  }

  async getModel(providerId: string, modelId: string): Promise<ModelRead> {
    const model = (await this.listModels({ provider_id: providerId })).find((item) => item.model_id === modelId);
    if (!model) throw resourceError("resource_not_found", `Model '${providerId}/${modelId}' was not found`);
    return model;
  }

  async updateModel(providerId: string, modelId: string, body: Record<string, unknown>): Promise<ModelRead> {
    await this.ensureMigrated();
    await this.repository.update((state) => {
      const provider = state.providers.find((item) => item.id === providerId);
      if (!provider) throw resourceError("resource_not_found", `Provider '${providerId}' was not found`);
      if (provider.kind === "system") throw resourceError("invalid_resource", "System provider models are read-only");
      let current = state.models.find((item) => item.provider_id === providerId && item.model_id === modelId);
      const manual = manualCapabilityPatch(body);
      if (!current) {
        const merged = resolveCapabilities(modelId, [manual]);
        current = {
          provider_id: providerId,
          model_id: modelId,
          display_name: typeof body.display_name === "string" && body.display_name.trim() ? body.display_name.trim() : `${provider.name} · ${modelId}`,
          enabled: body.enabled !== false,
          capabilities: merged.capabilities,
          capability_source: merged.capability_source,
          verified_at: merged.verified_at,
          discovered_at: null,
        };
        state.models.push(current);
      } else {
        const merged = resolveCapabilities(modelId, [
          { ...current.capabilities, source: current.capability_source, verified_at: current.verified_at },
          manual,
        ]);
        current.display_name = typeof body.display_name === "string" && body.display_name.trim() ? body.display_name.trim() : current.display_name;
        current.enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
        current.capabilities = merged.capabilities;
        current.capability_source = merged.capability_source;
        current.verified_at = merged.verified_at;
        current.discovered_at = current.discovered_at ?? null;
      }
    });
    const result = await this.listModels({ provider_id: providerId });
    const model = result.find((item) => item.model_id === modelId);
    if (!model) throw resourceError("resource_not_found", `Model '${providerId}/${modelId}' was not found`);
    return model;
  }

  async applyRuntimeCapabilities(providerId: string, modelId: string, patch: Partial<ModelCapabilities>): Promise<Model | null> {
    await this.ensureMigrated();
    return this.repository.update((state) => {
      const model = state.models.find((item) => item.provider_id === providerId && item.model_id === modelId);
      if (!model) return null;
      const resolved = resolveCapabilities(modelId, [
        { ...model.capabilities, source: model.capability_source, verified_at: model.verified_at },
        { ...patch, source: "runtime", verified_at: now() },
      ]);
      model.capabilities = resolved.capabilities;
      model.capability_source = "runtime";
      model.verified_at = resolved.verified_at;
      return structuredClone(model);
    });
  }

  async deleteModel(providerId: string, modelId: string): Promise<{ provider_id: string; model_id: string; default_cleared: boolean }> {
    await this.ensureMigrated();
    const ref = canonicalModelRef(providerId, modelId);
    const state = await this.repository.read();
    if (!state.models.some((model) => model.provider_id === providerId && model.model_id === modelId)) throw resourceError("resource_not_found", `Model '${ref}' was not found`);
    const settings = await this.settings.read();
    const defaultCleared = settings.model === ref || state.aliases[settings.model ?? ""] === ref;
    await this.repository.update((current) => {
      current.models = current.models.filter((model) => model.provider_id !== providerId || model.model_id !== modelId);
      for (const [alias, target] of Object.entries(current.aliases)) if (target === ref) delete current.aliases[alias];
    });
    if (defaultCleared) await this.settings.update((current) => { current.model = ""; });
    return { provider_id: providerId, model_id: modelId, default_cleared: defaultCleared };
  }

  async discover(providerId: string, bindingId?: string): Promise<DiscoveryResult> {
    await this.ensureMigrated();
    const state = await this.repository.read();
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) throw resourceError("resource_not_found", `Provider '${providerId}' was not found`);
    const bindings = state.bindings.filter((binding) => binding.provider_id === providerId && binding.enabled).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const binding = bindingId ? bindings.find((item) => item.id === bindingId) : bindings[0];
    if (!binding) throw resourceError("no_routable_endpoint", `Provider '${providerId}' has no enabled binding`);
    const endpoint = state.endpoints.find((item) => item.id === binding.endpoint_id);
    if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${binding.endpoint_id}' was not found`);
    const credential = endpoint.credential_ref ? await this.credentials.getForRuntime(endpoint.credential_ref) : null;
    if (provider.auth_kind !== "none" && (!credential || !credential.secret)) throw resourceError("no_routable_endpoint", "Provider endpoint credential is not configured");
    const settings = await this.settings.read();
    const allowPrivate = endpoint.network_policy?.allow_private ?? (settings.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0");
    const response = await safeConnectorFetch(discoveryPath(endpoint), {
      allowPrivate,
      maxRedirects: 3,
      maxResponseBytes: MAX_MODEL_DISCOVERY_BYTES,
      timeoutMs: 10_000,
      headers: { ...authHeaders(endpoint.protocol, credential?.secret ?? null), ...(binding.headers_policy ?? {}) },
    }).catch((error) => { throw resourceError("endpoint_probe_failed", error instanceof Error ? error.message : String(error)); });
    const payload = await readBoundedJson(response).catch((error) => { throw resourceError("endpoint_probe_failed", error instanceof Error ? error.message : String(error)); });
    if (!response.ok) throw resourceError("endpoint_probe_failed", redactSecret(String(payload.error ?? payload.message ?? `endpoint returned ${response.status}`), credential?.secret));
    await this.updateHealth(endpoint.id, "ready", null);
    const rows = modelRows(payload);
    if (rows.length === 0) throw resourceError("discovery_empty", "No models were returned by this endpoint");
    const discoveredAt = now();
    await this.repository.update((current) => {
      for (const row of rows) {
        const existing = current.models.find((model) => model.provider_id === providerId && model.model_id === row.id);
        const patch = capabilityPatchFromPayload(row.raw);
        const resolved = resolveCapabilities(row.id, [
          ...(existing ? [{ ...existing.capabilities, source: existing.capability_source, verified_at: existing.verified_at }] : []),
          { ...patch, source: "discovery" },
        ]);
        const next: Model = {
          provider_id: providerId,
          model_id: row.id,
          display_name: `${provider.name} · ${row.id}`,
          enabled: existing?.enabled ?? true,
          capabilities: resolved.capabilities,
          capability_source: resolved.capability_source,
          verified_at: existing?.verified_at ?? null,
          discovered_at: discoveredAt,
        };
        if (existing) Object.assign(existing, next);
        else current.models.push(next);
      }
    });
    if (await egressAuditEnabled()) await recordEgress({ connector_type: "connector", connector_id: binding.id, target_domain: endpoint.base_url, approved: true, note: `Provider model discovery provider_id=${providerId} binding_id=${binding.id} endpoint_id=${endpoint.id}` });
    const models = await this.listModels({ provider_id: providerId });
    return { provider: await this.getProvider(providerId), binding_id: binding.id, endpoint_id: endpoint.id, models, warnings: [] };
  }

  async migrationStatus(): Promise<MigrationResult> {
    return this.ensureMigrated();
  }

  async modelPreferences(): Promise<{ default_model: string | null; thinking: string; compaction_enabled: boolean; compaction_threshold_percent: number }> {
    await this.ensureMigrated();
    const settings = await this.settings.read();
    return {
      default_model: typeof settings.model === "string" && settings.model ? settings.model : null,
      thinking: typeof settings.thinking === "string" && settings.thinking ? settings.thinking : "off",
      compaction_enabled: settings.compaction_enabled !== false,
      compaction_threshold_percent: typeof settings.compaction_threshold_percent === "number" ? settings.compaction_threshold_percent : 85,
    };
  }

  private async systemModelReads(): Promise<ModelRead[]> {
    const state = await this.repository.read();
    const providers = await loadPiAiProviderCatalog();
    const catalog = await loadPiAiCatalog();
    const result: ModelRead[] = [];
    for (const provider of providers) {
      const hasCredential = Boolean(state.credential_refs[provider.id] && await this.credentials.getForRuntime(state.credential_refs[provider.id]!).then((value) => value?.secret)) || (provider.apiKeySupported && await hasEnvApiKey(provider.id));
      const available = hasCredential || (!provider.apiKeySupported && !provider.oauthSupported);
      const entries = catalog.filter((entry) => String(entry.provider) === provider.id);
      for (const entry of entries) {
        const modelId = String(entry.id ?? "");
        if (!modelId) continue;
        const resolved = resolveCapabilities(modelId, [{ ...capabilityPatchFromPayload(entry), source: "provider" }]);
        result.push({
          provider_id: provider.id,
          model_id: modelId,
          display_name: `${provider.name} · ${String(entry.name ?? modelId)}`,
          enabled: available,
          capabilities: resolved.capabilities,
          capability_source: resolved.capability_source,
          verified_at: null,
          discovered_at: null,
          id: canonicalModelRef(provider.id, modelId),
          available,
          ...(available ? {} : { availability_reason: provider.oauthSupported && !provider.apiKeySupported ? "needs_login" : "missing_credential" }),
          routes: [],
        });
      }
    }
    return result;
  }

  private async updateHealth(id: string, health: Endpoint["health"], error: string | null): Promise<HealthResult> {
    return this.repository.update((state) => {
      const endpoint = state.endpoints.find((item) => item.id === id);
      if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${id}' was not found`);
      endpoint.health = health;
      endpoint.last_checked_at = now();
      endpoint.last_error = error;
      endpoint.updated_at = now();
      return structuredClone(endpoint);
    });
  }
}

export function providerReadToLegacy(provider: ProviderRead): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    models: provider.models,
    has_key: provider.has_key,
    auth: {
      kind: provider.auth_kind,
      api_key_supported: provider.auth_kind === "api_key" || provider.auth_kind === "api_key_or_oauth",
      oauth_supported: provider.auth_kind === "oauth" || provider.auth_kind === "api_key_or_oauth",
      login_supported: false,
    },
    credential_status: provider.credential_status,
    enabled: provider.enabled,
  };
}

export function modelResourceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
