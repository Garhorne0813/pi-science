import type { FastifyInstance } from "fastify";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import type { SessionTitleRepository } from "../../runtime/node/session-titles.js";
import { sessionTitleRepository } from "../../runtime/node/session-titles.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { ensureProject } from "../../project/project-registry.js";
import { responseVersionRepository } from "../../runtime/node/response-version-repository.js";

function queryCwd(request: { query: unknown }): string {
  const query = request.query as { cwd?: unknown };
  return typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
}

const SESSION_LIST_DEFAULT_LIMIT = 30;
const SESSION_LIST_MAX_LIMIT = 100;

function encodeSessionListCursor(session: { id: string; updated_at: string | null }): string {
  return Buffer.from(JSON.stringify({ v: 1, u: session.updated_at ?? "", i: session.id })).toString("base64url");
}

function decodeSessionListCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; u?: unknown; i?: unknown };
    if (value.v !== 1 || typeof value.u !== "string" || typeof value.i !== "string" || !value.i) throw new Error();
    return { updatedAt: value.u, id: value.i };
  } catch {
    throw new Error("invalid session list cursor");
  }
}

export function registerSessionReadRoutes(app: FastifyInstance, sessionRepository: SessionRepository, nodeSessionService: NodeSessionService, titles: SessionTitleRepository = sessionTitleRepository): void {
  app.get("/api/sessions", async (request, reply) => {
    try {
      const query = request.query as { cursor?: unknown; limit?: unknown };
      const paginated = query.cursor !== undefined || query.limit !== undefined;
      const limit = query.limit === undefined ? SESSION_LIST_DEFAULT_LIMIT : Number(query.limit);
      if (paginated && (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_LIST_MAX_LIMIT)) {
        return reply.code(400).send({ error: `session list limit must be between 1 and ${SESSION_LIST_MAX_LIMIT}` });
      }
      const cwd = await validateWorkspaceCwd(queryCwd(request));
      const project = await ensureProject(cwd);
      const sessions = await sessionRepository.list(cwd);
      // Regenerated responses live in hidden fork sessions. Surface their
      // latest activity on the canonical (first-version) sidebar row so a
      // resend updates both its relative time and chronological position.
      const versionGroups = await responseVersionRepository.list(cwd);
      for (const group of versionGroups) {
        const canonicalSessionId = group.versions[0]?.sessionId;
        const canonical = sessions.find((session) => session.id === canonicalSessionId);
        if (canonical && group.updatedAt && group.updatedAt > (canonical.updated_at ?? "")) {
          canonical.updated_at = group.updatedAt;
        }
      }
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
      sessions.sort((left, right) => (
        (right.updated_at ?? "").localeCompare(left.updated_at ?? "") || right.id.localeCompare(left.id)
      ));
      if (!paginated) return sessions;

      // Repository order is newest-first. Use a keyset cursor rather than an
      // array offset so inserts at the head cannot skip or duplicate rows.
      let pageCandidates = sessions;
      if (query.cursor !== undefined) {
        if (typeof query.cursor !== "string" || !query.cursor) return reply.code(400).send({ error: "invalid session list cursor" });
        const cursor = decodeSessionListCursor(query.cursor);
        pageCandidates = sessions.filter((session) => {
          const updatedAt = session.updated_at ?? "";
          return updatedAt < cursor.updatedAt || (updatedAt === cursor.updatedAt && session.id < cursor.id);
        });
      }
      const page = pageCandidates.slice(0, limit);
      const hasMore = pageCandidates.length > page.length;
      return {
        sessions: page,
        next_cursor: hasMore && page.length > 0 ? encodeSessionListCursor(page[page.length - 1]!) : null,
        has_more: hasMore,
      };
    } catch (error) {
      if (String(error).includes("session list cursor")) return reply.code(400).send({ error: String(error) });
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
      return await sessionRepository.userMessageIndex(cwd, request.params.session_id);
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
  });
}
