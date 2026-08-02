import type { FastifyInstance } from "fastify";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { ensureProject } from "../../project/project-registry.js";

function queryCwd(request: { query: unknown }): string {
  const query = request.query as { cwd?: unknown };
  return typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
}

export function registerSessionReadRoutes(app: FastifyInstance, sessionRepository: SessionRepository, nodeSessionService: NodeSessionService): void {
  app.get("/api/sessions", async (request, reply) => {
    try {
      const cwd = await validateWorkspaceCwd(queryCwd(request));
      const project = await ensureProject(cwd);
      const sessions = await sessionRepository.list(cwd);
      const live = nodeSessionService.liveSessions(cwd);
      for (const runtime of live.reverse()) {
        if (!sessions.some((session) => session.id === runtime.id)) {
          sessions.unshift({ id: runtime.id, cwd, project_id: project.id, name: null, created_at: null, updated_at: new Date().toISOString() });
        }
      }
      return sessions;
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/messages", async (request, reply) => {
    try {
      return { messages: await sessionRepository.messages(await validateWorkspaceCwd(queryCwd(request)), request.params.session_id) };
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
  });
}
