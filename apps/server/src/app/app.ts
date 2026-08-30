import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
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
import { registerModelEndpointRoutes } from "../http/routes/model-endpoint-routes.js";
import { registerModelResourceRoutes } from "../http/routes/model-resource-routes.js";
import { registerExecutionRoutes } from "../http/routes/execution-routes.js";
import { registerKernelExecutionRoutes } from "../http/routes/kernel-execution-routes.js";
import { registerNotebookRoutes } from "../http/routes/notebook-routes.js";
import { knownWorkspacePaths, registerCatalogRoutes, rootDir } from "../http/routes/catalog-routes.js";
import { registerProjectRoutes } from "../http/routes/project-routes.js";
import { registerLiteratureRoutes } from "../http/routes/literature-routes.js";
import { registerScheduledTaskRoutes, scheduledTasksDiagnostics } from "../http/routes/scheduled-task-routes.js";
import { isScheduledTasksEnabled } from "../scheduled-tasks/service.js";
import { createServerModules, type ServerModules } from "./server-modules.js";
import { registerEnvironmentRoutes } from "../http/routes/environment-routes.js";
import { serveFrontend } from "../http/frontend-static.js";
import { validateWorkspaceCwd } from "../security/workspace-security.js";
import { AiTitleService, PiTitleRuntimeFactory } from "../runtime/title/ai-title-service.js";
import { importLegacyState } from "../storage/sqlite/legacy-state.js";
import { internalAuthCookie, requestInternalToken, tokensMatch } from "../security/internal-auth.js";

