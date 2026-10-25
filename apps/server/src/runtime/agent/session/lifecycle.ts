import { withWorkspaceAdmission } from "../../workspace/workspace-lifecycle.js";
import type { PiConfig, SessionState, SessionStats } from "@pi-science/contracts";
import { unlink } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../../../storage/persistence.js";
import type { RuntimeResult } from "../agent-runtime-types.js";
import type { Live } from "./types.js";
import { identity, configPath, failed } from "./identity.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "approvalRetirements" | "command" | "deleteOnce" | "events" | "forkAdmitted" | "hooks" | "live" | "manager" | "opening" | "recovering" | "recoveryTimers" | "registry" | "repository" | "stopForReload" | "stopping" | "withMutation">;

export async function reloadConfiguration(context: Context): Promise<void> {
  await Promise.allSettled(context.opening.values());
  for (const item of [...context.live.values()]) {
    if (item.busy) item.restartPending = true;
    else await context.stopForReload(item);
  }
}

export async function stopForReload(context: Context, item: Live): Promise<void> {
  if (context.live.get(identity(item.runtime.cwd, item.runtime.sessionId)) !== item) return;
  item.restartPending = false;
  item.suppressRecovery = true;
  if (item.watchdog) clearTimeout(item.watchdog);
  context.events.expectExit(item.runtime);
  await context.manager.stop(item.key);
  context.live.delete(identity(item.runtime.cwd, item.runtime.sessionId));
}

export async function resume(context: Context, cwd: string, sessionId: string, config: PiConfig): Promise<RuntimeResult> {
  return context.command(cwd, sessionId, "get_state", {}, config);
}

export async function state(context: Context, cwd: string, sessionId: string, config: PiConfig): Promise<SessionState | { error: string; code: string }> {
  if ((await context.registry.get(cwd, sessionId))?.state === "deleted") return { error: "session was deleted", code: "not_found" };
  const current = context.live.get(identity(cwd, sessionId));
  if (!current || current.runtime.isClosed) {
    if (!(await context.repository.findPath(cwd, sessionId))) return { error: "session not found in this workspace", code: "not_found" };
    const saved = await context.repository.configuration(cwd, sessionId);
    const facts = await context.repository.runtimeState(cwd, sessionId);
    return { id: sessionId, cwd, is_streaming: false, is_compacting: false, pending_message_count: 0,
      model: saved?.model ? `${saved.model.provider}/${saved.model.modelId}` : config.model ?? null,
      thinking: saved?.thinkingLevel ?? config.thinking ?? null,
      ...facts };
  }
  const result = await current.runtime.sendCommand("get_state").catch(failed);
  if (!result.success) return { error: String(result.error), code: String(result.code) };
  const data = result.data;
  if (!data) return { error: "Worker returned no snapshot", code: "invalid_ipc" };
  const model = data.model;
  const operation = data.operation;
  return { id: sessionId, cwd, is_streaming: Boolean(data.busy), is_compacting: operation?.kind === "compaction",
    pending_message_count: Array.isArray(data.queues) ? data.queues.length : 0,
    mcp_diagnostics: data.mcpDiagnostics ?? [],
    model: model?.provider && model.modelId ? `${model.provider}/${model.modelId}` : current.model,
    thinking: typeof data.thinkingLevel === "string" ? data.thinkingLevel : current.thinking,
    context_tokens: typeof data.context_tokens === "number" ? data.context_tokens : null,
    context_window: typeof data.context_window === "number" ? data.context_window : null,
    context_percent: typeof data.context_percent === "number" ? data.context_percent : null,
    compaction_enabled: data.compaction.enabled,
    compaction_threshold_percent: typeof data.compaction_threshold_percent === "number" ? data.compaction_threshold_percent : null };
}

export async function fork(context: Context, cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult> {
  return withWorkspaceAdmission(cwd, () => context.forkAdmitted(cwd, sessionId, entryId, config)).catch(failed);
}

export async function forkAdmitted(context: Context, cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult> {
  const result = await context.command(cwd, sessionId, entryId ? "fork" : "clone", entryId ? { entryId } : {}, config);
  if (result.success && typeof result.sessionId === "string") {
    const saved = await readJson<Pick<PiConfig, "skills" | "model_context_window_override"> | null>(configPath(cwd, sessionId), null);
    await writeJsonAtomic(configPath(cwd, result.sessionId), { skills: saved?.skills ?? config.skills,
      model_context_window_override: saved?.model_context_window_override ?? config.model_context_window_override });
    const path = await context.repository.findPath(cwd, result.sessionId);
    if (path) await context.registry.register(cwd, result.sessionId, path);
  }
  return result;
}

export async function stats(context: Context, cwd: string, sessionId: string): Promise<{ stats: SessionStats } | { error: string; code: string }> {
  const stats = await context.repository.stats(cwd, sessionId);
  return stats ? { stats: await context.hooks.stats?.(cwd, sessionId, stats) ?? stats } : { error: "session not found in this workspace", code: "not_found" };
}

export async function deleteSession(context: Context, cwd: string, sessionId: string): Promise<RuntimeResult> {
  return context.withMutation(cwd, sessionId, () => context.deleteOnce(cwd, sessionId));
}

export async function deleteOnce(context: Context, cwd: string, sessionId: string): Promise<RuntimeResult> {
  const key = identity(cwd, sessionId);
  if (context.approvalRetirements.has(key)) return { success: false, code: "permission_transition_failed", error: "Finish capability revocation before deleting the session" };
  const live = context.live.get(key);
  if (live?.busy) return { success: false, code: "busy", error: "cannot delete a conversation while it is running" };
  if (live && !live.runtime.isClosed) {
    const snapshot = await live.runtime.sendCommand("get_state").catch(failed);
    if (!snapshot.success) return snapshot;
    if (snapshot.data?.busy) return { success: false, code: "busy", error: "cannot delete a conversation while it is running" };
  }
  const registered = await context.registry.get(cwd, sessionId);
  const path = registered?.target ?? await context.repository.findPath(cwd, sessionId);
  if (!path) return { success: false, code: "not_found", error: "session not found in this workspace" };
  try {
    // Commit deletion before cleanup: retries and server restarts must never
    // rediscover an imported transcript through its retained legacy source.
    await context.registry.markDeleted(cwd, sessionId, path);
    if (live) { live.suppressRecovery = true; context.events.expectExit(live.runtime); await context.manager.stop(live.key); context.live.delete(key); }
    const remove = async (file: string) => { await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); };
    await remove(path);
    await remove(configPath(cwd, sessionId));
    return { success: true };
  } catch (error) { return { success: false, code: "delete_failed", error: String(error) }; }
}

export async function shutdownAll(context: Context): Promise<void> {
  context.stopping = true;
  for (const timer of context.recoveryTimers.values()) clearTimeout(timer);
  context.recoveryTimers.clear();
  for (const item of context.live.values()) if (item.watchdog) clearTimeout(item.watchdog);
  await Promise.allSettled(context.recovering.values());
  for (const item of context.live.values()) context.events.expectExit(item.runtime);
  await context.manager.shutdownAll();
  context.live.clear();
  await context.events.flush();
}
