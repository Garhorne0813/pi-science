import type { FastifyInstance } from "fastify";
import { conversationBookmarkCreateSchema, conversationBookmarkUpdateSchema, conversationReadStateUpdateSchema } from "@pi-science/contracts";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { ConversationNavigationRepository, NavigationError } from "../../conversation-navigation/repository.js";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";

function queryCwd(request: { query: unknown }): string {
  const query = request.query as { cwd?: unknown };
  return typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
}

function queryString(request: { query: unknown }, key: string): string | null {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function navigationErrorCode(error: NavigationError): number {
  switch (error.code) {
    case "not_found": return 404;
    case "invalid_anchor": return 422;
    case "limit": return 422;
    case "corrupt":
    case "unsupported": return 500;
    default: return 500;
  }
}

/** Keyword heuristic used by the legacy bookmark generator. Proposals only —
 *  nothing produced here is auto-accepted. */
function proposeCandidates(messages: Array<{ id: string; content: Array<{ type?: string; text?: string }> }>): string[] {
  return messages
    .filter((message) => message.content.some((part) => typeof part.text === "string" && /\b(result|conclusion|finding|decision|saved|created|verified|completed|结果|结论|决定|已保存|已生成)\b/i.test(part.text)))
    .slice(-2)
    .map((message) => message.id);
}

export function registerConversationNavigationRoutes(
  app: FastifyInstance,
  navigation: ConversationNavigationRepository,
  sessionRepository: SessionRepository,
  nodeSessionService: NodeSessionService,
  events: ConversationEventHub,
): void {
  const ws = async (request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> => {
    try { return await validateWorkspaceCwd(queryCwd(request)); }
    catch (error) { reply.code(403).send({ error: String(error) }); return null; }
  };
  const sessionExists = async (root: string, sessionId: string): Promise<boolean> => (await sessionRepository.findPath(root, sessionId)) !== null;

  app.get("/api/bookmarks", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const sessionId = queryString(request, "session_id");
    if (sessionId && !(await sessionExists(root, sessionId))) return reply.code(404).send({ error: "session not found in this workspace" });
    try {
      return await navigation.bookmarks(root, sessionId ?? undefined);
    } catch (error) {
      // Fail closed with the same {error} shape as the mutation routes.
      if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
      throw error;
    }
  });

  // POST /api/bookmarks?cwd&session_id — compatibility with the legacy
  // query-only call: without a manual bookmark body this generates agent
  // proposals (status "proposed"); nothing is auto-accepted anymore.
  app.post("/api/bookmarks", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const sessionId = queryString(request, "session_id");
    if (!sessionId) return reply.code(400).send({ error: "session_id is required" });
    if (!(await sessionExists(root, sessionId))) return reply.code(404).send({ error: "session not found in this workspace" });
    const body = (request.body ?? {}) as { message_id?: unknown; label?: unknown };
    if (typeof body.message_id === "string" && body.message_id) {
      const parsed = conversationBookmarkCreateSchema.safeParse({ session_id: sessionId, message_id: body.message_id, label: typeof body.label === "string" ? body.label : undefined });
      if (!parsed.success) return reply.code(400).send({ error: "invalid bookmark request" });
      try {
        const bookmark = await navigation.createBookmark(root, parsed.data);
        return { bookmark };
      } catch (error) {
        if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
        throw error;
      }
    }
    return proposeHeuristic(reply, root, sessionId, navigation, sessionRepository);
  });

  app.post("/api/bookmarks/propose", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const sessionId = queryString(request, "session_id");
    if (!sessionId) return reply.code(400).send({ error: "session_id is required" });
    if (!(await sessionExists(root, sessionId))) return reply.code(404).send({ error: "session not found in this workspace" });
    return proposeHeuristic(reply, root, sessionId, navigation, sessionRepository);
  });

  app.patch<{ Params: { bookmark_id: string } }>("/api/bookmarks/:bookmark_id", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const parsed = conversationBookmarkUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "status must be accepted or rejected" });
    try {
      const bookmark = await navigation.updateBookmarkStatus(root, request.params.bookmark_id, parsed.data.status);
      return { bookmark };
    } catch (error) {
      if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
      throw error;
    }
  });

  app.delete<{ Params: { bookmark_id: string } }>("/api/bookmarks/:bookmark_id", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    try {
      await navigation.deleteBookmark(root, request.params.bookmark_id);
      return { ok: true };
    } catch (error) {
      if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/read-state", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const sessionId = request.params.session_id;
    if (!(await sessionExists(root, sessionId))) return reply.code(404).send({ error: "session not found in this workspace" });
    let read;
    try {
      read = await navigation.readState(root, sessionId);
    } catch (error) {
      if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
      throw error;
    }
    if (!read) {
      return { session_id: sessionId, anchor_message_id: null, at_bottom: false, seen_snapshot_version: null, updated_at: null, anchor_available: false, before: null };
    }
    const locator = read.anchor_message_id ? await sessionRepository.messageLocator(root, sessionId, read.anchor_message_id) : null;
    return { ...read, anchor_available: locator !== null, before: locator?.before ?? null };
  });

  app.put<{ Params: { session_id: string } }>("/api/sessions/:session_id/read-state", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const sessionId = request.params.session_id;
    if (!(await sessionExists(root, sessionId))) return reply.code(404).send({ error: "session not found in this workspace" });
    const parsed = conversationReadStateUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid read-state update" });
    try {
      const read = await navigation.updateReadState(root, sessionId, parsed.data);
      const locator = read.anchor_message_id ? await sessionRepository.messageLocator(root, sessionId, read.anchor_message_id) : null;
      return { ...read, anchor_available: locator !== null, before: locator?.before ?? null };
    } catch (error) {
      if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/attention", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const limitRaw = Number(queryString(request, "limit") ?? "30");
    const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 30;
    const sessions = await sessionRepository.list(root);
    const live = nodeSessionService.liveSessions(root);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const runtime of live) if (!byId.has(runtime.id)) byId.set(runtime.id, { id: runtime.id, cwd: root, project_id: null, name: null, created_at: null, updated_at: new Date().toISOString() });
    const busy = new Set(nodeSessionService.busySessionIds(root));
    const items: Array<{ session_id: string; status: "needs_you" | "running" | "unread" | "idle"; updated_at: string | null }> = [];
    try {
      for (const session of byId.values()) {
        let status: "needs_you" | "running" | "unread" | "idle" = "idle";
        if (events.hasPendingInteraction(root, session.id)) status = "needs_you";
        else if (busy.has(session.id)) status = "running";
        else {
          const read = await navigation.readState(root, session.id);
          if (read) {
            const latest = await sessionRepository.latestVisibleMessage(root, session.id);
            // Unread semantics are deliberately coarse for this milestone: the
            // snapshot version is the session file's size:mtime, so ANY append
            // (even a user message) changes it. Requiring the latest visible
            // message to be an assistant reply avoids flagging sessions where
            // only the user typed. A pending assistant reply (or a user turn
            // that has not been answered yet) may still surface as unread,
            // which is acceptable for a sidebar hint until per-message read
            // cursors land.
            if (latest.role === "assistant" && read.seen_snapshot_version !== latest.snapshot_version) status = "unread";
          }
        }
        items.push({ session_id: session.id, status, updated_at: session.updated_at });
      }
    } catch (error) {
      if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
      throw error;
    }
    const priority: Record<string, number> = { needs_you: 0, running: 1, unread: 2, idle: 3 };
    items.sort((left, right) => {
      const byPriority = priority[left.status]! - priority[right.status]!;
      if (byPriority !== 0) return byPriority;
      return String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
    });
    const truncated = items.length > limit;
    const top = items.slice(0, limit);
    const counts = {
      needs_you: items.filter((item) => item.status === "needs_you").length,
      running: items.filter((item) => item.status === "running").length,
      unread: items.filter((item) => item.status === "unread").length,
    };
    return { items: top, counts, truncated };
  });
}

async function proposeHeuristic(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  root: string,
  sessionId: string,
  navigation: ConversationNavigationRepository,
  sessionRepository: SessionRepository,
) {
  const messages = await sessionRepository.messages(root, sessionId);
  const candidates = proposeCandidates(messages);
  try {
    const { bookmarks, skipped } = await navigation.proposeBookmarks(root, sessionId, candidates);
    return { session_id: sessionId, bookmarks, skipped };
  } catch (error) {
    if (error instanceof NavigationError) return reply.code(navigationErrorCode(error)).send({ error: error.message });
    throw error;
  }
}
