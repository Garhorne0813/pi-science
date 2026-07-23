import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { gatewayHealthSchema, scientificRuntimeHealthSchema } from "@pi-science/contracts";
import type { ServerConfig } from "./config.js";
import { routeBoundary, runtimeOwner } from "./runtime-boundaries.js";
import { registerSessionReadRoutes } from "./session-routes.js";
import { registerSseRoutes } from "./sse-routes.js";
import { registerFileReadRoutes } from "./file-routes.js";
import { registerNodeSessionRoutes } from "./node-session-routes.js";
import { nodeSessionService } from "./node-session-service.js";
import { registerJobRoutes } from "./job-routes.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerRunEndpointRoutes } from "./run-endpoint-routes.js";
import { registerCatalogRoutes } from "./catalog-routes.js";
import { registerProjectRoutes } from "./project-routes.js";

export function buildApp(config: ServerConfig): FastifyInstance {
  nodeSessionService.configureScientificRuntime(config.pythonOrigin, config.internalToken);
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxBodyBytes,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"]?.toString() || randomUUID(),
  });

  void app.register(cors, { credentials: true, origin: config.corsOrigins });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (request.url.startsWith("/api/") && !routeBoundary(request.url.split("?")[0] ?? request.url)) {
      app.log.warn({ requestId: request.id, path: request.url }, "unregistered API route using compatibility proxy");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) {
      reply.header("x-pi-science-runtime", runtimeOwner(request.url.split("?")[0] ?? request.url));
    }
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : error.statusCode ?? 500;
    app.log.error({ err: error, requestId: request.id, path: request.url }, "request failed");
    return reply.code(statusCode).send({
      error: statusCode === 413 ? "request body too large" : "internal server error",
      request_id: request.id,
    });
  });

  app.get("/internal/live", async () => ({
    status: "ok",
    service: "pi-science-server",
    control_plane: "node",
  }));

  app.get("/api/health", async (_request, reply) => {
    const runtime = await readRuntimeHealth(config);
    if (!runtime) {
      return reply.code(503).send({ status: "degraded", service: "pi-science-server", control_plane: "node", scientific_runtime: "unavailable" });
    }
    return gatewayHealthSchema.parse({ ...runtime, active_pi_processes: runtime.active_pi_processes + nodeSessionService.activeCount, service: "pi-science-server", control_plane: "node", scientific_runtime: "ok" });
  });

  app.get("/internal/ready", async (_request, reply) => {
    const runtime = await readRuntimeHealth(config);
    if (!runtime) {
      return reply.code(503).send({ status: "not-ready", service: "pi-science-server", scientific_runtime: "unavailable" });
    }
    return { status: "ready", service: "pi-science-server", control_plane: "node", scientific_runtime: runtime };
  });

  if (config.nodeSessions || config.nodePiManager) registerSessionReadRoutes(app);
  if (config.nodeSse || config.nodePiManager) registerSseRoutes(app, config);
  if (config.nodeFiles) registerFileReadRoutes(app);
  if (config.nodePiManager) registerNodeSessionRoutes(app);
  if (config.nodeJobs !== false) registerJobRoutes(app);
  if (config.nodeArtifacts !== false) registerArtifactRoutes(app);
  if (config.nodeSettings !== false) registerSettingsRoutes(app);
  if (config.nodeRuns !== false) registerRunEndpointRoutes(app);
  if (config.nodeCatalog !== false) registerCatalogRoutes(app);
  if (config.nodeProject !== false) registerProjectRoutes(app);
  if (config.nodePiManager) app.addHook("onClose", async () => nodeSessionService.shutdownAll());
  if (config.nodePiManager) {
    app.all("/api/sessions/*", async (request, reply) => reply.code(404).send({
      ok: false,
      code: "not_found",
      error: `Unknown Node conversation route: ${request.method} ${request.url.split("?")[0]}`,
    }));
  }

  const proxyOptions = {
    upstream: config.pythonOrigin,
    rewritePrefix: "/api",
    http2: false as const,
    http: { requestOptions: { timeout: config.upstreamTimeoutMs } },
    replyOptions: {
      rewriteRequestHeaders: (request: { id: string }, headers: Record<string, unknown>) => ({
        ...headers,
        "x-request-id": request.id,
        ...(config.internalToken ? { "x-pi-science-internal-token": config.internalToken } : {}),
      }),
      rewriteHeaders: (headers: Record<string, unknown>) => ({
        ...headers,
        "x-pi-science-upstream": "python",
      }),
      onError: (reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }) => {
        reply.code(504).send({ error: "scientific runtime unavailable" });
      },
    },
  };

  void app.register(proxy, { ...proxyOptions, prefix: "/api" });
  void app.register(proxy, {
    upstream: config.pythonOrigin,
    prefix: "/docs",
    rewritePrefix: "/docs",
    http2: false,
    http: { requestOptions: { timeout: config.upstreamTimeoutMs } },
    replyOptions: {
      rewriteRequestHeaders: (_request: unknown, headers: Record<string, unknown>) => ({
        ...headers,
        ...(config.internalToken ? { "x-pi-science-internal-token": config.internalToken } : {}),
      }),
    },
  });
  void app.register(proxy, {
    upstream: config.pythonOrigin,
    prefix: "/openapi.json",
    rewritePrefix: "/openapi.json",
    http2: false,
    http: { requestOptions: { timeout: config.upstreamTimeoutMs } },
    replyOptions: {
      rewriteRequestHeaders: (_request: unknown, headers: Record<string, unknown>) => ({
        ...headers,
        ...(config.internalToken ? { "x-pi-science-internal-token": config.internalToken } : {}),
      }),
    },
  });

  return app;
}

async function readRuntimeHealth(config: ServerConfig) {
  try {
    const response = await fetch(`${config.pythonOrigin}/api/health`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`scientific runtime returned ${response.status}`);
    return scientificRuntimeHealthSchema.parse(await response.json());
  } catch {
    // Health endpoints are expected to be safe during startup and shutdown.
    return null;
  }
}
