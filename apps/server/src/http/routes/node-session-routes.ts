import { ApplicationError } from "../../modules/application-error.js";
import { applicationErrorStatus } from "../application-error.js";
import { sessionRuntimeStatus } from "../session-runtime-status.js";
import {
  PromptSubmissionService,
  ApprovalInteractionService,
  type SessionUseCaseResult,
} from "../../runtime/node/session-use-cases.js";
import { readSessionApproval } from "../../runtime/sandbox/session-approval.js";
import {
  withWorkspaceAdmission,
  WorkspaceLifecycleBusyError,
} from "../../runtime/workspace/workspace-lifecycle.js";
import {
  updateSessionApprovalSchema,
  createSessionRequestSchema,
  promptSubmissionRequestSchema,
} from "@pi-science/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import type { SessionTitleRepository } from "../../runtime/node/session-titles.js";
import { sessionTitleRepository } from "../../runtime/node/session-titles.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { AiTitleService } from "../../runtime/title/ai-title-service.js";
import { PromptRequestRepository } from "../../runtime/node/prompt-request-repository.js";
import { SessionCreateRepository } from "../../modules/sessions/session-create-repository.js";
import { type McpConnectorService } from "../../mcp/connector-service.js";
import type { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";

function cwd(request: { query: unknown }): string {
  const value = (request.query as { cwd?: unknown }).cwd;
  return typeof value === "string" && value ? value : ".";
}

async function admitSessionRequest<T>(
  request: { query: unknown },
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await withWorkspaceAdmission(cwd(request), operation);
  } catch (error) {
    if (error instanceof WorkspaceLifecycleBusyError)
      return reply.code(409).send({ ok: false, code: "busy", error: error.message });
    throw error;
  }
}

export { sessionRuntimeStatus } from "../session-runtime-status.js";

async function resolveUseCase(
  operation: () => Promise<SessionUseCaseResult>,
): Promise<SessionUseCaseResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationError)
      return {
        success: false,
        code: error.code,
        kind: error.kind,
        body: { ok: false, code: error.code, error: error.message },
      };
    throw error;
  }
}
function sendUseCaseResult(reply: FastifyReply, result: SessionUseCaseResult) {
  return reply
    .code(
      result.success
        ? result.disposition === "accepted"
          ? 202
          : 200
        : result.kind
          ? applicationErrorStatus({ kind: result.kind })
          : sessionRuntimeStatus(result.code),
    )
    .send(result.body);
}

function sendFailure(reply: FastifyReply, result: Record<string, unknown>) {
  return reply.code(sessionRuntimeStatus(result.code)).send({ ok: false, ...result });
}

