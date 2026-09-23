import { createSessionRequestSchema } from "@pi-science/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import type { SessionTitleRepository } from "../../runtime/node/session-titles.js";
import { sessionTitleRepository } from "../../runtime/node/session-titles.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { AiTitleService } from "../../runtime/title/ai-title-service.js";
import { PromptRequestRepository } from "../../runtime/node/prompt-request-repository.js";

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

export function registerNodeSessionRoutes(
  app: FastifyInstance,
  nodeSessionService: NodeSessionService,
  sessionRepository: SessionRepository,
  aiTitleService?: AiTitleService,
  titles: SessionTitleRepository = sessionTitleRepository,
): void {
  const promptRequests = new PromptRequestRepository(sessionRepository);
  app.post("/api/sessions", async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid session request", code: "invalid_request" });
    const result = await nodeSessionService.create(parsed.data);
    if ("error" in result) return reply.code(status(result.code)).send({ ok: false, ...result });
    return result;
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/prompt", async (request, reply) => {
    const body = request.body as { message?: unknown; client_message_id?: unknown };
    if (typeof body?.message !== "string" || !body.message) return reply.code(400).send({ ok: false, code: "invalid_request", error: "message is required" });
    const clientMessageId = body.client_message_id;
    if (clientMessageId === undefined) {
      let workspace: string;
      try { workspace = await validateWorkspaceCwd(cwd(request)); }
      catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
      return promptRequests.withSessionMutationLock(workspace, request.params.session_id, async () => {
        const result = await nodeSessionService.command(request.params.session_id, workspace, "prompt", { message: body.message });
        return result.success ? { ok: true, id: request.params.session_id } : sendFailure(reply, result);
      });
    }
    if (typeof clientMessageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMessageId)) {
      return reply.code(400).send({ ok: false, code: "invalid_request", error: "client_message_id must be a UUID v4" });
    }
    const requestId = clientMessageId;
    const promptMessage = body.message;
    let workspace: string;
    try { workspace = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    const sessionId = request.params.session_id;
    if (!(await sessionRepository.findPath(workspace, sessionId)) && !nodeSessionService.liveSessions(workspace).some((session) => session.id === sessionId)) {
      return reply.code(404).send({ ok: false, code: "not_found", error: "session not found in this workspace" });
    }

    return promptRequests.withSessionMutationLock(workspace, sessionId, async () => {
      const prepared = await promptRequests.prepare(workspace, sessionId, requestId, promptMessage);
      if ("conflict" in prepared) {
        return reply.code(409).send({ ok: false, code: "client_message_id_conflict", error: "client_message_id was already used with different prompt content" });
      }
      if ("busy" in prepared) {
        return reply.code(409).send({ ok: false, code: "prompt_request_in_flight", error: "another prompt request for this session is still being reconciled", blocking_client_message_id: prepared.blocking_client_message_id });
      }
      if (!prepared.dispatch) {
        if (prepared.status.status === "rejected") {
          return reply.code(503).send({ ok: false, code: prepared.status.error_code ?? "prompt_rejected", error: "prompt request could not be prepared", ...prepared.status });
        }
        return reply.code(202).send({ ok: true, id: sessionId, ...prepared.status });
      }

      let result: Awaited<ReturnType<NodeSessionService["command"]>>;
      try {
        result = await nodeSessionService.command(sessionId, workspace, "prompt", { message: promptMessage });
      } catch (error) {
        const delivery = await promptRequests.update(workspace, sessionId, requestId, "indeterminate", { error_code: "prompt_command_threw" });
        return reply.code(502).send({ ok: false, code: "prompt_command_threw", error: String(error), ...(delivery ?? {}) });
      }
      if (result.success) {
        const accepted = await promptRequests.update(workspace, sessionId, requestId, "accepted");
        const current = await promptRequests.getStatus(workspace, sessionId, requestId);
        return reply.code(202).send({ ok: true, id: sessionId, ...(current ?? accepted ?? prepared.status) });
      }
      // A transport failure can happen after Pi accepted the command. Preserve
      // that ambiguity; only a definite HTTP/runtime rejection is retryable.
      const errorCode = typeof result.code === "string" ? result.code : "runtime_command_failed";
      const indeterminateCodes = new Set(["timeout", "process_closed", "process_exit", "write_failed", "spawn_failed", "runtime_command_failed", "internal_error"]);
      const state = indeterminateCodes.has(errorCode) ? "indeterminate" as const : "rejected" as const;
      const delivery = await promptRequests.update(workspace, sessionId, requestId, state, { error_code: errorCode });
      if (state === "rejected") await promptRequests.clearAssociation(workspace, sessionId, requestId);
      return reply.code(status(result.code)).send({ ok: false, ...result, ...(delivery ?? {}) });
    });
  });

  app.get<{ Params: { session_id: string; client_message_id: string } }>("/api/sessions/:session_id/prompt-requests/:client_message_id", async (request, reply) => {
    const { session_id: sessionId, client_message_id: clientMessageId } = request.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMessageId)) {
      return reply.code(400).send({ ok: false, code: "invalid_request", error: "client_message_id must be a UUID v4" });
    }
    let workspace: string;
    try { workspace = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    if (!(await sessionRepository.findPath(workspace, sessionId)) && !nodeSessionService.liveSessions(workspace).some((session) => session.id === sessionId)) {
      return reply.code(404).send({ ok: false, code: "not_found", error: "session not found in this workspace" });
    }
    const status = await promptRequests.getStatus(workspace, sessionId, clientMessageId);
    return status ? { ok: true, ...status } : reply.code(404).send({ ok: false, code: "not_found", error: "prompt request not found" });
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
    const result = await nodeSessionService.delete(request.params.session_id, cwd(request));
    if (result.success) await titles.deleteTitle(workspace, sessionId);
    return result.success ? { ok: true } : sendFailure(reply, result as Record<string, unknown>);
  });
}

function messageText(content: Array<Record<string, unknown>>): string {
  return content.map((part) => String(part.text ?? part.content ?? part.output ?? "")).filter(Boolean).join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
