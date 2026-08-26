import type { FastifyInstance, FastifyReply } from "fastify";
import { endpointId } from "../../config/model-endpoint.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import type { CreateEndpointRequest, Endpoint, UpdateEndpointRequest } from "@pi-science/contracts";
import { egressAuditEnabled, recordEgress } from "../../security/egress-audit.js";
import { safeConnectorFetch } from "../../security/outbound-security.js";
import { configPath, readJson, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";

type LegacyEndpoint = {
  endpoint_id: string;
  name: string;
  base_url: string;
  protocol: string;
  enabled: boolean;
  health: string;
  model_schema: Record<string, unknown>;
  rate_limit: Record<string, unknown>;
  secret_ref?: string | null;
  data_egress: string;
  error?: string | null;
};

export interface ModelEndpointRouteDependencies {
  probeHealth?: (url: string) => Promise<{ ok: boolean }>;
  /** Canonical resource service. When present, endpoints are stored in
   * model-resources.json and the old model-endpoints.json adapter is skipped. */
  service?: ModelResourceService;
  nodeSessionService?: NodeSessionService;
}

function endpointConfigPath(): string {
  return configPath("model-endpoints.json");
}

function parseBaseUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    return null;
  }

  return parsed.toString().replace(/\/$/, "");
}

async function defaultProbeHealth(url: string): Promise<{ ok: boolean }> {
  const settings = await readJson<{ allow_private_providers?: unknown }>(configPath("config.json"), {});
  const response = await safeConnectorFetch(url, {
    allowPrivate: settings.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0",
    maxRedirects: 3,
    maxResponseBytes: 64 * 1024,
    timeoutMs: 8_000,
  });
  await response.body?.cancel();
  return { ok: response.ok };
}

async function withEndpointRows<T>(operation: (rows: LegacyEndpoint[]) => Promise<T>): Promise<T> {
  return withFileWriteLock(endpointConfigPath(), async () => {
    const rows = await readJson<LegacyEndpoint[]>(endpointConfigPath(), []);
    return operation(rows);
  });
}

/** Serializes a canonical endpoint with legacy aliases during the migration
 * window. `secret_ref` is only a credential ID; it is never a secret value. */
function publicCanonicalEndpoint(endpoint: Endpoint): Record<string, unknown> {
  return {
    ...endpoint,
    endpoint_id: endpoint.id,
    secret_ref: endpoint.credential_ref,
    model_schema: {},
    rate_limit: endpoint.rate_limit ?? {},
    error: endpoint.last_error,
  };
}

function canonicalErrorStatus(error: unknown): number {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "invalid_resource";
  if (code === "resource_not_found") return 404;
  if (code === "resource_in_use" || code === "provider_id_conflict") return 409;
  if (code === "discovery_empty" || code === "no_routable_endpoint") return 422;
  if (code === "endpoint_probe_failed" || code === "runtime_reload_failed") return 502;
  return 400;
}

function canonicalError(reply: FastifyReply, error: unknown): FastifyReply {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "invalid_resource";
  return reply.code(canonicalErrorStatus(error)).send({ code, error: error instanceof Error ? error.message : String(error) });
}

async function canonicalReload(nodeSessionService: NodeSessionService | undefined, reply: FastifyReply, payload: Record<string, unknown>): Promise<Record<string, unknown> | FastifyReply> {
  if (!nodeSessionService) return payload;
  try { return { ...payload, session_replacements: await nodeSessionService.reloadConfiguration() }; }
  catch (error) { return reply.code(502).send({ ok: false, code: "runtime_reload_failed", error: `Endpoint was saved, but Pi runtime reload failed: ${error instanceof Error ? error.message : String(error)}` }); }
}

function canonicalProtocol(value: unknown): "openai" | "anthropic" | "ollama" | "native" {
  const raw = String(value ?? "openai").toLowerCase();
  if (raw.includes("anthropic")) return "anthropic";
  if (raw === "ollama") return "ollama";
  if (raw === "native") return "native";
  return "openai";
}