export function buildApp(config: ServerConfig, modules: ServerModules = createServerModules(config)): FastifyInstance {
  const { sessions: nodeSessionService, events, sessionRepository, piManager, settings, modelResources, jobs, research, projectReview, literature, environments, kernels, notebooks, stateStore, workspaces, environmentRepository, jobRepository, sqliteEnabled, scheduled } = modules;
  let stateReady = !sqliteEnabled;
  let stateError: unknown;
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxBodyBytes,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"]?.toString() || randomUUID(),
  });

  nodeSessionService.configureLogging((level, message) => app.log[level](message));
  events.configureLogging((level, message) => app.log[level](message));

  void app.register(cors, { credentials: true, origin: config.corsOrigins });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const pathname = request.url.split("?")[0] ?? request.url;
    const authEnabled = config.requireInternalToken !== false && Boolean(config.internalToken);
    // CORS preflight must be answered before the application-token check; the
    // actual request still has to carry the token or the HttpOnly cookie.
    if (authEnabled && request.method !== "OPTIONS" && (pathname.startsWith("/api/") || pathname === "/internal/diagnostics")) {
      if (!tokensMatch(config.internalToken!, requestInternalToken(request.headers))) {
        return reply.code(401).send({ error: "control-plane authentication required" });
      }
    }
    const boundary = routeBoundary(pathname);
    if (request.url.startsWith("/api/") && !boundary) {
      return reply.code(404).send({ error: `Unknown API route: ${request.method} ${pathname}` });
    }
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
      error: statusCode === 413 ? "request body too large" : statusCode === 429 ? "rate limit exceeded" : "internal server error",
      request_id: request.id,
    });
  });

  app.get("/internal/live", async () => ({
    status: "ok",
    service: "pi-science-server",
    control_plane: "node",
  }));

  app.get("/api/health", async () => gatewayHealthSchema.parse({
    status: "ok",
    active_pi_processes: nodeSessionService.processCount,
    active_kernels: kernels.status().active_count,
    service: "pi-science-server",
    control_plane: "node",
  }));

  app.get("/internal/ready", async (_request, reply) => {
    const diagnostics = stateStore.diagnostics();
    if (sqliteEnabled && (!stateReady || diagnostics.status !== "ready")) {
      return reply.code(503).send({ status: "not_ready", service: "pi-science-server", control_plane: "node", sqlite: { ...diagnostics, error: diagnostics.error ?? (stateError instanceof Error ? stateError.message : String(stateError ?? "SQLite state store is not ready")) } });
    }
    return { status: "ready", service: "pi-science-server", control_plane: "node", sqlite: sqliteEnabled ? diagnostics : { status: "disabled", schema_version: null, journal_mode: null, pending_requests: 0 } };
  });

  app.get("/internal/diagnostics", async () => {
    const modelState = await modelResources.repository.read();
    return {
      sqlite: sqliteEnabled ? stateStore.diagnostics() : { status: "disabled" },
      model_resources: {
        schema_version: modelState.schema_version,
        migration: modelState.migration ?? null,
        provider_count: modelState.providers.length,
        model_count: modelState.models.length,
        endpoint_count: modelState.endpoints.length,
        binding_count: modelState.bindings.length,
        credential_ref_count: Object.keys(modelState.credential_refs).length,
      },
      // docs §11.7 scheduled_tasks block (aggregated scheduler/dispatcher/service slices).
      scheduled_tasks: await scheduledTasksDiagnostics({ service: scheduled.service, sqliteEnabled, stateStore }),
    };
  });

  if (config.nodeSessions || config.nodePiManager) registerSessionReadRoutes(app, sessionRepository, nodeSessionService);
  if (config.nodeSse || config.nodePiManager) registerSseRoutes(app, nodeSessionService, events);
  if (config.nodeFiles) registerFileReadRoutes(app);
  if (config.nodePiManager) registerNodeSessionRoutes(app, nodeSessionService, sessionRepository, new AiTitleService(new PiTitleRuntimeFactory(piManager)));
  if (config.nodeJobs !== false) {
    // Keep command execution rate-limited without throttling read-only control
    // plane routes. The child scope ensures the plugin's onRoute hook sees the
    // job routes registered below while remaining isolated from the rest of
    // the application.
    void app.register(async (jobScope) => {
      await jobScope.register(rateLimit, { global: false });
      registerJobRoutes(jobScope, jobs);
    });
  }
  registerEnvironmentRoutes(app, environments);
  if (config.nodeArtifacts !== false) registerArtifactRoutes(app);
  if (config.nodeArtifacts !== false) registerTurnArtifactRoutes(app);
  if (config.nodeSettings !== false) registerSettingsRoutes(app, nodeSessionService, settings, modelResources);
  if (config.nodeSettings !== false) {
    registerModelResourceRoutes(app, modelResources, nodeSessionService);
    registerModelEndpointRoutes(app, { service: modelResources, nodeSessionService });
  }
  if (config.nodeExecutions !== false) registerExecutionRoutes(app, jobs);
  if (config.nodeExecutions !== false) registerKernelExecutionRoutes(app, config, environments, kernels);
  registerNotebookRoutes(app, notebooks);
  if (config.nodeCatalog !== false) registerCatalogRoutes(app, jobs, research, sqliteEnabled ? workspaces : undefined);
  if (config.nodeProject !== false) registerProjectRoutes(app, research, projectReview);
  if (config.nodeLiterature !== false) registerLiteratureRoutes(app, literature);
  registerScheduledTaskRoutes(app, {
    service: scheduled.service,
    workspacesResolver: async (cwd) => validateWorkspaceCwd(cwd),
    sqliteEnabled,
    stateStore,
    onMutation: () => scheduled.scheduler?.wake(),
  });
  app.addHook("onReady", async () => {
    if (sqliteEnabled) {
      try {
        await stateStore.start();
        await importLegacyState({ store: stateStore, workspaces, environments: environmentRepository, jobs: jobRepository, managedRoot: rootDir(), logger: (message, details) => app.log.info({ ...details }, message) });
        stateReady = true;
      } catch (error) {
        stateError = error;
        app.log.error({ err: error }, "SQLite state initialization failed");
      }
      // docs §11.2 step 5: after durable state is up, recover leases → dispatch
      // pending attempts → claim due occurrences → arm the nearest timer.
      // A scheduler failure degrades diagnostics only — never the whole app.
      if (stateReady && scheduled.scheduler && isScheduledTasksEnabled()) {
        try {
          scheduled.scheduler.start();
          await scheduled.scheduler.startupOnce();
        } catch (error) {
          app.log.error({ err: error }, "scheduled tasks startup failed");
        }
      }
    }
    const recoveryRepository = sqliteEnabled && stateReady ? workspaces : undefined;
    const results = await Promise.allSettled((await knownWorkspacePaths(recoveryRepository)).map((cwd) => research.reconcile(cwd)));
    for (const result of results) if (result.status === "rejected") app.log.error({ err: result.reason }, "research loop recovery failed");
  });
  // docs §11.5 shutdown orchestration. Fastify executes onClose hooks in
  // reverse registration order (verified empirically), so the desired runtime
  // order — scheduled runtimes settled first, SQLite closed LAST — is encoded
  // by registering the store hook FIRST and the scheduled hook LAST.
  app.addHook("onClose", async () => stateStore.close());
  if (config.nodePiManager) app.addHook("onClose", async () => nodeSessionService.shutdownAll());
  // Unconditional: research/review subagent runtimes use the same shared
  // manager, so the host must be torn down even when nodePiManager is off.
  // The second call is a no-op when the first already ran (maps are cleared).
  app.addHook("onClose", async () => piManager.shutdownAll());
  app.addHook("onClose", async () => research.shutdown());
  app.addHook("onClose", async () => projectReview.shutdown());
  app.addHook("onClose", async () => kernels.shutdownAll());
  app.addHook("onClose", async () => notebooks.shutdown());
  // Registered last ⇒ runs first: stop claiming occurrences, then abort and
  // owner-fence every in-flight attempt before any runtime/store teardown.
  app.addHook("onClose", async () => {
    await scheduled.scheduler?.stop();
    await scheduled.dispatcher?.shutdown();
  });
  if (config.nodePiManager) {
    app.all("/api/sessions/*", async (request, reply) => reply.code(404).send({
      ok: false,
      code: "not_found",
      error: `Unknown Node conversation route: ${request.method} ${request.url.split("?")[0]}`,
    }));
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/") || request.url.startsWith("/docs") || request.url.startsWith("/openapi.json")) {
      return reply.code(404).send({ error: `Route ${request.method} ${request.url} not found` });
    }
    const served = await serveFrontend(new URL(request.url, "http://localhost").pathname);
    if ("error" in served) return reply.code(404).send({ error: served.error });
    if (config.requireInternalToken !== false && config.internalToken && served.type.startsWith("text/html")) {
      reply.header("set-cookie", internalAuthCookie(config.internalToken));
    }
    return reply.type(served.type).send(served.stream);
  });

  return app;
}
