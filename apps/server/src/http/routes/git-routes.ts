import type { FastifyInstance } from "fastify";
import { inspectGitWorkspace } from "../../git/git-workspace-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

export function registerGitRoutes(app: FastifyInstance): void {
  app.get("/api/git/status", async (request, reply) => {
    const query = request.query as { cwd?: string };
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query.cwd ?? "."); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    try { return await inspectGitWorkspace(cwd); }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
