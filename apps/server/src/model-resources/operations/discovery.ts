import type { Endpoint, Model } from "@pi-science/contracts";
import { egressAuditEnabled, recordEgress } from "../../security/egress-audit.js";
import { safeConnectorFetch } from "../../security/outbound-security.js";
import { resolveCapabilities, type CapabilityPatch } from "../capability-resolver.js";
import { discoverModelRows } from "../model-discovery.js";
import type { DiscoveryResult } from "./types.js";
import { resourceError, now, normalizeProtocol, normalizeBaseUrl } from "./validation.js";
import { capabilityPatchFromPayload } from "./capabilities.js";
import { modelRows, redactSecret, authHeaders, MAX_MODEL_DISCOVERY_BYTES, readBoundedJson, discoveryPath } from "./discovery-http.js";
import type { ModelResourceContext } from "./context.js";
import { updateHealth } from "./endpoints.js";

type Context = Pick<ModelResourceContext, "credentials" | "ensureMigrated" | "getProvider" | "listModels" | "repository" | "settings">;

export async function testProviderConfiguration(context: Context, input: { protocol: Endpoint["protocol"]; base_url: string; api?: Endpoint["api"]; auth?: { kind: "api_key" | "none"; secret?: string } | null }): Promise<{ ok: true; health: "ready"; models: Array<{ id: string; display_name: string; kind?: "chat" | "embedding" | "rerank" | "unknown"; capabilities: CapabilityPatch }> }> {
  const protocol = normalizeProtocol(input.protocol);
  const baseUrl = normalizeBaseUrl(input.base_url);
  const endpoint = { protocol, base_url: baseUrl };
  const secret = input.auth?.kind === "api_key" ? input.auth.secret : undefined;
  const settings = await context.settings.read();
  const allowPrivate = settings.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0";
  const rows = await discoverModelRows(discoveryPath(endpoint), protocol, authHeaders(protocol, secret ?? null), allowPrivate);
  return { ok: true, health: "ready", models: rows.map((row) => {
    const raw = row.raw && typeof row.raw === "object" ? row.raw as Record<string, unknown> : {};
    const name = raw.display_name ?? raw.name;
    const kind = String(raw.model_type ?? raw.task ?? raw.type ?? "").toLowerCase();
    const modelKind = ["embedding", "embeddings", "text-embedding"].includes(kind) ? "embedding" : ["rerank", "reranker", "text-reranking"].includes(kind) ? "rerank" : ["chat", "chat-completion", "text-generation"].includes(kind) || protocol === "anthropic" ? "chat" : undefined;
    return { id: row.id, display_name: typeof name === "string" && name.trim() ? name.trim() : row.id, ...(modelKind ? { kind: modelKind as "chat" | "embedding" | "rerank" } : {}), capabilities: capabilityPatchFromPayload(row.raw, protocol) };
  }) };
}

export async function discover(context: Context, providerId: string, bindingId?: string): Promise<DiscoveryResult> {
  await context.ensureMigrated();
  const state = await context.repository.read();
  const provider = state.providers.find((item) => item.id === providerId);
  if (!provider) throw resourceError("resource_not_found", `Provider '${providerId}' was not found`);
  const bindings = state.bindings.filter((binding) => binding.provider_id === providerId && binding.enabled).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const binding = bindingId ? bindings.find((item) => item.id === bindingId) : bindings[0];
  if (!binding) throw resourceError("no_routable_endpoint", `Provider '${providerId}' has no enabled binding`);
  const endpoint = state.endpoints.find((item) => item.id === binding.endpoint_id);
  if (!endpoint) throw resourceError("resource_not_found", `Endpoint '${binding.endpoint_id}' was not found`);
  const credential = endpoint.credential_ref ? await context.credentials.getForRuntime(endpoint.credential_ref) : null;
  if (provider.auth_kind !== "none" && (!credential || !credential.secret)) throw resourceError("no_routable_endpoint", "Provider endpoint credential is not configured");
  const settings = await context.settings.read();
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
  await updateHealth(context, endpoint.id, "ready", null);
  const rows = modelRows(payload);
  if (rows.length === 0) throw resourceError("discovery_empty", "No models were returned by this endpoint");
  const discoveredAt = now();
  await context.repository.update((current) => {
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
  const models = await context.listModels({ provider_id: providerId });
  return { provider: await context.getProvider(providerId), binding_id: binding.id, endpoint_id: endpoint.id, models, warnings: [] };
}