export function registerNodeSessionRoutes(
  app: FastifyInstance,
  nodeSessionService: NodeSessionService,
  sessionRepository: SessionRepository,
  aiTitleService?: AiTitleService,
  titles: SessionTitleRepository = sessionTitleRepository,
  approvals?: { mcp: McpConnectorService; events: ConversationEventHub },
  useCases?: {
    promptSubmissions: PromptSubmissionService;
    approvalInteractions: ApprovalInteractionService;
  },
): void {
  const promptRequests = new PromptRequestRepository(sessionRepository);
  // A session created moments ago may not have a transcript file yet, so the
  // runtime is part of the existence check.
  const hasSession = async (workspace: string, sessionId: string) =>
    Boolean(await sessionRepository.findPath(workspace, sessionId)) ||
    nodeSessionService.liveSessions(workspace).some((session) => session.id === sessionId);
  const sessionCreates = new SessionCreateRepository();
  const promptSubmissions =
    useCases?.promptSubmissions ??
    new PromptSubmissionService(nodeSessionService, sessionRepository, promptRequests);
  const approvalInteractions =
    useCases?.approvalInteractions ??
    new ApprovalInteractionService(nodeSessionService, approvals, (message, code) =>
      app.log.warn({ code }, message),
    );
  app.post("/api/sessions", async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid session request", code: "invalid_request" });
    const { idempotencyKey, ...createRequest } = parsed.data;
    const create = async () => {
      const result = await nodeSessionService.create(createRequest);
      if ("error" in result)
        return reply.code(sessionRuntimeStatus(result.code)).send({ ok: false, ...result });
      return reply
        .code(201)
        .header("location", `/api/sessions/${result.id}?cwd=${encodeURIComponent(result.cwd)}`)
        .send(result);
    };
    if (!idempotencyKey) return create();
    let workspace: string;
    try {
      workspace = await validateWorkspaceCwd(createRequest.cwd);
    } catch (error) {
      return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) });
    }
    return sessionCreates.withKeyLock(workspace, idempotencyKey, async () => {
      const existing = await sessionCreates.find(workspace, idempotencyKey);
      if (existing && (await hasSession(workspace, existing)))
        return reply
          .code(200)
          .header("location", `/api/sessions/${existing}?cwd=${encodeURIComponent(workspace)}`)
          .send({ id: existing, cwd: workspace });
      const result = await nodeSessionService.create({ ...createRequest, cwd: workspace });
      if ("error" in result)
        return reply.code(sessionRuntimeStatus(result.code)).send({ ok: false, ...result });
      await sessionCreates.remember(workspace, idempotencyKey, result.id);
      return reply
        .code(201)
        .header("location", `/api/sessions/${result.id}?cwd=${encodeURIComponent(result.cwd)}`)
        .send(result);
    });
  });

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/prompt",
    async (request, reply) => {
      reply.header("deprecation", "true");
      reply.header(
        "link",
        `</api/sessions/${request.params.session_id}/prompts>; rel="successor-version"`,
      );
      const result = await resolveUseCase(() =>
        promptSubmissions.submit(cwd(request), request.params.session_id, request.body),
      );
      return sendUseCaseResult(reply, result);
    },
  );
  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/prompts",
    async (request, reply) => {
      const parsed = promptSubmissionRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          ok: false,
          code: "invalid_request",
          error: "message and UUID v4 client_message_id are required",
        });
      const result = await resolveUseCase(() =>
        promptSubmissions.submit(cwd(request), request.params.session_id, parsed.data),
      );
      if (result.success && result.disposition === "accepted")
        reply.header(
          "location",
          `/api/sessions/${request.params.session_id}/prompt-requests/${parsed.data.client_message_id}?cwd=${encodeURIComponent(cwd(request))}`,
        );
      return sendUseCaseResult(reply, result);
    },
  );

  app.get<{ Params: { session_id: string; client_message_id: string } }>(
    "/api/sessions/:session_id/prompt-requests/:client_message_id",
    async (request, reply) => {
      const { session_id: sessionId, client_message_id: clientMessageId } = request.params;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          clientMessageId,
        )
      ) {
        return reply.code(400).send({
          ok: false,
          code: "invalid_request",
          error: "client_message_id must be a UUID v4",
        });
      }
      let workspace: string;
      try {
        workspace = await validateWorkspaceCwd(cwd(request));
      } catch (error) {
        return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) });
      }
      if (!(await hasSession(workspace, sessionId))) {
        return reply
          .code(404)
          .send({ ok: false, code: "not_found", error: "session not found in this workspace" });
      }
      const status = await promptRequests.getStatus(workspace, sessionId, clientMessageId);
      return status
        ? { ok: true, ...status }
        : reply.code(404).send({ ok: false, code: "not_found", error: "prompt request not found" });
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/title",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        if (!aiTitleService)
          return reply
            .code(404)
            .send({ ok: false, code: "not_found", error: "ai titles are not available" });
        const sessionId = request.params.session_id;
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(cwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const exists = await sessionRepository.findPath(workspace, sessionId);
        if (!exists)
          return reply.code(404).send({ ok: false, code: "not_found", error: "session not found" });
        const manual = (request.body as { manual?: unknown } | undefined)?.manual === true;
        // Only the manual path guards on busy: an automatic request is triggered by
        // the turn-completed event, where the live table may still report busy.
        if (manual && nodeSessionService.sessionBusy(workspace, sessionId)) {
          return reply.code(409).send({
            ok: false,
            code: "session_busy",
            error: "session is running; stop it before regenerating the title",
          });
        }
        // Claim the start order before the model runs, so a user-requested regenerate
        // that starts second still wins when the automatic one finishes first.
        const claim = titles.beginGeneration(workspace, sessionId, manual ? "manual" : "automatic");
        const expected = (await titles.getTitleEntry(workspace, sessionId))?.revision ?? 0;
        const title = await aiTitleService.generateTitle(workspace, sessionId);
        if (!title) return { ok: true, title: null };
        // The generation can outlive the session. The existence re-check runs
        // inside the title write's lock, so a delete that lands while the title
        // generates cannot leave a record behind for a session that is gone.
        const applied = await titles.commitGeneratedTitle(
          workspace,
          sessionId,
          title,
          claim,
          expected,
          async () => (await sessionRepository.findPath(workspace, sessionId)) !== null,
        );
        if (applied.applied) return { ok: true, title, revision: applied.revision };
        return applied.reason === "gone"
          ? { ok: true, title: null, deleted: true }
          : { ok: true, title: null, superseded: true };
      });
    },
  );

  app.put<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/title",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        const sessionId = request.params.session_id;
        const body = (request.body ?? {}) as { title?: unknown; mode?: unknown };
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title)
          return reply.code(400).send({
            ok: false,
            code: "invalid_request",
            error: "title must be a non-empty string",
          });
        if (title.length > 100)
          return reply.code(400).send({
            ok: false,
            code: "invalid_request",
            error: "title must be at most 100 characters",
          });
        // `initialize` is the client's first name for a session, derived from the
        // first message. It may only fill an empty slot; the user's typed rename
        // sends `override` and always wins.
        const initialize = body.mode === "initialize";
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(cwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        // A brand-new session is live before its JSONL lands on disk (the file is
        // written when the first message arrives), so accept the derived-name PUT
        // for live sessions too; unknown sessions still 404, scoped per workspace.
        const exists =
          (await sessionRepository.findPath(workspace, sessionId)) !== null ||
          nodeSessionService.liveSessions(workspace).some((session) => session.id === sessionId);
        if (!exists)
          return reply.code(404).send({ ok: false, code: "not_found", error: "session not found" });
        if (initialize) {
          const stored = await titles.createTitle(workspace, sessionId, title);
          return { ok: true, applied: stored.applied, title: stored.title };
        }
        await titles.setTitle(workspace, sessionId, title);
        return { ok: true, applied: true, title };
      });
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/resume",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        const result = await nodeSessionService.resume(request.params.session_id, cwd(request));
        return result.success
          ? { ok: true, id: request.params.session_id, cwd: cwd(request) }
          : sendFailure(reply, result as Record<string, unknown>);
      });
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/fork",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        const body = (request.body ?? {}) as { entry_id?: unknown };
        const result = await nodeSessionService.fork(
          request.params.session_id,
          cwd(request),
          typeof body.entry_id === "string" ? body.entry_id : undefined,
        );
        return result.success && result.sessionId
          ? { ok: true, id: result.sessionId, cwd: cwd(request) }
          : sendFailure(reply, result);
      });
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/abort",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        const result = await nodeSessionService.command(
          request.params.session_id,
          cwd(request),
          "abort",
        );
        // Stop ends the running turn; it is not a queue flush. Undispatched
        // follow-ups stay queued and the dispatcher picks the head as soon as
        // the session is idle again.
        return result.success ? { ok: true } : sendFailure(reply, result);
      });
    },
  );

  app.get<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/approval-mode",
    async (request, reply) => {
      const workspace = await validateWorkspaceCwd(cwd(request));
      if (!(await nodeSessionService.exists(request.params.session_id, workspace)))
        return reply.code(404).send({ error: "Session not found" });
      const approval = await readSessionApproval(workspace, request.params.session_id);
      return {
        ...approval,
        ...(nodeSessionService.approvalTransitionPending?.(workspace, request.params.session_id)
          ? { transitionPending: true }
          : {}),
      };
    },
  );
  app.put<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/approval-mode",
    async (request, reply) => {
      const parsed = updateSessionApprovalSchema.safeParse(request.body);
      if (!parsed.success || (parsed.data.mode === "full" && !parsed.data.acknowledgeFullAccess))
        return reply
          .code(400)
          .send({ error: "Invalid mode or missing full-access acknowledgement" });
      const result = await nodeSessionService.setApprovalMode(
        request.params.session_id,
        cwd(request),
        parsed.data.mode,
        parsed.data.revision,
      );
      return result.success ? result.data : sendFailure(reply, result);
    },
  );

  app.get<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/state",
    async (request, reply) => {
      const result = await nodeSessionService.state(request.params.session_id, cwd(request));
      return "error" in result ? sendFailure(reply, result) : { ok: true, ...result };
    },
  );

  app.get<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/stats",
    async (request, reply) => {
      const result = await nodeSessionService.stats(request.params.session_id, cwd(request));
      return "error" in result ? sendFailure(reply, result) : { ok: true, ...result };
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/model",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        const body = request.body as { model?: unknown; thinking?: unknown };
        if (typeof body?.model !== "string" || !body.model.includes("/"))
          return reply.code(400).send({
            ok: false,
            code: "invalid_request",
            error: "Model must use provider/model notation",
          });
        const result = await nodeSessionService.configure(
          request.params.session_id,
          cwd(request),
          body.model,
          typeof body.thinking === "string" ? body.thinking : undefined,
        );
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
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/compact",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        const result = await nodeSessionService.command(
          request.params.session_id,
          cwd(request),
          "compact",
        );
        return result.success ? { ok: true } : sendFailure(reply, result);
      });
    },
  );

  app.post<{ Params: { session_id: string; request_id: string } }>(
    "/api/sessions/:session_id/interactions/:request_id",
    async (request, reply) => {
      const result = await resolveUseCase(() =>
        approvalInteractions.respond(
          cwd(request),
          request.params.session_id,
          request.params.request_id,
          request.body,
        ),
      );
      return sendUseCaseResult(reply, result);
    },
  );

  app.get<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/commands",
    async (request, reply) => {
      const result = await nodeSessionService.command(
        request.params.session_id,
        cwd(request),
        "get_commands",
      );
      // Dynamic commands are optional composer metadata. A stale session URL can
      // briefly survive session replacement or deletion, so match the legacy
      // runtime behavior and keep built-in commands available without a red 404.
      if (!result.success && result.code === "not_found") return { commands: [] };
      if (!result.success) return sendFailure(reply, result);
      const data =
        result.data && typeof result.data === "object"
          ? (result.data as Record<string, unknown>)
          : {};
      return { commands: Array.isArray(data.commands) ? data.commands : [] };
    },
  );

  app.get("/api/composer/commands", async (request, reply) => {
    const result = await nodeSessionService.composerCommands(cwd(request));
    if (!result.success) return sendFailure(reply, result);
    return result.data;
  });

  app.get<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/export",
    async (request, reply) => {
      const query = request.query as { format?: unknown };
      const format = typeof query.format === "string" ? query.format : "html";
      if (format !== "html" && format !== "jsonl")
        return reply.code(400).send({ ok: false, error: "format must be html or jsonl" });
      let root: string;
      try {
        root = await validateWorkspaceCwd(cwd(request));
      } catch (error) {
        return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) });
      }
      const messages = await sessionRepository.messages(root, request.params.session_id);
      if (!messages.length)
        return reply
          .code(404)
          .send({ ok: false, code: "not_found", error: "session not found in this workspace" });
      const filename = `session-${request.params.session_id.slice(0, 8)}`;
      reply.header("content-disposition", `attachment; filename="${filename}.${format}"`);
      if (format === "jsonl")
        return reply
          .type("application/x-ndjson")
          .send(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
      const rows = messages
        .map(
          (message) =>
            `<section><h2>${escapeHtml(message.role)}</h2><pre>${escapeHtml(messageText(message.content))}</pre></section>`,
        )
        .join("\n");
      return reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(filename)}</title></head><body><h1>${escapeHtml(filename)}</h1>${rows}</body></html>`,
        );
    },
  );

  app.delete<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id",
    async (request, reply) => {
      return admitSessionRequest(request, reply, async () => {
        const sessionId = request.params.session_id;
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(cwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const result = await nodeSessionService.delete(request.params.session_id, cwd(request));
        if (result.success) await titles.deleteTitle(workspace, sessionId);
        return result.success
          ? { ok: true }
          : sendFailure(reply, result as Record<string, unknown>);
      });
    },
  );
}

function messageText(content: Array<Record<string, unknown>>): string {
  return content
    .map((part) => String(part.text ?? part.content ?? part.output ?? ""))
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
