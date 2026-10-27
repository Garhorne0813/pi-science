import type { Endpoint, ModelRead, Provider, ProviderView } from "@pi-science/contracts";
import type { RuntimeCatalog } from "../../runtime/agent/runtime-catalog.js";
import type { CredentialReader } from "../credential-store.js";
import { resolveCapabilities } from "../capability-resolver.js";
import { ModelResourceRepository } from "../model-resource-repository.js";
import { canonicalModelRef, resolvedModelToRead, RuntimeModelResolver } from "../runtime-model-resolver.js";
import type { ProviderRead } from "./types.js";
import { resourceError } from "./validation.js";
import type { ModelResourceContext } from "./context.js";

type Context = Pick<ModelResourceContext, "credentials" | "ensureMigrated" | "listModels" | "listProviders" | "repository" | "runtimeCatalog">;

export async function isModelAvailable(context: Context, ref: string): Promise<boolean> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  const canonical = state.aliases[ref] ?? ref;
  if (canonical.startsWith("user-")) return (await context.listModels({ available: true })).some((model) => model.id === canonical);
  return true;
}

export async function listProviders(context: Context, catalog?: RuntimeCatalog): Promise<ProviderRead[]> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  const result: ProviderRead[] = [];
  catalog ??= await readRuntimeCatalog(context);
  for (const entry of catalog.providers) {
    const ref = state.credential_refs[entry.id];
    const credential = ref ? await context.credentials.getForRuntime(ref) : null;
    const configured = Boolean(credential?.secret) || entry.auth.configured;
    const status = configured ? credential?.secret ? "configured" : "connected" : !entry.auth.apiKey && entry.auth.oauth ? "needs_login" : entry.auth.apiKey ? "needs_key" : "connected";
    result.push({
      id: entry.id,
      name: entry.name,
      kind: "system",
      adapter: "pi-ai",
      enabled: configured,
      catalog_mode: "runtime",
      auth_kind: entry.auth.apiKey && entry.auth.oauth ? "api_key_or_oauth" : entry.auth.oauth ? "oauth" : entry.auth.apiKey ? "api_key" : "none",
      source: "pi-ai",
      models: entry.models.map((model) => model.id),
      has_key: Boolean(credential?.secret),
      credential_status: status,
      routes: 0,
    });
  }
  const resolver = new RuntimeModelResolver(context.repository, context.credentials);
  const resolved = await resolver.resolveState(state);
  const modelsByProvider = new Map<string, string[]>();
  for (const model of state.models) {
    const models = modelsByProvider.get(model.provider_id) ?? [];
    models.push(model.model_id);
    modelsByProvider.set(model.provider_id, models);
  }
  const routeCounts = new Map<string, number>();
  for (const model of resolved) routeCounts.set(model.provider_id, (routeCounts.get(model.provider_id) ?? 0) + model.routes.length);
  const endpointsById = new Map(state.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const endpointsByProvider = new Map<string, Set<Endpoint>>();
  for (const binding of state.bindings) {
    const endpoint = endpointsById.get(binding.endpoint_id);
    if (!endpoint) continue;
    const endpoints = endpointsByProvider.get(binding.provider_id) ?? new Set<Endpoint>();
    endpoints.add(endpoint);
    endpointsByProvider.set(binding.provider_id, endpoints);
  }
  const credentialConfigured = new Map<string, boolean>();
  const hasCredential = (ref: string) => {
    if (!credentialConfigured.has(ref)) credentialConfigured.set(ref, Boolean(state.credential_refs[ref]) || Boolean(context.credentials.readSync(ref)?.secret));
    return credentialConfigured.get(ref)!;
  };
  for (const provider of state.providers) {
    const models = modelsByProvider.get(provider.id) ?? [];
    const hasConfiguredCredential = provider.auth_kind === "none" || [...(endpointsByProvider.get(provider.id) ?? [])]
      .some((endpoint) => Boolean(endpoint.credential_ref && hasCredential(endpoint.credential_ref)));
    const needsLogin = provider.auth_kind === "oauth" && !hasConfiguredCredential;
    result.push({
      ...provider,
      models,
      has_key: provider.auth_kind !== "none" && hasConfiguredCredential,
      credential_status: provider.auth_kind === "none" ? "connected" : hasConfiguredCredential ? "configured" : needsLogin ? "needs_login" : "needs_key",
      routes: routeCounts.get(provider.id) ?? 0,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function providerViews(context: Context, selectable: Set<string>, inputFormats: Map<string, string[]> = new Map(), catalogAvailable = true): Promise<ProviderView[]> {
  await context.ensureMigrated();
  const [state, catalog] = await Promise.all([context.repository.read(), readRuntimeCatalog(context)]);
  const providers = new Map<string, Provider>();
  const builtinConfigured = new Set(catalog.providers.filter((provider) => provider.auth.configured).map((provider) => provider.id));
  for (const entry of catalog.providers) providers.set(entry.id, { id: entry.id, name: entry.name, kind: "system", source: "pi-ai", adapter: "pi-ai", enabled: true, catalog_mode: "runtime", auth_kind: entry.auth.apiKey && entry.auth.oauth ? "api_key_or_oauth" : entry.auth.oauth ? "oauth" : entry.auth.apiKey ? "api_key" : "none" });
  for (const provider of state.providers) providers.set(provider.id, provider);
  const credentialRead = await context.credentials.readSnapshot();
  const declaredFormats = new Map(catalog.providers.flatMap((provider) => provider.models.map((model) => [canonicalModelRef(provider.id, model.id), model.input] as const)));
  const modelsByProvider = new Map<string, Map<string, ModelRead>>();
  const add = (model: ModelRead) => {
    const rows = modelsByProvider.get(model.provider_id) ?? new Map<string, ModelRead>();
    rows.set(model.id, model); modelsByProvider.set(model.provider_id, rows);
  };
  for (const model of await systemModelReads(context, state, catalog, credentialRead)) add(model);
  const sourceModels = new Map(state.models.map((model) => [canonicalModelRef(model.provider_id, model.model_id), model]));
  for (const model of await new RuntimeModelResolver(context.repository, credentialRead).resolveState(state)) add(resolvedModelToRead(model, sourceModels.get(model.id)));
  const refs = new Map<string, Set<string>>();
  const endpoints = new Map(state.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  for (const [id, ref] of Object.entries(state.credential_refs)) refs.set(id, new Set([ref]));
  for (const binding of state.bindings) {
    const ref = endpoints.get(binding.endpoint_id)?.credential_ref;
    if (ref) { const ids = refs.get(binding.provider_id) ?? new Set<string>(); ids.add(ref); refs.set(binding.provider_id, ids); }
  }
  // Owned credentials remain configured when their binding/endpoint needs
  // repair. Ownership is canonical metadata, not a guessed route association.
  for (const endpoint of state.endpoints) if (endpoint.owner_provider_id && endpoint.credential_ref) {
    const ids = refs.get(endpoint.owner_provider_id) ?? new Set<string>(); ids.add(endpoint.credential_ref); refs.set(endpoint.owner_provider_id, ids);
  }
  for (const credential of await credentialRead.listMetadata()) if (credential.owner_provider_id && credential.owner_kind !== "mcp") {
    const ids = refs.get(credential.owner_provider_id) ?? new Set<string>(); ids.add(credential.id); refs.set(credential.owner_provider_id, ids);
  }
  const endpointCredentialRefs = new Set(state.endpoints.map((endpoint) => endpoint.credential_ref).filter(Boolean));
  const credentials = new Map(await Promise.all([...new Set([...refs.values()].flatMap((ids) => [...ids]))].map(async (ref) => [ref, await credentialRead.getForRuntime(ref)] as const)));
  return [...providers.values()].map((provider): ProviderView => {
    const values = [...(refs.get(provider.id) ?? [])].map((ref) => credentials.get(ref));
    const configured = provider.auth_kind === "none" || provider.kind === "system" && builtinConfigured.has(provider.id) || values.some((value) => Boolean(value?.secret) && ["configured", "connected"].includes(value!.metadata.status));
    const credentialState = configured ? "ready" : values.some((value) => value?.metadata.status === "invalid") ? "invalid" : provider.auth_kind === "oauth" ? "needs_login" : "needs_key";
    const models = [...(modelsByProvider.get(provider.id)?.values() ?? [])].map((model) => {
      const available = provider.enabled && catalogAvailable && selectable.has(model.id);
      const formats = inputFormats.get(model.id) ?? declaredFormats.get(model.id);
      return { ...model, available, ...(formats ? { input_formats: formats } : {}), ...(available ? { availability_reason: undefined } : { availability_reason: !provider.enabled ? "provider_disabled" : model.availability_reason ?? (catalogAvailable ? "core_unavailable" : "catalog_unavailable") }) };
    });
    const count = models.filter((model) => model.available).length;
    const issues = [...new Set(models.filter((model) => !model.available).map((model) => model.availability_reason!))].map((code) => ({ code }));
    if (!models.length) issues.push({ code: "no_models" });
    if (!catalogAvailable && !issues.some((issue) => issue.code === "catalog_unavailable")) issues.push({ code: "catalog_unavailable" });
    if (provider.auth_kind === "oauth" && !count) issues.push({ code: "unsupported_login" });
    const status = !provider.enabled ? "disabled" : count ? "ready" : provider.auth_kind === "oauth" ? "needs_login" : credentialState !== "ready" ? credentialState : "unavailable";
    const custom = provider.kind === "user";
    const credentialRef = state.credential_refs[provider.id] ?? "";
    const removable = credentials.get(credentialRef)?.metadata.backend === "managed" && !endpointCredentialRefs.has(credentialRef);
    const apiKey = provider.auth_kind === "api_key" || provider.auth_kind === "api_key_or_oauth";
    return { id: provider.id, name: provider.name, source: custom ? "user" : "builtin", enabled: provider.enabled, status,
      auth: { kind: provider.auth_kind, api_key_supported: apiKey, login_supported: false },
      credential: { state: credentialState, configured },
      routing: { selectable_model_count: count, configured_model_count: models.length, issues }, models,
      // Endpoint probes and discovered capabilities are not inference verification.
      last_verification: { state: "never", checked_at: null },
      allowed_actions: [...(custom ? ["edit", provider.enabled ? "disable" : "enable", "delete", "discover"] as const : []), ...(apiKey ? ["replace_credential"] as const : []), ...(!custom && apiKey && removable ? ["remove_credential"] as const : [])] };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProvider(context: Context, id: string): Promise<ProviderRead> {
  const provider = (await context.listProviders()).find((item) => item.id === id);
  if (!provider) throw resourceError("resource_not_found", `Provider '${id}' was not found`);
  return provider;
}

export async function listModels(context: Context, filters: { provider_id?: string; available?: boolean } = {}, catalog?: RuntimeCatalog): Promise<ModelRead[]> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  const resolver = new RuntimeModelResolver(context.repository, context.credentials);
  const resolved = await resolver.resolveState(state);
  const resolvedById = new Map(resolved.map((model) => [model.id, model]));
  const userModels = state.models
    .filter((model) => !filters.provider_id || model.provider_id === filters.provider_id)
    .map((model) => resolvedModelToRead(resolvedById.get(canonicalModelRef(model.provider_id, model.model_id)) ?? {
      id: canonicalModelRef(model.provider_id, model.model_id), provider_id: model.provider_id, model_id: model.model_id, display_name: model.display_name, available: false, capabilities: model.capabilities, capability_source: model.capability_source, routes: [], availability_reason: "no_routable_endpoint",
    }, model));
  catalog ??= await readRuntimeCatalog(context);
  const systemProviderIds = new Set(catalog.providers.map((provider) => provider.id));
  const systemModels = filters.provider_id && !systemProviderIds.has(filters.provider_id)
    ? []
    : await systemModelReads(context, state, catalog);
  const all = [...userModels, ...systemModels].filter((model) => filters.available === undefined || model.available === filters.available);
  return all.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getModel(context: Context, providerId: string, modelId: string): Promise<ModelRead> {
  const model = (await context.listModels({ provider_id: providerId })).find((item) => item.model_id === modelId);
  if (!model) throw resourceError("resource_not_found", `Model '${providerId}/${modelId}' was not found`);
  return model;
}

export async function readRuntimeCatalog(context: Pick<ModelResourceContext, "runtimeCatalog">): Promise<RuntimeCatalog> {
  if (!context.runtimeCatalog) return { schemaVersion: 1 as const, providers: [] };
  try { return await context.runtimeCatalog.getCatalog(); }
  catch (error) {
    if (process.env.NODE_ENV !== "test") throw error;
    return { schemaVersion: 1 as const, providers: [] };
  }
}

export async function systemModelReads(context: Pick<ModelResourceContext, "credentials">, state: Awaited<ReturnType<ModelResourceRepository["read"]>>, catalog: RuntimeCatalog, credentials: CredentialReader = context.credentials): Promise<ModelRead[]> {
  const result: ModelRead[] = [];
  for (const provider of catalog.providers) {
    const ref = state.credential_refs[provider.id];
    const hasCredential = Boolean(ref && await credentials.getForRuntime(ref)?.then((value) => value?.secret)) || provider.auth.configured;
    const available = hasCredential || (!provider.auth.apiKey && !provider.auth.oauth);
    for (const entry of provider.models) {
      const modelId = entry.id;
      const capabilities = resolveCapabilities(modelId, [{ reasoning: entry.reasoning, thinking_levels: entry.reasoning ? entry.thinkingLevels ?? ["off", "minimal", "low", "medium", "high"] : ["off"], context_window: entry.contextWindow || null, max_output_tokens: entry.maxTokens || null, vision: entry.input.includes("image"), source: "provider" }]);
      result.push({
        provider_id: provider.id,
        model_id: modelId,
        display_name: `${provider.name} · ${entry.name}`,
        enabled: available,
        capabilities: capabilities.capabilities,
        capability_source: capabilities.capability_source,
        verified_at: null,
        discovered_at: null,
        id: canonicalModelRef(provider.id, modelId),
        available,
        ...(available ? {} : { availability_reason: provider.auth.oauth && !provider.auth.apiKey ? "needs_login" : "missing_credential" }),
        routes: [],
      });
    }
  }
  return result;
}
