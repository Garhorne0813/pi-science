import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { gatewayHealthSchema } from "@pi-science/contracts";
import type { ServerConfig } from "../config/config.js";
import { routeBoundary, runtimeOwner } from "../http/runtime-boundaries.js";
import { registerSessionReadRoutes } from "../http/routes/session-routes.js";
import { registerSseRoutes } from "../http/routes/sse-routes.js";
import { registerFileReadRoutes } from "../http/routes/file-routes.js";
import { registerNodeSessionRoutes } from "../http/routes/node-session-routes.js";
import { registerJobRoutes } from "../http/routes/job-routes.js";
import { registerArtifactRoutes } from "../http/routes/artifact-routes.js";
import { registerTurnArtifactRoutes } from "../http/routes/turn-artifact-routes.js";
import { registerSettingsRoutes } from "../http/routes/settings-routes.js";
import { registerExecutionRoutes } from "../http/routes/execution-routes.js";
import { registerKernelExecutionRoutes } from "../http/routes/kernel-execution-routes.js";
import { knownWorkspacePaths, registerCatalogRoutes } from "../http/routes/catalog-routes.js";
import { registerProjectRoutes } from "../http/routes/project-routes.js";
import { registerLiteratureRoutes } from "../http/routes/literature-routes.js";
import { createServerModules, type ServerModules } from "./server-modules.js";
import { registerEnvironmentRoutes } from "../http/routes/environment-routes.js";
import { serveFrontend } from "../http/frontend-static.js";
import { validateWorkspaceCwd } from "../security/workspace-security.js";
import { AiTitleService, PiTitleRuntimeFactory } from "../runtime/title/ai-title-service.js";

