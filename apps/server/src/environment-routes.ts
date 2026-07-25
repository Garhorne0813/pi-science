import type { FastifyInstance } from "fastify";
import type { WorkspaceEnvironmentService } from "./workspace-environment.js";
import { validateWorkspaceCwd } from "./workspace-security.js";

async function workspace(request: { query: unknown }): Promise<string> {
  const value = (request.query as { cwd?: unknown }).cwd;
  return validateWorkspaceCwd(typeof value === "string" ? value : "");
}

export function registerEnvironmentRoutes(app: FastifyInstance, environments: WorkspaceEnvironmentService): void {
  app.get("/api/environments/workspace", async (request, reply) => {
    try { return await environments.status(await workspace(request)); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
  });
  app.post("/api/environments/workspace", async (request, reply) => {
    let cwd: string;
    try { cwd = await workspace(request); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    try { return await environments.ensure(cwd); }
    catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}

