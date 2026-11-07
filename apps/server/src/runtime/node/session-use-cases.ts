import type { ApplicationErrorKind } from "../../modules/application-error.js";
import {
  legacyPromptSubmissionRequestSchema,
  approvalInteractionRequestSchema,
} from "@pi-science/contracts";
import type { NodeSessionService } from "./node-session-service.js";
import type { SessionRepository } from "./session-repository.js";
import {
  PromptRequestRepository,
  isPromptDeliveryIndeterminate,
} from "./prompt-request-repository.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import {
  withWorkspaceAdmission,
  WorkspaceLifecycleBusyError,
} from "../workspace/workspace-lifecycle.js";
import { type McpConnectorService } from "../../mcp/connector-service.js";
import type { ConversationEventHub } from "../events/conversation-event-hub.js";

export type SessionUseCaseResult =
  | { success: true; disposition: "accepted" | "completed"; body: Record<string, unknown> }
  | { success: false; code: string; kind?: ApplicationErrorKind; body: Record<string, unknown> };
const response = (
  disposition: "accepted" | "completed",
  body: Record<string, unknown>,
): SessionUseCaseResult => ({ success: true, disposition, body });
const failure = (
  body: Record<string, unknown>,
  kind?: ApplicationErrorKind,
): SessionUseCaseResult => ({
  success: false,
  code: String(body.code ?? "runtime_command_failed"),
  kind,
  body,
});
async function admitted(
  cwd: string,
  operation: () => Promise<SessionUseCaseResult>,
): Promise<SessionUseCaseResult> {
  try {
    return await withWorkspaceAdmission(cwd, operation);
  } catch (error) {
    if (error instanceof WorkspaceLifecycleBusyError)
      return failure({ ok: false, code: "busy", error: error.message });
    throw error;
  }
}

/** Owns durable prompt deduplication and ambiguous-delivery reconciliation for all entry points. */
export class PromptSubmissionService {
  private readonly requests: PromptRequestRepository;
  constructor(
    private readonly sessions: NodeSessionService,
    private readonly repository: SessionRepository,
    requests?: PromptRequestRepository,
  ) {
    this.requests = requests ?? new PromptRequestRepository(repository);
  }
  submit(requestedCwd: string, sessionId: string, input: unknown): Promise<SessionUseCaseResult> {
    return admitted(requestedCwd, async () => {
      const parsed = legacyPromptSubmissionRequestSchema.safeParse(input);
      if (!parsed.success)
        return failure({
          ok: false,
          code: "invalid_request",
          error: "message and a valid client_message_id are required",
        });
      const body = parsed.data;
      const clientMessageId = body.client_message_id;
      if (clientMessageId === undefined) {
        let workspace: string;
        try {
          workspace = await validateWorkspaceCwd(requestedCwd);
        } catch (error) {
          return failure({ ok: false, code: "workspace_invalid", error: String(error) });
        }
        return this.requests.withSessionMutationLock(workspace, sessionId, async () => {
          const result = await this.sessions.command(sessionId, workspace, "prompt", {
            message: body.message,
          });
          return result.success
            ? response("completed", { ok: true, id: sessionId })
            : failure({ ok: false, ...result });
        });
      }
      const requestId = clientMessageId;
      const promptMessage = body.message;
      let workspace: string;
      try {
        workspace = await validateWorkspaceCwd(requestedCwd);
      } catch (error) {
        return failure({ ok: false, code: "workspace_invalid", error: String(error) });
      }
      if (
        !(await this.repository.findPath(workspace, sessionId)) &&
        !this.sessions.liveSessions(workspace).some((session) => session.id === sessionId)
      ) {
        return failure({
          ok: false,
          code: "not_found",
          error: "session not found in this workspace",
        });
      }

      return this.requests.withSessionMutationLock(workspace, sessionId, async () => {
        const prepared = await this.requests.prepare(
          workspace,
          sessionId,
          requestId,
          promptMessage,
        );
        if ("conflict" in prepared) {
          return failure({
            ok: false,
            code: "client_message_id_conflict",
            error: "client_message_id was already used with different prompt content",
          });
        }
        if ("busy" in prepared) {
          return failure({
            ok: false,
            code: "prompt_request_in_flight",
            error: "another prompt request for this session is still being reconciled",
            blocking_client_message_id: prepared.blocking_client_message_id,
          });
        }
        if (!prepared.dispatch) {
          if (prepared.status.status === "rejected") {
            return failure(
              {
                ok: false,
                code: prepared.status.error_code ?? "prompt_rejected",
                error: "prompt request could not be prepared",
                ...prepared.status,
              },
              "unavailable",
            );
          }
          return response("accepted", { ok: true, id: sessionId, ...prepared.status });
        }

        let result: Awaited<ReturnType<NodeSessionService["command"]>>;
        try {
          result = await this.sessions.command(sessionId, workspace, "prompt", {
            message: promptMessage,
            client_message_id: requestId,
          });
        } catch (error) {
          const delivery = await this.requests.update(
            workspace,
            sessionId,
            requestId,
            "indeterminate",
            { error_code: "prompt_command_threw" },
          );
          return failure({
            ok: false,
            code: "prompt_command_threw",
            error: String(error),
            ...(delivery ?? {}),
          });
        }
        if (result.success) {
          const accepted = await this.requests.update(workspace, sessionId, requestId, "accepted");
          const current = await this.requests.getStatus(workspace, sessionId, requestId);
          return response("accepted", {
            ok: true,
            id: sessionId,
            ...(current ?? accepted ?? prepared.status),
          });
        }
        // A transport failure can happen after Pi accepted the command. Preserve
        // that ambiguity; only a definite HTTP/runtime rejection is retryable.
        const errorCode = typeof result.code === "string" ? result.code : "runtime_command_failed";
        const state = isPromptDeliveryIndeterminate(errorCode)
          ? ("indeterminate" as const)
          : ("rejected" as const);
        const delivery = await this.requests.update(workspace, sessionId, requestId, state, {
          error_code: errorCode,
        });
        return failure({ ok: false, ...result, ...(delivery ?? {}) });
      });
    });
  }
}

