import { createSessionRequestSchema } from "@pi-science/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import type { SessionTitleRepository } from "../../runtime/node/session-titles.js";
import { sessionTitleRepository } from "../../runtime/node/session-titles.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { AiTitleService } from "../../runtime/title/ai-title-service.js";
import { responseVersionRepository } from "../../runtime/node/response-version-repository.js";

function cwd(request: { query: unknown }): string {
  const value = (request.query as { cwd?: unknown }).cwd;
  return typeof value === "string" && value ? value : ".";
}

function status(code: unknown): number {
  switch (String(code ?? "")) {
    case "workspace_invalid": return 403;
    case "not_found":
    case "runtime_not_found":
    case "session_mismatch": return 404;
    case "project_trust_required":
    case "runtime_workspace_mismatch":
    case "session_in_use":
    case "runtime_busy":
    case "pi_session_mismatch":
    case "busy":
    case "cancelled": return 409;
    case "runtime_evicted": return 410;
    case "runtime_initialization_failed": return 422;
    case "runtime_capacity_exceeded":
    case "agent_turn_capacity_exceeded": return 429;
    case "invalid_request": return 400;
    case "environment_failed": return 500;
    case "spawn_failed":
    case "process_closed":
    case "process_exit": return 503;
    case "timeout": return 504;
    default: return 502;
  }
}

function sendFailure(reply: FastifyReply, result: Record<string, unknown>) {
  return reply.code(status(result.code)).send({ ok: false, ...result });
}

interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

function replayImages(content: Array<Record<string, unknown>>): PromptImage[] {
  return content.flatMap((part) => {
    if (part.type !== "image" && part.type !== "input_image") return [];
    const source = part.source && typeof part.source === "object" ? part.source as Record<string, unknown> : {};
    const data = typeof part.data === "string" ? part.data : typeof source.data === "string" ? source.data : null;
    const mimeType = typeof part.mimeType === "string"
      ? part.mimeType
      : typeof part.mime === "string"
        ? part.mime
        : typeof source.media_type === "string"
          ? source.media_type
          : typeof source.mime_type === "string"
            ? source.mime_type
            : "image/png";
    return data ? [{ type: "image" as const, data, mimeType }] : [];
  });
}

