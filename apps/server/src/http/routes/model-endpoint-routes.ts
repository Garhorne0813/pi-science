import type { FastifyInstance } from "fastify";
import { endpointId } from "../../config/model-endpoint.js";
import { egressAuditEnabled, recordEgress } from "../../security/egress-audit.js";
import { safeConnectorFetch } from "../../security/outbound-security.js";
import { configPath, readJson, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";

type Endpoint = {
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

async function withEndpointRows<T>(operation: (rows: Endpoint[]) => Promise<T>): Promise<T> {
  return withFileWriteLock(endpointConfigPath(), async () => {
    const rows = await readJson<Endpoint[]>(endpointConfigPath(), []);
    return operation(rows);
  });
}

/** Restores the /api/endpoints CRUD routes dropped with run-endpoint-routes.ts in 314b456; the settings UI still drives provider management through them. */
export function registerModelEndpointRoutes(app: FastifyInstance, deps: ModelEndpointRouteDependencies = {}): void {
  const probeHealth = deps.probeHealth ?? defaultProbeHealth;
  const usesDefaultProbe = !deps.probeHealth;

  app.get("/api/endpoints", async () => ({ endpoints: await readJson<Endpoint[]>(endpointConfigPath(), []) }));

  app.post("/api/endpoints", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const baseUrl = parseBaseUrl(body.base_url);
    if (!name || !baseUrl) {
      return reply.code(400).send({ error: "model endpoint name and absolute http(s) base_url are required" });
    }

    const endpoint: Endpoint = {
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