export class ApprovalInteractionService {
  constructor(
    private readonly sessions: NodeSessionService,
    private readonly approvals?: { mcp: McpConnectorService; events: ConversationEventHub },
    private readonly warn: (message: string, code: unknown) => void = () => {},
  ) {}
  respond(
    requestedCwd: string,
    sessionId: string,
    requestId: string,
    input: unknown,
  ): Promise<SessionUseCaseResult> {
    return admitted(requestedCwd, async () => {
      const parsed = approvalInteractionRequestSchema.safeParse(input ?? {});
      if (!parsed.success)
        return failure({
          ok: false,
          code: "invalid_request",
          error: "Invalid interaction response",
        });
      const body = parsed.data;
      let saveGrant:
        | (() => Promise<{ persistentGrant: boolean | null; warning?: string }>)
        | undefined;
      if (body.alwaysAllow === true) {
        const workspace = await validateWorkspaceCwd(requestedCwd);
        const pending = this.approvals?.events.pendingInteraction(workspace, sessionId, requestId);
        if (
          body.confirmed !== true ||
          body.cancelled === true ||
          pending?.kind !== "permission" ||
          pending.method !== "confirm" ||
          !this.approvals
        ) {
          return failure({
            ok: false,
            code: "stale_approval",
            error: "No matching pending MCP approval",
          });
        }
        saveGrant = await this.approvals.mcp.prepareInteractionGrant(workspace, pending.mcpGrant);
      }
      const payload: Record<string, unknown> = { id: requestId };
      if (body.cancelled === true) payload.cancelled = true;
      else if (typeof body.confirmed === "boolean") payload.confirmed = body.confirmed;
      else if (body.value !== undefined) payload.value = body.value;
      else payload.cancelled = true;
      if (saveGrant) payload.deferResolution = true;
      const result = await this.sessions.notify(
        sessionId,
        requestedCwd,
        "extension_ui_response",
        payload,
      );
      if (!result.success) return failure({ ok: false, ...result });
      if (!saveGrant) return response("completed", { ok: true });
      try {
        return response("completed", { ok: true, ...(await saveGrant()) });
      } finally {
        const completed = await this.sessions.notify(
          sessionId,
          requestedCwd,
          "extension_ui_response",
          { id: requestId, complete: true },
        );
        if (!completed.success) this.warn("MCP approval completion failed", completed.code);
      }
    });
  }
}
