import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createHash } from "node:crypto";
import { withFileWriteLock } from "../storage/persistence.js";
import { modelResourcePath } from "../model-resources/model-resource-repository.js";
import type { ModelResourceState, ModelConfigSnapshot, ProviderConfig } from "@pi-science/contracts";
import { ModelResourceRepository } from "../model-resources/model-resource-repository.js";
import { ModelConfigService, configError, isAllowedModelEnvRef } from "./model-config-service.js";

/** Conservative conversion: every non-equivalent route remains owned by the legacy adapter. */
export class ModelConfigMigration {
  constructor(private readonly service = new ModelConfigService(), private readonly repository = new ModelResourceRepository()) {}
  async plan(state: ModelResourceState = this.repository.readSync()) {
    const snapshot = this.service.readSync();
    const next = structuredClone(snapshot);
    const credentials = await this.service.credentials.listMetadata();
    const rows: Array<{ provider_id: string; status: "migrated" | "legacy" | "existing"; reasons: string[]; model_count: number }> = [];
    for (const provider of state.providers) {
      const models = state.models.filter((model) => model.provider_id === provider.id);
      if (next.config.providers[provider.id] || next.legacy_providers.includes(provider.id)) { rows.push({ provider_id: provider.id, status: "existing", reasons: [], model_count: models.length }); continue; }
      const bindings = state.bindings.filter((binding) => binding.provider_id === provider.id);
      const binding = bindings[0];
      const endpoint = binding && state.endpoints.find((endpoint) => endpoint.id === binding.endpoint_id);
      const reasons: string[] = [];
      if (provider.kind === "user" && !models.length) reasons.push("empty_model_catalog");
      if (endpoint && state.bindings.some((other) => other.provider_id !== provider.id && other.endpoint_id === endpoint.id)) reasons.push("shared_endpoint");
      // A native endpoint can still be a gateway. Preserve its legacy dispatcher
      // until factory, destination and protocol equivalence can all be proven.
      if (endpoint?.protocol === "native") reasons.push("native_endpoint_transport");
      if (provider.kind === "user" && models.some((model) => !["manual", "runtime"].includes(model.capability_source))) reasons.push("unverified_capabilities");
      if (models.some((model) => model.capabilities.tools !== undefined || model.capabilities.structured_output !== undefined)) reasons.push("capability_metadata");
      if (!provider.enabled || provider.auth_kind === "oauth" || models.some((model) => !model.enabled)) reasons.push("disabled_or_oauth");
      if (bindings.length !== 1 || !binding?.enabled || binding.priority !== 100) reasons.push("routing_or_priority");
      if (binding?.model_aliases && Object.keys(binding.model_aliases).length || binding?.headers_policy && Object.keys(binding.headers_policy).length || binding?.model_allowlist) reasons.push("binding_policy");
      if (!endpoint || !endpoint.enabled || endpoint.health === "blocked" || endpoint.health === "error" || endpoint.protocol === "ollama" || provider.kind === "user" && endpoint.protocol === "native" || endpoint.network_policy || endpoint.rate_limit) reasons.push("endpoint_policy");
      if (provider.auth_kind !== "none" && !endpoint?.credential_ref) reasons.push("missing_endpoint_credential");
      const ref = endpoint?.credential_ref ?? state.credential_refs[provider.id];
      const credential = credentials.find((item) => item.id === ref);
      if (credential?.backend === "environment" && !isAllowedModelEnvRef(credential.environment_variable)) reasons.push("reserved_environment");
      if (ref && (!credential || credential.owner_kind === "mcp"
        || credential.owner_provider_id && credential.owner_provider_id !== provider.id
        || credential.owner_kind === "provider" && credential.owner_id && credential.owner_id !== provider.id
        || credential.kind === "oauth" || !["managed", "environment"].includes(credential.backend)
        || state.endpoints.some((item) => item.id !== endpoint?.id && item.credential_ref === ref)
        || Object.entries(state.credential_refs).some(([id, value]) => id !== provider.id && value === ref)
        || state.credential_refs[provider.id] && state.credential_refs[provider.id] !== ref)) reasons.push("shared_or_unsupported_credential");
      // Native endpoints stay legacy; other accepted custom transports are explicit.
      const api = binding?.metadata?.api ?? endpoint?.api;
      if (api === "ollama" || api && !["native", "openai-completions", "openai-responses", "anthropic-messages"].includes(api)) reasons.push("unsupported_api");
      if (reasons.length) { next.legacy_providers.push(provider.id); rows.push({ provider_id: provider.id, status: "legacy", reasons, model_count: models.length }); continue; }
      const config: ProviderConfig = { name: provider.name };
      if (endpoint && endpoint.protocol !== "native") {
        config.baseUrl = endpoint.base_url;
        config.api = api === "openai-responses" || api === "openai-completions" || api === "anthropic-messages" ? api : endpoint.protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
      }
      config.models = models.map((model) => ({ id: model.model_id, name: model.display_name,
        ...(model.capability_source === "manual" || model.capability_source === "runtime" ? {
          reasoning: model.capabilities.reasoning,
          thinkingLevelMap: Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, model.capabilities.reasoning && model.capabilities.thinking_levels.includes(level) ? level : null])), ...(model.capabilities.vision !== undefined ? { input: ["text", ...(model.capabilities.vision ? ["image" as const] : [])] as ("text" | "image")[] } : {}),
          ...(model.capabilities.context_window ? { contextWindow: model.capabilities.context_window } : {}),
          ...(model.capabilities.max_output_tokens ? { maxTokens: model.capabilities.max_output_tokens } : {}),
        } : {}) }));
      next.config.providers[provider.id] = config;
      if (ref) next.credential_refs[provider.id] = ref;
      if (provider.auth_kind === "none") next.keyless_providers.push(provider.id);
      rows.push({ provider_id: provider.id, status: "migrated", reasons: [], model_count: models.length });
    }
    // Builtin keys live in credential_refs without a Provider entity in the old graph.
    const builtin = builtinModels();
    for (const [id, ref] of Object.entries(state.credential_refs)) {
      if (state.providers.some((provider) => provider.id === id) || next.config.providers[id] || next.legacy_providers.includes(id)) continue;
      const provider = builtin.getProvider(id);
      const credential = credentials.find((item) => item.id === ref);
      const reasons: string[] = [];
      if (!provider) reasons.push("orphan_provider_reference");
      if (!credential || credential.owner_kind === "mcp" || credential.owner_provider_id && credential.owner_provider_id !== id
        || credential.owner_kind === "provider" && credential.owner_id && credential.owner_id !== id || credential.kind !== "api_key" || !["managed", "environment"].includes(credential.backend)
        || credential.backend === "environment" && !isAllowedModelEnvRef(credential.environment_variable)
        || Object.values(state.credential_refs).filter((value) => value === ref).length > 1
        || state.endpoints.some((endpoint) => endpoint.credential_ref === ref)) reasons.push("shared_or_unsupported_credential");
      if (reasons.length) next.legacy_providers.push(id);
      else { next.config.providers[id] = {}; next.credential_refs[id] = ref; }
      rows.push({ provider_id: id, status: reasons.length ? "legacy" : "migrated", reasons, model_count: provider?.getModels().length ?? 0 });
    }
    next.aliases = { ...state.aliases, ...next.aliases };
    return { source_revision: createHash("sha256").update(JSON.stringify({ state, credentials })).digest("hex"), revision: snapshot.revision, providers: rows, counts: { providers: state.providers.length, models: state.models.length, endpoints: state.endpoints.length, bindings: state.bindings.length, credentials: credentials.length, provider_credentials: Object.keys(state.credential_refs).length }, snapshot: next };
  }
  async apply(revision: number, sourceRevision?: string) {
    return withFileWriteLock(modelResourcePath(), async () => {
      const report = await this.plan();
      if (report.revision !== revision || sourceRevision && sourceRevision !== report.source_revision) throw configError("revision_conflict", "Migration preview is stale");
      let backup = "";
      const snapshot = await this.service.update(revision, async (current) => {
        backup = await this.service.backup();
        Object.assign(current, report.snapshot);
      });
      return { revision: snapshot.revision, providers: report.providers, counts: report.counts, backup };
    });
  }
}