function registerCanonicalEndpointRoutes(app: FastifyInstance, service: ModelResourceService, nodeSessionService?: NodeSessionService): void {
  app.get("/api/endpoints", async (_request, reply) => {
    try { return { endpoints: (await service.listEndpoints()).map(publicCanonicalEndpoint) }; }
    catch (error) { return canonicalError(reply, error); }
  });
  app.post("/api/endpoints", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const protocol = canonicalProtocol(body.protocol);
      const baseUrl = String(body.base_url ?? "").trim().replace(/\/+$/, "");
      const existing = (await service.listEndpoints()).find((item) => item.name === String(body.name ?? "").trim() && item.base_url === baseUrl && item.protocol === protocol);
      const endpoint = existing ?? await service.createEndpoint({
        id: typeof body.id === "string" ? body.id : undefined,
        name: String(body.name ?? "").trim(),
        base_url: baseUrl,
        protocol,
        ...(typeof body.api === "string" && ["openai-completions", "openai-responses", "anthropic-messages", "ollama", "native"].includes(body.api) ? { api: body.api as CreateEndpointRequest["api"] } : {}),
        credential_ref: typeof body.credential_ref === "string" ? body.credential_ref : typeof body.secret_ref === "string" ? body.secret_ref : null,
        enabled: body.enabled !== false,
        data_egress: body.data_egress === "local" ? "local" : "remote",
        ...(body.rate_limit && typeof body.rate_limit === "object" ? { rate_limit: body.rate_limit as CreateEndpointRequest["rate_limit"] } : {}),
        ...(body.network_policy && typeof body.network_policy === "object" ? { network_policy: body.network_policy as CreateEndpointRequest["network_policy"] } : {}),
      });
      return await canonicalReload(nodeSessionService, reply, { ok: true, endpoint: publicCanonicalEndpoint(endpoint) });
    } catch (error) { return canonicalError(reply, error); }
  });
  app.get<{ Params: { endpoint_id: string } }>("/api/endpoints/:endpoint_id", async (request, reply) => {
    try { return { endpoint: publicCanonicalEndpoint(await service.getEndpoint(request.params.endpoint_id)) }; }
    catch (error) { return canonicalError(reply, error); }
  });
  app.put<{ Params: { endpoint_id: string } }>("/api/endpoints/:endpoint_id/enabled", async (request, reply) => {
    try {
      const enabled = String((request.query as { enabled?: string }).enabled ?? "true") !== "false";
      return await canonicalReload(nodeSessionService, reply, { ok: true, endpoint: publicCanonicalEndpoint(await service.setEndpointEnabled(request.params.endpoint_id, enabled)) });
    } catch (error) { return canonicalError(reply, error); }
  });
  app.put<{ Params: { endpoint_id: string } }>("/api/endpoints/:endpoint_id", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const input: UpdateEndpointRequest = {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(body.base_url !== undefined ? { base_url: String(body.base_url) } : {}),
        ...(body.protocol !== undefined ? { protocol: canonicalProtocol(body.protocol) } : {}),
        ...(typeof body.api === "string" && ["openai-completions", "openai-responses", "anthropic-messages", "ollama", "native"].includes(body.api) ? { api: body.api as UpdateEndpointRequest["api"] } : {}),
        ...(body.credential_ref !== undefined ? { credential_ref: body.credential_ref === null ? null : String(body.credential_ref) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled !== false } : {}),
        ...(body.data_egress !== undefined ? { data_egress: body.data_egress === "local" ? "local" : "remote" } : {}),
        ...(body.rate_limit !== undefined ? { rate_limit: body.rate_limit as CreateEndpointRequest["rate_limit"] } : {}),
        ...(body.network_policy !== undefined ? { network_policy: body.network_policy as CreateEndpointRequest["network_policy"] } : {}),
      };
      return await canonicalReload(nodeSessionService, reply, { ok: true, endpoint: publicCanonicalEndpoint(await service.updateEndpoint(request.params.endpoint_id, input)) });
    } catch (error) { return canonicalError(reply, error); }
  });
  app.delete<{ Params: { endpoint_id: string } }>("/api/endpoints/:endpoint_id", async (request, reply) => {
    try {
      const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
      const cascade = new URLSearchParams(request.url.split("?")[1] ?? "").get("cascade") === "true" || body.cascade === true;
      return await canonicalReload(nodeSessionService, reply, { ok: true, ...(await service.deleteEndpoint(request.params.endpoint_id, cascade)) });
    }
    catch (error) { return canonicalError(reply, error); }
  });
  app.post<{ Params: { endpoint_id: string } }>("/api/endpoints/:endpoint_id/health", async (request, reply) => {
    try {
      const endpoint = publicCanonicalEndpoint(await service.probeEndpoint(request.params.endpoint_id));
      return { ok: true, ...endpoint, endpoint };
    }
    catch (error) { return canonicalError(reply, error); }
  });
}

