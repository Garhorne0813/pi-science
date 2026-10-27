import { sessionApprovalPath } from "../../sandbox/session-approval.js";
import type { CreateSessionRequest } from "@pi-science/contracts";
import { withWorkspaceAdmission, WorkspaceLifecycleBusyError } from "../../workspace/workspace-lifecycle.js";
import type { PiConfig } from "@pi-science/contracts";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { observeAgentEvent } from "../../events/agent-event-observer.js";
import { metadataRoot, readJson, writeJsonAtomic } from "../../../storage/persistence.js";
import type { AgentCoreRuntimeClient } from "../agent-runtime-client.js";
import type { RuntimeResult } from "../agent-runtime-types.js";
import { seedWorkspaceAssets } from "../runtime-config.js";
import type { Live } from "./types.js";
import { identity, OPERATION_PROGRESS_EVENTS, configPath, splitModel, thinking, failed } from "./identity.js";
import { systemPrompt, globalSkillPolicy } from "./resource-policy.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "approvalRetirements" | "attach" | "beforeStart" | "createAdmitted" | "credentialEnvNames" | "events" | "hooks" | "live" | "manager" | "openOnce" | "opening" | "recover" | "recoveryAttempts" | "registry" | "repository" | "scheduleWatchdog" | "stopForReload" | "stopping" | "turns" | "workerEnvironment">;

export async function create(context: Context, cwd: string, config: PiConfig, initialApproval?: CreateSessionRequest["initialApproval"]): Promise<{ id: string } | { error: string; code: string }> {
  try { return await withWorkspaceAdmission(cwd, () => context.createAdmitted(cwd, config, initialApproval)); }
  catch (error) { if (error instanceof WorkspaceLifecycleBusyError) return { error: error.message, code: "busy" }; throw error; }
}

export async function createAdmitted(context: Context, cwd: string, config: PiConfig, initialApproval?: CreateSessionRequest["initialApproval"]): Promise<{ id: string } | { error: string; code: string }> {
  const model = splitModel(config.model);
  if (!model) return { error: "An agent-core session requires a provider/model setting", code: "invalid_model" };
  try {
    await context.beforeStart?.(cwd);
    seedWorkspaceAssets(cwd);
    const key = randomUUID();
    const runtime = await context.manager.start(key, {
      cwd,
      sessionsRoot: join(metadataRoot(cwd), "agent-sessions"),
      initialApproval,
      model,
      thinking: thinking(config.thinking),
      settings: config,
      systemPrompt: await systemPrompt(),
      skillPaths: config.skills,
      skillPolicy: await globalSkillPolicy(),
      env: await context.workerEnvironment(cwd),
      credentialEnvNames: await context.credentialEnvNames(cwd),
      deferActivation: true,
    });
    try {
      await writeJsonAtomic(configPath(cwd, runtime.sessionId), { skills: config.skills, model_context_window_override: config.model_context_window_override });
      const path = await context.repository.findPath(cwd, runtime.sessionId);
      if (!path) throw new Error("created agent session has no durable transcript");
      await context.registry.register(cwd, runtime.sessionId, path);
      await context.attach(key, runtime, config.model!, config.thinking ?? null, config);
      return { id: runtime.sessionId };
    } catch (error) {
      await context.manager.stop(key);
      context.live.delete(identity(cwd, runtime.sessionId));
      const path = await context.repository.findPath(cwd, runtime.sessionId);
      if (path) { await context.registry.markDeleted(cwd, runtime.sessionId, path); await unlink(path); }
      await unlink(configPath(cwd, runtime.sessionId)).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "ENOENT") throw failure; });
      await unlink(await sessionApprovalPath(cwd, runtime.sessionId)).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "ENOENT") throw failure; });
      throw error;
    }
  } catch (error) { return { error: String(error), code: "spawn_failed" }; }
}

