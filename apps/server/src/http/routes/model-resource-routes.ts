import type { FastifyInstance } from "fastify";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { nativeProviderViews } from "../../model-config/provider-config-view.js";
import { registerModelConfigRoutes } from "./model-config-routes.js";

/** Existing read DTO, sourced exclusively from the native registry. */
export function registerModelResourceRoutes(app: FastifyInstance, resources: ModelResourceService, sessions: NodeSessionService): void {
  registerModelConfigRoutes(app, resources, sessions);
  app.get("/api/provider-views", async (request, reply) => {
    const cwd = (request.query as { cwd?: unknown }).cwd;
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || !cwd) return reply.code(400).send({ code: "invalid_resource", error: "cwd must be a nonempty string" });
      try { await validateWorkspaceCwd(cwd); } catch { return reply.code(400).send({ code: "invalid_resource", error: "Invalid workspace" }); }
    }
    try { return { providers: await nativeProviderViews(), catalog_status: "ready" }; }
    catch { return reply.code(400).send({ code: "invalid_config", error: "Repair native model configuration" }); }
  });
}