/** Restores the /api/endpoints CRUD routes dropped with run-endpoint-routes.ts in 314b456; the settings UI still drives provider management through them. */
export function registerModelEndpointRoutes(app: FastifyInstance, deps: ModelEndpointRouteDependencies = {}): void {
  if (deps.service) {
    registerCanonicalEndpointRoutes(app, deps.service, deps.nodeSessionService);
    return;
  }
  const probeHealth = deps.probeHealth ?? defaultProbeHealth;
  const usesDefaultProbe = !deps.probeHealth;

  app.get("/api/endpoints", async () => ({ endpoints: await readJson<LegacyEndpoint[]>(endpointConfigPath(), []) }));

  app.post("/api/endpoints", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const baseUrl = parseBaseUrl(body.base_url);
    if (!name || !baseUrl) {
      return reply.code(400).send({ error: "model endpoint name and absolute http(s) base_url are required" });
    }

    const endpoint: LegacyEndpoint = {
      endpoint_id: endpointId(name, baseUrl),
      name,
      base_url: baseUrl,
      protocol: String(body.protocol ?? "unknown"),
      enabled: true,
      health: "unknown",
      model_schema: typeof body.model_schema === "object" && body.model_schema ? body.model_schema as Record<string, unknown> : {},
      rate_limit: typeof body.rate_limit === "object" && body.rate_limit ? body.rate_limit as Record<string, unknown> : {},
      secret_ref: body.secret_ref ? String(body.secret_ref) : null,
      data_egress: String(body.data_egress ?? "remote"),
      error: null,
    };

    return withEndpointRows(async (rows) => {
      await writeJsonAtomic(endpointConfigPath(), [...rows.filter((row) => row.endpoint_id !== endpoint.endpoint_id), endpoint]);
      return endpoint;
    });
  });

  app.put<{ Params: { endpoint_id: string } }>("/api/endpoints/:endpoint_id/enabled", async (request, reply) => {
    return withEndpointRows(async (rows) => {
      const item = rows.find((row) => row.endpoint_id === request.params.endpoint_id);
      if (!item) return reply.code(404).send({ error: "Model endpoint not found" });

      const enabled = String((request.query as { enabled?: string }).enabled ?? "true") !== "false";
      item.enabled = enabled;
      if (!enabled) item.health = "blocked";
      await writeJsonAtomic(endpointConfigPath(), rows);
      return item;
    });
  });

  app.post<{ Params: { endpoint_id: string } }>("/api/endpoints/:endpoint_id/health", async (request, reply) => {
    return withEndpointRows(async (rows) => {
      const item = rows.find((row) => row.endpoint_id === request.params.endpoint_id);
      if (!item) return reply.code(404).send({ error: "Model endpoint not found" });

      if (!item.enabled) {
        item.health = "blocked";
        item.error = "endpoint disabled";
      } else {
        try {
          if (usesDefaultProbe && await egressAuditEnabled()) {
            await recordEgress({
              connector_type: "connector",
              connector_id: "model-endpoint-health",
              target_domain: item.base_url,
              approved: true,
              note: "User-requested model endpoint health probe",
            });
          }
          const response = await probeHealth(item.base_url);
          item.health = response.ok ? "ready" : "degraded";
          item.error = null;
        } catch (error) {
          item.health = "error";
          item.error = String(error instanceof Error ? error.message : error).slice(0, 300);
        }
      }

      await writeJsonAtomic(endpointConfigPath(), rows);
      return item;
    });
  });
}