export async function attach(context: Context, key: string, runtime: AgentCoreRuntimeClient, model: string, level: string | null, config: PiConfig): Promise<Live> {
  const item: Live = { key, runtime, busy: false, restartPending: false, model, thinking: level, config, eventSequence: 0, lastProgressAt: Date.now() };
  context.live.set(identity(runtime.cwd, runtime.sessionId), item);
  runtime.on("event", (event) => {
    if (typeof event.runtime_sequence === "number") item.eventSequence = event.runtime_sequence;
    if (event.type === "operation.started" && typeof event.runId === "string" && item.expectedOperationId !== event.runId) {
      item.expectedOperationId = event.runId;
      item.lastProgressAt = Date.now();
      item.interactionWaitStartedAt = undefined;
    }
    if (event.runId === item.expectedOperationId && OPERATION_PROGRESS_EVENTS.has(event.type)) {
      item.lastProgressAt = Date.now();
      if (item.interactionWaitStartedAt !== undefined) item.interactionWaitStartedAt = item.lastProgressAt;
    }
    if (event.type === "interaction.requested") item.interactionWaitStartedAt ??= Date.now();
    if (event.type === "operation.settled") {
      item.expectedOperationId = undefined;
      item.interactionWaitStartedAt = undefined;
      context.recoveryAttempts.delete(identity(runtime.cwd, runtime.sessionId));
    }
    context.scheduleWatchdog(item);
  });
  context.events.bind(runtime.cwd, runtime, {
    activeSessionId: () => runtime.sessionId,
    observe: async (event, sessionId, turn) => {
      context.hooks.observe?.(runtime.cwd, sessionId, event);
      await observeAgentEvent(runtime.cwd, item.model, event, sessionId,
        (payload) => context.events.publish(runtime.cwd, sessionId, payload));
      if (await context.turns.observe(runtime.cwd, sessionId, event, turn)) {
        context.hooks.settled?.(runtime.cwd, sessionId, String(event.runId));
      }
      if (["message.completed", "tool.completed", "operation.settled"].includes(event.type)) {
        const stats = await context.repository.stats(runtime.cwd, sessionId);
        if (stats) await context.events.publish(runtime.cwd, sessionId, { type: "session.stats", sessionId,
          stats: await context.hooks.stats?.(runtime.cwd, sessionId, stats) ?? stats });
      }
    },
    onBusy: (busy) => {
      item.busy = busy;
      context.scheduleWatchdog(item);
      if (!busy && item.restartPending) void context.stopForReload(item).catch((error) =>
        context.events.publish(runtime.cwd, runtime.sessionId, { type: "error", message: `Settings reload failed: ${String(error)}` }));
    },
    onExit: () => {
      if (item.watchdog) clearTimeout(item.watchdog);
      if (context.live.get(identity(runtime.cwd, runtime.sessionId)) === item) context.live.delete(identity(runtime.cwd, runtime.sessionId));
      if (item.expectedOperationId && !item.suppressRecovery && !context.stopping) queueMicrotask(() => { void context.recover(item); });
    },
  });
  try {
    // No drive or recovery starts until this snapshot has been applied. All
    // subsequent state changes arrive through the already-bound event stream.
    const snapshot = await runtime.sendCommand("get_state");
    if (!snapshot.success) throw new Error(String(snapshot.error));
    const data = snapshot.data;
    if (!data) throw new Error("Worker returned no snapshot");
    item.busy = Boolean(data.busy);
    item.expectedOperationId = data.operation?.id;
    item.lastProgressAt = Date.now(); // The deferred worker has not started driving yet.
    if (data.pendingInteraction) item.interactionWaitStartedAt = Date.now();
    if (data.model) item.model = `${data.model.provider}/${data.model.modelId}`;
    if (data.thinkingLevel) item.thinking = data.thinkingLevel;
    if (!data.busy && data.lastResult && await context.turns.unfinished(runtime.cwd, runtime.sessionId, data.lastResult.operationId)) {
      runtime.emit("event", { type: "operation.started", runId: data.lastResult.operationId, turnId: data.lastResult.operationId, recovery: true });
      runtime.emit("event", { type: "operation.settled", runId: data.lastResult.operationId, status: data.lastResult.status, recovery: true });
    }
    const activated = await runtime.sendCommand("activate");
    if (!activated.success) throw new Error(String(activated.error));
    context.scheduleWatchdog(item);
  } catch (error) {
    item.suppressRecovery = true;
    context.events.expectExit(runtime);
    await context.manager.stop(key);
    context.live.delete(identity(runtime.cwd, runtime.sessionId));
    throw error;
  }
  return item;
}

export async function open(context: Context, cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult> {
  if ((await context.registry.get(cwd, sessionId))?.state === "deleted") return { success: false, code: "not_found", error: "session was deleted" };
  const key = identity(cwd, sessionId);
  if (context.approvalRetirements.has(key)) return { success: false, code: "permission_transition_failed", error: "Retry the approval change to finish revoking old capabilities" };
  // attach() exposes the live record while binding. Even abort must wait for
  // activation before it can change a recovered operation's lifecycle.
  const pending = context.opening.get(key);
  if (pending) return pending;
  const current = context.live.get(key);
  if (current && !current.runtime.isClosed) return current;
  const started = context.openOnce(cwd, sessionId, config);
  context.opening.set(key, started);
  try { return await started; }
  finally { if (context.opening.get(key) === started) context.opening.delete(key); }
}

export async function openOnce(context: Context, cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult> {
  const key = identity(cwd, sessionId);
  const path = await context.repository.findPath(cwd, sessionId);
  if (!path) return { success: false, code: "not_found", error: "session not found in this workspace" };
  const saved = await readJson<Pick<PiConfig, "skills" | "model_context_window_override"> | null>(configPath(cwd, sessionId), null);
  const persisted = await context.repository.configuration(cwd, sessionId);
  // Legacy sessions without a lane model inherit the current default until
  // Core persists a model; unavailable saved models never use this fallback.
  const model = persisted?.model ?? splitModel(config.model);
  if (!model) return { success: false, code: "invalid_model", error: "An agent-core session requires a provider/model setting" };
  try {
    await context.beforeStart?.(cwd);
    seedWorkspaceAssets(cwd);
    await context.registry.register(cwd, sessionId, path);
    const runtime = await context.manager.start(key, {
      cwd,
      sessionId,
      sessionsRoot: join(metadataRoot(cwd), "agent-sessions"),
      model,
      thinking: thinking(persisted?.thinkingLevel ?? config.thinking),
      settings: { ...config, model_context_window_override: config.model_context_window_override?.model === `${model.provider}/${model.modelId}`
        ? config.model_context_window_override : saved?.model_context_window_override },
      systemPrompt: await systemPrompt(),
      skillPaths: saved?.skills ?? config.skills,
      skillPolicy: await globalSkillPolicy(),
      env: await context.workerEnvironment(cwd),
      credentialEnvNames: await context.credentialEnvNames(cwd),
      deferActivation: true,
    });
    return await context.attach(key, runtime, `${model.provider}/${model.modelId}`, persisted?.thinkingLevel ?? config.thinking ?? null, config);
  } catch (error) { return failed(error); }
}
