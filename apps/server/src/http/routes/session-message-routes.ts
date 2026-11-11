import type { FastifyInstance, FastifyReply } from "fastify";
import { isPromptDeliveryIndeterminate } from "../../runtime/node/prompt-request-repository.js";
import { SessionQueueDispatcher } from "../../runtime/node/session-queue-dispatcher.js";
import { SessionQueueRepository } from "../../modules/session/session-queue-repository.js";
import { SteerRequestLedger } from "../../runtime/node/steer-request-ledger.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { SessionRepository } from "../../runtime/node/session-repository.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import {
  withWorkspaceAdmission,
  WorkspaceLifecycleBusyError,
} from "../../runtime/workspace/workspace-lifecycle.js";
import { sessionRuntimeStatus } from "../session-runtime-status.js";

const CLIENT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 200_000;

function rawCwd(request: { query: unknown }): string {
  const value = (request.query as { cwd?: unknown }).cwd;
  return typeof value === "string" && value ? value : ".";
}

function messageText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_MESSAGE_LENGTH ? text : null;
}

async function withWorkspace<T>(
  request: { query: unknown },
  reply: FastifyReply,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await withWorkspaceAdmission(rawCwd(request), operation);
  } catch (error) {
    if (error instanceof WorkspaceLifecycleBusyError)
      return reply.code(409).send({ ok: false, code: "busy", error: error.message });
    throw error;
  }
}

/** Steer and follow-up queue endpoints. Both are running-turn actions, so they
 *  reuse the session's workspace admission and approval barrier instead of
 *  introducing a second execution path. */