export function buildApp(config: ServerConfig, modules: ServerModules = createServerModules(config)): FastifyInstance {
  const { sessions: nodeSessionService, events, sessionRepository, piManager, settings, jobs, research, projectReview, scientificRuntime, environments } = modules;
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxBodyBytes,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"]?.toString() || randomUUID(),
  });

  nodeSessionService.configureLogging((level, message) => app.log[level](message));
  events.configureLogging((level, message) => app.log[level](message));

  void app.register(cors, { credentials: true, origin: config.corsOrigins });

  const runtimeReleases = new WeakMap<object, () => void>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const pathname = request.url.split("?")[0] ?? request.url;
    const boundary = routeBoundary(pathname);
    if (request.url.startsWith("/api/") && !boundary) {
      return reply.code(404).send({ error: `Unknown API route: ${request.method} ${pathname}` });
    }
    const needsScientificRuntime = boundary?.owner === "python-scientific-runtime"
      || pathname === "/docs"
      || pathname.startsWith("/docs/")
      || pathname === "/openapi.json";
    const needsWorkspaceEnvironment = request.method === "POST" && (
      pathname === "/api/kernels/execute"
      || pathname === "/api/kernels/execute-stream"
      || pathname === "/api/notebooks/jupyter/start"
    );
    if (needsWorkspaceEnvironment) {
      const cwdValue = new URL(request.url, "http://127.0.0.1").searchParams.get("cwd") ?? ".";
      let cwd: string;
      try { cwd = await validateWorkspaceCwd(cwdValue); }
      catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
      try { await environments.ensure(cwd); }
      catch (error) {
        app.log.error({ err: error, requestId: request.id, cwd }, "workspace environment provisioning failed");
        return reply.code(500).send({ error: error instanceof Error ? error.message : String(error), request_id: request.id });
      }
    }
    if (needsScientificRuntime) {
      try {
        runtimeReleases.set(request, await scientificRuntime.acquire());
      } catch (error) {
        app.log.error({ err: error, requestId: request.id, path: request.url }, "scientific worker startup failed");
        return reply.code(503).send({ error: "scientific worker unavailable", request_id: request.id });
      }
    }
  });

  const releaseRuntime = (request: object) => {
    runtimeReleases.get(request)?.();
    runtimeReleases.delete(request);
  };
  app.addHook("onResponse", async (request) => releaseRuntime(request));
  app.addHook("onError", async (request) => releaseRuntime(request));

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

  app.get("/api/health", async () => {
    const runtime = scientificRuntime.snapshot();
    return gatewayHealthSchema.parse({
      status: "ok",
      active_pi_processes: nodeSessionService.processCount,
      active_kernels: 0,
      service: "pi-science-server",
      control_plane: "node",
      scientific_runtime: runtime.state,
    });
  });

  app.get("/internal/ready", async () => {
    return { status: "ready", service: "pi-science-server", control_plane: "node", scientific_runtime: scientificRuntime.snapshot() };
  });

  if (config.nodeSessions || config.nodePiManager) registerSessionReadRoutes(app, sessionRepository, nodeSessionService);
  if (config.nodeSse || config.nodePiManager) registerSseRoutes(app, nodeSessionService, events);
  if (config.nodeFiles) registerFileReadRoutes(app);
  if (config.nodePiManager) registerNodeSessionRoutes(app, nodeSessionService, sessionRepository, new AiTitleService(new PiTitleRuntimeFactory(piManager)));
  if (config.nodeJobs !== false) registerJobRoutes(app, jobs);
  registerEnvironmentRoutes(app, environments);
  if (config.nodeArtifacts !== false) registerArtifactRoutes(app);
  if (config.nodeArtifacts !== false) registerTurnArtifactRoutes(app);
  if (config.nodeSettings !== false) registerSettingsRoutes(app, nodeSessionService, settings);
  if (config.nodeExecutions !== false) registerExecutionRoutes(app, jobs);
  if (config.nodeExecutions !== false) registerKernelExecutionRoutes(app, config, environments);
  if (config.nodeCatalog !== false) registerCatalogRoutes(app, jobs, research);
  if (config.nodeProject !== false) registerProjectRoutes(app, research, projectReview);
  if (config.nodeLiterature !== false) registerLiteratureRoutes(app);
  app.addHook("onReady", async () => {
    const results = await Promise.allSettled((await knownWorkspacePaths()).map((cwd) => research.reconcile(cwd)));
    for (const result of results) if (result.status === "rejected") app.log.error({ err: result.reason }, "research loop recovery failed");
  });
  if (config.nodePiManager) app.addHook("onClose", async () => nodeSessionService.shutdownAll());
  // Unconditional: research/review subagent runtimes use the same shared
  // manager, so the host must be torn down even when nodePiManager is off.
  // The second call is a no-op when the first already ran (maps are cleared).
  app.addHook("onClose", async () => piManager.shutdownAll());
  app.addHook("onClose", async () => scientificRuntime.shutdown());
  app.addHook("onClose", async () => research.shutdown());
  app.addHook("onClose", async () => projectReview.shutdown());
  if (config.nodePiManager) {
    app.all("/api/sessions/*", async (request, reply) => reply.code(404).send({
      ok: false,
      code: "not_found",
      error: `Unknown Node conversation route: ${request.method} ${request.url.split("?")[0]}`,
    }));
  }

  const answeredProxyErrors = new WeakSet<object>();
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
      // A refused upstream connection makes @fastify/http-proxy invoke onError
      // twice for the same reply. Both calls land in the same tick, so
      // headersSent is still false on the second one; letting it through queues
      // a second send whose onSend chain throws ERR_HTTP_HEADERS_SENT
      // asynchronously — an uncaught exception that takes the process down.
      onError: (reply: object & { code: (statusCode: number) => { send: (body: unknown) => unknown } }) => {
        if (answeredProxyErrors.has(reply)) return;
        answeredProxyErrors.add(reply);
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

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/") || request.url.startsWith("/docs") || request.url.startsWith("/openapi.json")) {
      return reply.code(404).send({ error: `Route ${request.method} ${request.url} not found` });
    }
    const served = await serveFrontend(new URL(request.url, "http://localhost").pathname);
    if ("error" in served) return reply.code(404).send({ error: served.error });
    return reply.type(served.type).send(served.stream);
  });

  return app;
}
