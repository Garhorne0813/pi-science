import type { FastifyInstance } from "fastify";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import type { SessionTitleRepository } from "../../runtime/node/session-titles.js";
import { sessionTitleRepository } from "../../runtime/node/session-titles.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { ensureProject } from "../../project/project-registry.js";

function queryCwd(request: { query: unknown }): string {
  const query = request.query as { cwd?: unknown };
  return typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
}

export function registerSessionReadRoutes(app: FastifyInstance, sessionRepository: SessionRepository, nodeSessionService: NodeSessionService, titles: SessionTitleRepository = sessionTitleRepository): void {
  app.get("/api/sessions", async (request, reply) => {
    try {
      const cwd = await validateWorkspaceCwd(queryCwd(request));
      const project = await ensureProject(cwd);
      const sessions = await sessionRepository.list(cwd);
      const live = nodeSessionService.liveSessions(cwd);
      for (const runtime of live.reverse()) {
        if (!sessions.some((session) => session.id === runtime.id)) {
          // A persisted session that is absent from the repository's
          // user-facing list was deliberately classified as internal (for
          // example a legacy AI-title runtime). Directly resuming such a file
          // can make it live, but must not bypass that visibility decision.
          // A genuinely new live session has no file yet and is still added.
          if (await sessionRepository.findPath(cwd, runtime.id)) continue;
          sessions.unshift({ id: runtime.id, cwd, project_id: project.id, name: null, created_at: null, updated_at: new Date().toISOString() });
        }
      }
      const titleById = await titles.getTitles(cwd);
      for (const session of sessions) {
        const title = titleById.get(session.id);
        if (title) (session as { name: string | null }).name = title;
      }
      return sessions;
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/messages", async (request, reply) => {
    try {
      const query = request.query as { cwd?: unknown; before?: unknown; limit?: unknown };
      const before = query.before === undefined ? undefined : String(query.before);
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (
        (query.before !== undefined && (!before || before === "undefined"))
        || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
      ) {
        return reply.code(400).send({ error: "invalid history pagination parameters" });
      }
      return await sessionRepository.messagesPage(
        await validateWorkspaceCwd(queryCwd(request)),
        request.params.session_id,
        { before, limit },
      );
    } catch (error) {
      if (String(error).includes("history cursor") || String(error).includes("history limit")) {
        return reply.code(400).send({ error: String(error) });
      }
      return reply.code(403).send({ error: String(error) });
    }
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/messages/index", async (request, reply) => {
    try {
      const cwd = await validateWorkspaceCwd(queryCwd(request));
      const query = request.query as { roles?: unknown };
      const roles = query.roles === undefined ? "user" : query.roles === "all" ? "all" : null;
      if (roles === null) return reply.code(400).send({ error: "roles must be omitted or 'all'" });
      return await sessionRepository.messageIndex(cwd, request.params.session_id, roles);
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
  });
}
