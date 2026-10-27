import { withWorkspaceAdmission } from "../../workspace/workspace-lifecycle.js";
import type { PiConfig } from "@pi-science/contracts";
import { randomUUID } from "node:crypto";
import { readJson } from "../../../storage/persistence.js";
import type { RuntimeResult } from "../agent-runtime-types.js";
import { AgentRuntimeExitedError, AgentRuntimeTimeoutError } from "../agent-runtime-errors.js";
import { promptOperationId } from "../agent-message.js";
import { identity, configPath, splitModel, failed } from "./identity.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "commandOnce" | "composerCommands" | "configureOnce" | "events" | "live" | "notifyAdmitted" | "open" | "opening" | "recover" | "registry" | "repository" | "scheduleWatchdog" | "stopForReload" | "turns" | "withMutation">;

export async function command(context: Context, cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> {
  return withWorkspaceAdmission(cwd, () => ["abort", "steer", "follow_up"].includes(type)
    ? context.commandOnce(cwd, sessionId, type, params, config)
    : context.withMutation(cwd, sessionId, () => context.commandOnce(cwd, sessionId, type, params, config))).catch(failed);
}

export async function commandOnce(context: Context, cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> {
  // Cold-session completions are metadata: no model credentials or execution
  // sandbox should be needed. Live workers retain their current resource policy.
  const key = identity(cwd, sessionId);
  if (type === "get_commands" && !context.live.has(key) && !context.opening.has(key)) {
    if ((await context.registry.get(cwd, sessionId))?.state === "deleted" || !await context.repository.findPath(cwd, sessionId)) {
      return { success: false, code: "not_found", error: "session not found in this workspace" };
    }
    const saved = await readJson<Pick<PiConfig, "skills"> | null>(configPath(cwd, sessionId), null);
    return { success: true, data: await context.composerCommands(cwd, { ...config, skills: saved?.skills ?? config.skills }) };
  }
  const opened = await context.open(cwd, sessionId, config);
  if ("success" in opened) return opened;
  if (opened.approvalTransitionFailed) return { success: false, code: "permission_transition_failed", error: "Retry the approval change to finish revoking old capabilities" };
  if (type === "prompt") {
    const clientMessageId = typeof params.client_message_id === "string" ? params.client_message_id : randomUUID();
    params = { ...params, client_message_id: clientMessageId };
    const operationId = promptOperationId(sessionId, clientMessageId);
    try { await context.turns.prepare(cwd, sessionId, operationId); }
    catch (error) { return { success: false, code: "lifecycle_prepare_failed", error: String(error) }; }
    if (!opened.expectedOperationId) {
      opened.expectedOperationId = operationId;
      opened.lastProgressAt = Date.now();
      opened.interactionWaitStartedAt = undefined;
    }
    context.scheduleWatchdog(opened);
  }
  try {
    const result = await opened.runtime.sendCommand(type, params);
    if (type === "prompt" && result.code === "busy" && typeof params.client_message_id === "string") {
      await context.turns.discardRejected(cwd, sessionId, promptOperationId(sessionId, params.client_message_id)).catch(() => undefined);
    }
    if (type === "prompt" && !opened.busy && (!result.success || result.deduplicated)) {
      opened.expectedOperationId = undefined;
      context.scheduleWatchdog(opened);
    }
    return result;
  } catch (error) {
    if (error instanceof AgentRuntimeTimeoutError || error instanceof AgentRuntimeExitedError) void context.recover(opened);
    return failed(error);
  }
}

export async function notify(context: Context, cwd: string, sessionId: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult> {
  return withWorkspaceAdmission(cwd, () => context.notifyAdmitted(cwd, sessionId, type, params)).catch(failed);
}

export async function notifyAdmitted(context: Context, cwd: string, sessionId: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult> {
  const current = context.live.get(identity(cwd, sessionId));
  if (!current || current.runtime.isClosed) return { success: false, code: "not_found", error: "active agent worker not found" };
  try {
    await current.runtime.sendNotification(type, params);
    if (type === "extension_ui_response" && typeof params.id === "string") {
      context.events.resolvePendingInteraction(cwd, sessionId, params.id);
    }
    return { success: true };
  } catch (error) { return failed(error); }
}

export async function configure(context: Context, cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> {
  return context.withMutation(cwd, sessionId, () => context.configureOnce(cwd, sessionId, model, level, config));
}

export async function configureOnce(context: Context, cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> {
  const ref = splitModel(model);
  if (!ref) return { success: false, code: "invalid_model", error: "Model must use provider/model notation" };
  if (level !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
    return { success: false, code: "invalid_thinking", error: "invalid thinking level" };
  }
  const opened = await context.open(cwd, sessionId, config);
  if ("success" in opened) return opened;
  if (opened.approvalTransitionFailed) return { success: false, code: "permission_transition_failed", error: "Retry the approval change to finish revoking old capabilities" };
  if (opened.busy) return { success: false, code: "busy", error: "agent is busy; wait for the current task to finish or stop it" };
  const result = await opened.runtime.sendCommand("configure", { ...ref, ...(level ? { level } : {}) }).catch(failed);
  if (!result.success) return result;
  const state = result.data as { model?: { provider?: string; modelId?: string }; thinkingLevel?: string } | undefined;
  if (state?.model?.provider !== ref.provider || state.model.modelId !== ref.modelId
    || typeof state.thinkingLevel !== "string" || (level !== undefined && state.thinkingLevel !== level)) {
    await context.stopForReload(opened).catch(() => undefined);
    return { success: false, code: "reconcile_failed", error: "agent runtime returned an inconsistent configuration" };
  }
  opened.model = `${state.model.provider}/${state.model.modelId}`;
  opened.thinking = state.thinkingLevel;
  // The harness log is the configuration authority. The sidecar contains
  // product settings only, so a cache write cannot roll back a newer commit.
  return { success: true, sessionId, model: opened.model, thinking: opened.thinking, restarted: false };
}