export function registerSessionMessageRoutes(
  app: FastifyInstance,
  nodeSessionService: NodeSessionService,
  sessionRepository: SessionRepository,
  deps: {
    queue?: SessionQueueRepository;
    steers?: SteerRequestLedger;
    dispatcher?: SessionQueueDispatcher;
  } = {},
): void {
  const queue = deps.queue ?? new SessionQueueRepository();
  const steers = deps.steers ?? new SteerRequestLedger();
  const dispatcher =
    deps.dispatcher ??
    new SessionQueueDispatcher(
      {
        async state(sessionId, cwd) {
          const state = await nodeSessionService.state(sessionId, cwd);
          return "error" in state ? { failure: state.error, code: state.code } : state;
        },
        command(sessionId, cwd, type, params) {
          return nodeSessionService.command(sessionId, cwd, type, params);
        },
      },
      queue,
    );
  app.addHook("onClose", async () => {
    dispatcher.stop();
  });

  const knownSession = async (workspace: string, sessionId: string) =>
    (await sessionRepository.findPath(workspace, sessionId)) !== null ||
    nodeSessionService.liveSessions(workspace).some((session) => session.id === sessionId);

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/steer",
    async (request, reply) => {
      return withWorkspace(request, reply, async () => {
        const body = (request.body ?? {}) as { message?: unknown; client_message_id?: unknown };
        const message = messageText(body.message);
        if (!message)
          return reply
            .code(400)
            .send({ ok: false, code: "invalid_request", error: "message is required" });
        const clientMessageId = body.client_message_id;
        if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID.test(clientMessageId)) {
          return reply.code(400).send({
            ok: false,
            code: "invalid_request",
            error: "client_message_id must be a UUID v4",
          });
        }
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(rawCwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const sessionId = request.params.session_id;
        if (!(await knownSession(workspace, sessionId))) {
          return reply
            .code(404)
            .send({ ok: false, code: "not_found", error: "session not found in this workspace" });
        }

        const claim = await steers.claim(workspace, sessionId, clientMessageId, message);
        if ("conflict" in claim) {
          return reply.code(409).send({
            ok: false,
            code: "client_message_id_conflict",
            error: "client_message_id was already used with different content",
          });
        }
        if (!claim.dispatch) {
          const status = claim.status === "accepted" ? 202 : 409;
          return reply.code(status).send({
            ok: claim.status === "accepted",
            status: claim.status,
            client_message_id: clientMessageId,
            ...(claim.error_code ? { error_code: claim.error_code } : {}),
          });
        }

        // A steer belongs to a running turn. Saying so is honest: the alternative
        // is silently turning the user's choice into a normal prompt.
        const state = await nodeSessionService.state(sessionId, workspace);
        if ("error" in state) {
          await steers.settle(
            workspace,
            sessionId,
            clientMessageId,
            message,
            "rejected",
            String(state.code ?? "state_failed"),
          );
          return reply.code(sessionRuntimeStatus(state.code)).send({
            ok: false,
            code: state.code,
            error: state.error,
            status: "rejected",
            client_message_id: clientMessageId,
          });
        }
        if (!state.is_streaming && state.pending_message_count === 0) {
          await steers.settle(
            workspace,
            sessionId,
            clientMessageId,
            message,
            "rejected",
            "not_running",
          );
          return reply.code(409).send({
            ok: false,
            code: "not_running",
            error: "the session is not running; queue the message or send it as a prompt",
            status: "rejected",
            client_message_id: clientMessageId,
          });
        }

        const result = await nodeSessionService.command(sessionId, workspace, "steer", { message });
        if (result.success) {
          await steers.settle(workspace, sessionId, clientMessageId, message, "accepted");
          return reply
            .code(202)
            .send({ ok: true, status: "accepted", client_message_id: clientMessageId });
        }
        const code = typeof result.code === "string" && result.code ? result.code : "steer_failed";
        const status = isPromptDeliveryIndeterminate(code)
          ? ("indeterminate" as const)
          : ("rejected" as const);
        await steers.settle(workspace, sessionId, clientMessageId, message, status, code);
        return reply.code(sessionRuntimeStatus(result.code)).send({
          ok: false,
          ...result,
          status,
          client_message_id: clientMessageId,
          error_code: code,
        });
      });
    },
  );

  app.get<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/queue",
    async (request, reply) => {
      const workspace = await validateWorkspaceCwd(rawCwd(request));
      const sessionId = request.params.session_id;
      if (!(await knownSession(workspace, sessionId)))
        return reply
          .code(404)
          .send({ ok: false, code: "not_found", error: "session not found in this workspace" });
      const snapshot = await queue.read(workspace, sessionId);
      // A refresh (or a restart) is a recovery point: drain whatever is pending.
      if (!snapshot.paused && snapshot.entries.some((entry) => entry.status === "queued"))
        dispatcher.kick(workspace, sessionId, { immediate: true });
      return { ok: true, queue: snapshot };
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/queue",
    async (request, reply) => {
      return withWorkspace(request, reply, async () => {
        const body = (request.body ?? {}) as { message?: unknown; client_message_id?: unknown };
        const message = messageText(body.message);
        if (!message)
          return reply
            .code(400)
            .send({ ok: false, code: "invalid_request", error: "message is required" });
        const clientMessageId = body.client_message_id;
        if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID.test(clientMessageId)) {
          return reply.code(400).send({
            ok: false,
            code: "invalid_request",
            error: "client_message_id must be a UUID v4",
          });
        }
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(rawCwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const sessionId = request.params.session_id;
        if (!(await knownSession(workspace, sessionId))) {
          return reply
            .code(404)
            .send({ ok: false, code: "not_found", error: "session not found in this workspace" });
        }
        const enqueued = await queue.enqueue(workspace, sessionId, {
          id: clientMessageId,
          text: message,
        });
        if (!enqueued.ok) {
          return reply.code(409).send({
            ok: false,
            code: "client_message_id_conflict",
            error: "client_message_id was already used with different content",
          });
        }
        if (enqueued.created) dispatcher.kick(workspace, sessionId, { immediate: true });
        return reply
          .code(enqueued.created ? 201 : 200)
          .send({ ok: true, entry: enqueued.entry, created: enqueued.created });
      });
    },
  );

  app.patch<{ Params: { session_id: string; entry_id: string } }>(
    "/api/sessions/:session_id/queue/:entry_id",
    async (request, reply) => {
      return withWorkspace(request, reply, async () => {
        const body = (request.body ?? {}) as { message?: unknown };
        const message = messageText(body.message);
        if (!message)
          return reply
            .code(400)
            .send({ ok: false, code: "invalid_request", error: "message is required" });
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(rawCwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const result = await queue.edit(
          workspace,
          request.params.session_id,
          request.params.entry_id,
          message,
        );
        if (result.ok) return { ok: true, entry: result.entry };
        return reply.code(result.code === "not_found" ? 404 : 409).send({
          ok: false,
          code: result.code,
          error:
            result.code === "not_found"
              ? "queued message not found"
              : "only a queued message can be edited",
        });
      });
    },
  );

  app.delete<{ Params: { session_id: string; entry_id: string } }>(
    "/api/sessions/:session_id/queue/:entry_id",
    async (request, reply) => {
      return withWorkspace(request, reply, async () => {
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(rawCwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const result = await queue.cancel(
          workspace,
          request.params.session_id,
          request.params.entry_id,
        );
        if (result.ok) return { ok: true, entry: result.entry };
        return reply.code(result.code === "not_found" ? 404 : 409).send({
          ok: false,
          code: result.code,
          error:
            result.code === "not_found"
              ? "queued message not found"
              : "a dispatched message cannot be cancelled",
        });
      });
    },
  );

  app.post<{ Params: { session_id: string; entry_id: string } }>(
    "/api/sessions/:session_id/queue/:entry_id/retry",
    async (request, reply) => {
      return withWorkspace(request, reply, async () => {
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(rawCwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const sessionId = request.params.session_id;
        if (!(await knownSession(workspace, sessionId))) {
          return reply
            .code(404)
            .send({ ok: false, code: "not_found", error: "session not found in this workspace" });
        }
        const result = await queue.retry(workspace, sessionId, request.params.entry_id);
        if (result.ok) return { ok: true, entry: result.entry };
        return reply.code(result.code === "not_found" ? 404 : 409).send({
          ok: false,
          code: result.code,
          error:
            result.code === "not_found"
              ? "queued message not found"
              : "only a failed message can be retried",
        });
      });
    },
  );

  app.post<{ Params: { session_id: string; entry_id: string } }>(
    "/api/sessions/:session_id/queue/:entry_id/dispatch",
    async (request, reply) => {
      return withWorkspace(request, reply, async () => {
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(rawCwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const sessionId = request.params.session_id;
        if (!(await knownSession(workspace, sessionId))) {
          return reply
            .code(404)
            .send({ ok: false, code: "not_found", error: "session not found in this workspace" });
        }
        const claimed = await queue.claimForSteer(workspace, sessionId, request.params.entry_id);
        if (!claimed.ok) {
          return reply.code(claimed.code === "not_found" ? 404 : 409).send({
            ok: false,
            code: claimed.code,
            error:
              claimed.code === "not_found"
                ? "queued message not found"
                : "only a queued message can be dispatched",
          });
        }
        const entry = claimed.entry;
        // A rejected attempt must stay retryable: the entry goes back to the
        // queue and no ledger row is written, so the same id can be claimed again.
        // The claim already wrote `dispatching`, so a failed requeue is recovered
        // by the stale-claim sweep instead of masking the original error.
        const requeue = async (errorCode: string) => {
          await queue
            .settle(workspace, sessionId, entry.id, { status: "queued", error_code: errorCode })
            .catch(() => null);
        };
        // The worker may have taken the steer before the transport broke, so a
        // retry could deliver it twice. Settle it visibly as sent-but-unconfirmed
        // instead of pretending the delivery failed.
        const settleUnconfirmed = async (code: string) => {
          await steers
            .settle(workspace, sessionId, entry.id, entry.text, "indeterminate", code)
            .catch(() => undefined);
          return queue.settle(workspace, sessionId, entry.id, {
            status: "dispatched",
            error_code: "indeterminate",
          });
        };

        let receipt: Awaited<ReturnType<typeof steers.claim>>;
        try {
          receipt = await steers.claim(workspace, sessionId, entry.id, entry.text);
        } catch (error) {
          await requeue("ledger_failed");
          return reply.code(500).send({ ok: false, code: "ledger_failed", error: String(error) });
        }
        if ("conflict" in receipt) {
          await requeue("client_message_id_conflict");
          return reply.code(409).send({
            ok: false,
            code: "client_message_id_conflict",
            error: "queued message id was already used with different content",
          });
        }
        if (!receipt.dispatch) {
          // A previous attempt already reached the ledger. An accepted or
          // indeterminate receipt means the steer may have landed, so the queue
          // entry is settled instead of delivered twice.
          if (receipt.status === "accepted" || receipt.status === "indeterminate") {
            const settled = await queue.settle(workspace, sessionId, entry.id, {
              status: "dispatched",
              ...(receipt.status === "indeterminate" ? { error_code: "indeterminate" } : {}),
            });
            return reply.code(202).send({
              ok: true,
              status: receipt.status === "indeterminate" ? "indeterminate" : "accepted",
              ...(receipt.status === "indeterminate" ? { error_code: "indeterminate" } : {}),
              entry: settled ?? entry,
            });
          }
          await requeue(receipt.error_code ?? "rejected");
          return reply.code(409).send({
            ok: false,
            code: receipt.error_code ?? "rejected",
            status: receipt.status,
            error: "the queued message could not be delivered immediately",
          });
        }

        let state: Awaited<ReturnType<typeof nodeSessionService.state>>;
        try {
          state = await nodeSessionService.state(sessionId, workspace);
        } catch (error) {
          await requeue("state_failed");
          return reply.code(500).send({ ok: false, code: "state_failed", error: String(error) });
        }
        if ("error" in state) {
          await requeue(String(state.code ?? "state_failed"));
          return reply.code(sessionRuntimeStatus(state.code)).send({
            ok: false,
            code: state.code,
            error: state.error,
          });
        }
        if (!state.is_streaming && state.pending_message_count === 0) {
          await requeue("not_running");
          return reply.code(409).send({
            ok: false,
            code: "not_running",
            error: "the session is not running; the queued message stays queued",
          });
        }

        let result: Awaited<ReturnType<typeof nodeSessionService.command>>;
        try {
          result = await nodeSessionService.command(sessionId, workspace, "steer", {
            message: entry.text,
          });
        } catch (error) {
          const settled = await settleUnconfirmed("steer_unconfirmed");
          return reply.code(202).send({
            ok: true,
            status: "indeterminate",
            error_code: "steer_unconfirmed",
            error: String(error),
            entry: settled ?? entry,
          });
        }
        if (result.success) {
          await steers.settle(workspace, sessionId, entry.id, entry.text, "accepted");
          const settled = await queue.settle(workspace, sessionId, entry.id, {
            status: "dispatched",
          });
          return reply.code(202).send({ ok: true, status: "accepted", entry: settled ?? entry });
        }
        const code = typeof result.code === "string" && result.code ? result.code : "steer_failed";
        if (isPromptDeliveryIndeterminate(code)) {
          const settled = await settleUnconfirmed(code);
          return reply.code(202).send({
            ok: true,
            status: "indeterminate",
            error_code: code,
            entry: settled ?? entry,
          });
        }
        await requeue(code);
        return reply.code(sessionRuntimeStatus(result.code)).send({
          ok: false,
          ...result,
          status: "rejected",
          error_code: code,
        });
      });
    },
  );

  app.post<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id/queue/resume",
    async (request, reply) => {
      return withWorkspace(request, reply, async () => {
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(rawCwd(request));
        } catch (error) {
          return reply
            .code(403)
            .send({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        const snapshot = await queue.resume(workspace, request.params.session_id);
        if (snapshot.entries.some((entry) => entry.status === "queued"))
          dispatcher.kick(workspace, request.params.session_id, { immediate: true });
        return { ok: true, queue: snapshot };
      });
    },
  );
}