export function registerNodeSessionRoutes(
  app: FastifyInstance,
  nodeSessionService: NodeSessionService,
  sessionRepository: SessionRepository,
  aiTitleService?: AiTitleService,
  titles: SessionTitleRepository = sessionTitleRepository,
): void {
  app.post("/api/sessions", async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid session request", code: "invalid_request" });
    const result = await nodeSessionService.create(parsed.data);
    if ("error" in result) return reply.code(status(result.code)).send({ ok: false, ...result });
    return result;
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/prompt", async (request, reply) => {
    const body = request.body as { message?: unknown };
    if (typeof body?.message !== "string" || !body.message) return reply.code(400).send({ ok: false, code: "invalid_request", error: "message is required" });
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "prompt", { message: body.message });
    return result.success ? { ok: true, id: request.params.session_id } : sendFailure(reply, result);
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/title", async (request, reply) => {
    if (!aiTitleService) return reply.code(404).send({ ok: false, code: "not_found", error: "ai titles are not available" });
    const sessionId = request.params.session_id;
    let workspace: string;
    try {
      workspace = await validateWorkspaceCwd(cwd(request));
    } catch (error) {
      return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) });
    }
    const exists = await sessionRepository.findPath(workspace, sessionId);
    if (!exists) return reply.code(404).send({ ok: false, code: "not_found", error: "session not found" });
    const title = await aiTitleService.generateTitle(workspace, sessionId);
    // Persist the generated title server-side so a lost client PUT (tab closed,
    // network drop) cannot lose it; null means no title was produced.
    if (title) await titles.setTitle(workspace, sessionId, title);
    return { ok: true, title };
  });

  app.put<{ Params: { session_id: string } }>("/api/sessions/:session_id/title", async (request, reply) => {
    const sessionId = request.params.session_id;
    const body = (request.body ?? {}) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return reply.code(400).send({ ok: false, code: "invalid_request", error: "title must be a non-empty string" });
    if (title.length > 100) return reply.code(400).send({ ok: false, code: "invalid_request", error: "title must be at most 100 characters" });
    let workspace: string;
    try {
      workspace = await validateWorkspaceCwd(cwd(request));
    } catch (error) {
      return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) });
    }
    // A brand-new session is live before its JSONL lands on disk (the file is
    // written when the first message arrives), so accept the derived-name PUT
    // for live sessions too; unknown sessions still 404, scoped per workspace.
    const exists = (await sessionRepository.findPath(workspace, sessionId)) !== null
      || nodeSessionService.liveSessions(workspace).some((session) => session.id === sessionId);
    if (!exists) return reply.code(404).send({ ok: false, code: "not_found", error: "session not found" });
    await titles.setTitle(workspace, sessionId, title);
    return { ok: true, title };
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/resume", async (request, reply) => {
    const result = await nodeSessionService.resume(request.params.session_id, cwd(request));
    return result.success ? { ok: true, id: request.params.session_id, cwd: cwd(request) } : sendFailure(reply, result as Record<string, unknown>);
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/fork", async (request, reply) => {
    const body = (request.body ?? {}) as { entry_id?: unknown };
    const result = await nodeSessionService.fork(request.params.session_id, cwd(request), typeof body.entry_id === "string" ? body.entry_id : undefined);
    return result.success && result.sessionId
      ? { ok: true, id: result.sessionId, cwd: cwd(request) }
      : sendFailure(reply, result);
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/regenerate", async (request, reply) => {
    const body = (request.body ?? {}) as { entry_id?: unknown; message?: unknown; source_user_message_id?: unknown };
    if (typeof body.entry_id !== "string" || !body.entry_id || typeof body.message !== "string" || typeof body.source_user_message_id !== "string" || !body.source_user_message_id) {
      return reply.code(400).send({ ok: false, code: "invalid_request", error: "entry_id, message, and source_user_message_id are required" });
    }
    let workspace: string;
    try { workspace = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    const sourceMessage = (await sessionRepository.messages(workspace, request.params.session_id))
      .find((message) => message.id === body.source_user_message_id && message.role === "user");
    if (!sourceMessage) return reply.code(404).send({ ok: false, code: "not_found", error: "source user message not found" });
    const images = replayImages(sourceMessage.content);
    if (!body.message.trim() && images.length === 0) {
      return reply.code(400).send({ ok: false, code: "invalid_request", error: "source user message has no replayable content" });
    }
    const forked = await nodeSessionService.fork(request.params.session_id, workspace, body.entry_id);
    if (!forked.success || !forked.sessionId) return sendFailure(reply, forked);
    const branch = await responseVersionRepository.append(workspace, {
      sourceSessionId: request.params.session_id,
      sourceUserMessageId: body.source_user_message_id,
      targetSessionId: forked.sessionId,
      forkEntryId: body.entry_id,
    });
    const prompted = await nodeSessionService.command(forked.sessionId, workspace, "prompt", { message: body.message, images });
    await responseVersionRepository.setStatus(workspace, branch.version.id, prompted.success ? "generating" : "failed");
    if (!prompted.success) return sendFailure(reply, { ...prompted, id: forked.sessionId, version_id: branch.version.id, group_id: branch.group.id });
    await responseVersionRepository.select(workspace, branch.version.id);
    return { ok: true, id: forked.sessionId, version_id: branch.version.id, group_id: branch.group.id, cwd: workspace };
  });

  app.get("/api/response-versions", async (request, reply) => {
    const query = request.query as { session_id?: unknown };
    let workspace: string;
    try { workspace = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    const sessionId = typeof query.session_id === "string" && query.session_id ? query.session_id : undefined;
    return { ok: true, groups: await responseVersionRepository.list(workspace, sessionId) };
  });

  app.put<{ Params: { version_id: string } }>("/api/response-versions/:version_id/message", async (request, reply) => {
    const body = (request.body ?? {}) as { user_message_id?: unknown };
    if (typeof body.user_message_id !== "string" || !body.user_message_id) return reply.code(400).send({ ok: false, code: "invalid_request", error: "user_message_id is required" });
    let workspace: string;
    try { workspace = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    const version = await responseVersionRepository.bind(workspace, request.params.version_id, body.user_message_id);
    return version ? { ok: true, version } : reply.code(404).send({ ok: false, code: "not_found", error: "response version not found" });
  });

  app.put<{ Params: { version_id: string } }>("/api/response-versions/:version_id/selected", async (request, reply) => {
    let workspace: string;
    try { workspace = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    const group = await responseVersionRepository.select(workspace, request.params.version_id);
    return group ? { ok: true, group } : reply.code(404).send({ ok: false, code: "not_found", error: "response version not found" });
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/abort", async (request, reply) => {
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "abort");
    return result.success ? { ok: true } : sendFailure(reply, result);
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/state", async (request, reply) => {
    const result = await nodeSessionService.state(request.params.session_id, cwd(request));
    return "error" in result ? sendFailure(reply, result) : { ok: true, ...result };
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/stats", async (request, reply) => {
    const result = await nodeSessionService.stats(request.params.session_id, cwd(request));
    return "error" in result ? sendFailure(reply, result) : { ok: true, ...result };
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/model", async (request, reply) => {
    const body = request.body as { model?: unknown; thinking?: unknown };
    if (typeof body?.model !== "string" || !body.model.includes("/")) return reply.code(400).send({ ok: false, code: "invalid_request", error: "Model must use provider/model notation" });
    const result = await nodeSessionService.configure(request.params.session_id, cwd(request), body.model, typeof body.thinking === "string" ? body.thinking : undefined);
    if (!result.success) return sendFailure(reply, result);
    return {
      ok: true,
      id: String(result.sessionId ?? request.params.session_id),
      model: result.model ?? body.model,
      thinking: result.thinking ?? body.thinking ?? null,
      restarted: result.restarted === true,
      replaced_blank: result.replacedBlank === true,
    };
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/compact", async (request, reply) => {
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "compact");
    return result.success ? { ok: true } : sendFailure(reply, result);
  });

  app.post<{ Params: { session_id: string; request_id: string } }>("/api/sessions/:session_id/interactions/:request_id", async (request, reply) => {
    const body = (request.body ?? {}) as { cancelled?: unknown; confirmed?: unknown; value?: unknown };
    const payload: Record<string, unknown> = { id: request.params.request_id };
    if (body.cancelled === true) payload.cancelled = true;
    else if (typeof body.confirmed === "boolean") payload.confirmed = body.confirmed;
    else if (body.value !== undefined) payload.value = body.value;
    else payload.cancelled = true;
    const result = await nodeSessionService.notify(request.params.session_id, cwd(request), "extension_ui_response", payload);
    return result.success ? { ok: true } : sendFailure(reply, result);
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/commands", async (request, reply) => {
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "get_commands");
    // Dynamic commands are optional composer metadata. A stale session URL can
    // briefly survive session replacement or deletion, so match the legacy
    // runtime behavior and keep built-in commands available without a red 404.
    if (!result.success && result.code === "not_found") return { commands: [] };
    if (!result.success) return sendFailure(reply, result);
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    return { commands: Array.isArray(data.commands) ? data.commands : [] };
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/export", async (request, reply) => {
    const query = request.query as { format?: unknown };
    const format = typeof query.format === "string" ? query.format : "html";
    if (format !== "html" && format !== "jsonl") return reply.code(400).send({ ok: false, error: "format must be html or jsonl" });
    let root: string;
    try { root = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    const messages = await sessionRepository.messages(root, request.params.session_id);
    if (!messages.length) return reply.code(404).send({ ok: false, code: "not_found", error: "session not found in this workspace" });
    const filename = `session-${request.params.session_id.slice(0, 8)}`;
    reply.header("content-disposition", `attachment; filename=\"${filename}.${format}\"`);
    if (format === "jsonl") return reply.type("application/x-ndjson").send(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    const rows = messages.map((message) => `<section><h2>${escapeHtml(message.role)}</h2><pre>${escapeHtml(messageText(message.content))}</pre></section>`).join("\n");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html><html><head><meta charset=\"utf-8\"><title>${escapeHtml(filename)}</title></head><body><h1>${escapeHtml(filename)}</h1>${rows}</body></html>`);
  });

  app.delete<{ Params: { session_id: string } }>("/api/sessions/:session_id", async (request, reply) => {
    const sessionId = request.params.session_id;
    let workspace: string;
    try {
      workspace = await validateWorkspaceCwd(cwd(request));
    } catch (error) {
      return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) });
    }
    const conversation = await responseVersionRepository.conversation(workspace, sessionId);
    // Delete hidden branches before the visible root. If an active branch is
    // busy the canonical conversation remains available for a safe retry.
    const orderedSessionIds = [
      ...conversation.sessionIds.filter((candidate) => candidate !== conversation.rootSessionId),
      conversation.rootSessionId,
    ];
    for (const candidate of orderedSessionIds) {
      const result = await nodeSessionService.delete(candidate, workspace);
      if (!result.success) return sendFailure(reply, result as Record<string, unknown>);
    }
    const deletedSessionIds = await responseVersionRepository.removeConversation(workspace, sessionId);
    await Promise.all(deletedSessionIds.map((candidate) => titles.deleteTitle(workspace, candidate)));
    return { ok: true, root_session_id: conversation.rootSessionId, deleted_session_ids: deletedSessionIds };
  });
}

function messageText(content: Array<Record<string, unknown>>): string {
  return content.map((part) => String(part.text ?? part.content ?? part.output ?? "")).filter(Boolean).join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
