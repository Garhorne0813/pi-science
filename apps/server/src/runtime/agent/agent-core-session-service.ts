import type { PiConfig, SessionState, SessionStats } from "@pi-science/contracts";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { observeNodePiEvent } from "../events/node-event-observer.js";
import { configPath as globalConfigPath, metadataRoot, readJson, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { RuntimeResult, RuntimeSkillPolicy } from "./agent-runtime-types.js";
import type { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { seedWorkspaceAssets } from "../pi/pi-runtime-launch.js";

type Live = { key: string; runtime: AgentCoreRuntimeClient; busy: boolean; restartPending: boolean; model: string; thinking: string | null };

function identity(cwd: string, id: string): string { return `${resolve(cwd)}\0${id}`; }
function configPath(cwd: string, sessionId: string): string {
  return workspaceFile(cwd, `agent-session-config/${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
const SYSTEM_PROMPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../harness/AGENTS.md");
async function systemPrompt(): Promise<string> {
  return readFile(SYSTEM_PROMPT_PATH, "utf8");
}
async function globalSkillPolicy(): Promise<RuntimeSkillPolicy> {
  const settings = await readJson<{ skill_policy?: RuntimeSkillPolicy }>(globalConfigPath("config.json"), {});
  const policy = settings.skill_policy;
  if (policy?.mode === "inherit" || policy?.mode === "none") return { mode: policy.mode };
  if ((policy?.mode === "allowlist" || policy?.mode === "denylist") && Array.isArray(policy.skills)) {
    return { mode: policy.mode, skills: policy.skills.filter((name): name is string => typeof name === "string") };
  }
  return { mode: "inherit" };
}
function splitModel(model: string | null | undefined): { provider: string; modelId: string } | null {
  const index = model?.indexOf("/") ?? -1;
  return index > 0 && index < model!.length - 1 ? { provider: model!.slice(0, index), modelId: model!.slice(index + 1) } : null;
}
function thinking(value: string | null | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return value && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value as ReturnType<typeof thinking> : "high";
}
function failed(error: unknown): RuntimeResult {
  return { success: false, code: "agent_runtime_error", error: error instanceof Error ? error.message : String(error) };
}

/** Development rollout path: one AgentHarness worker per v4 session. */
export class AgentCoreSessionService {
  private readonly manager = new AgentRuntimeManager();
  private readonly repository = new AgentSessionRepository();
  private readonly live = new Map<string, Live>();
  private readonly opening = new Map<string, Promise<Live | RuntimeResult>>();
  private beforeStart: ((cwd: string) => Promise<void>) | null = null;

  constructor(
    private readonly events: ConversationEventHub,
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
    private readonly server: { backendUrl?: string; internalToken?: string } = {},
  ) {}

  configureBeforeStart(hook: ((cwd: string) => Promise<void>) | null): void { this.beforeStart = hook; }

  private async workerEnvironment(cwd: string): Promise<Record<string, string>> {
    const environment = await this.environments.environment(cwd);
    return {
      ...environment,
      ...(this.server.backendUrl ? { PI_SCIENCE_BACKEND_URL: this.server.backendUrl } : {}),
      ...(this.server.internalToken ? { PI_SCIENCE_INTERNAL_TOKEN: this.server.internalToken } : {}),
    } as Record<string, string>;
  }

  async owns(cwd: string, sessionId: string): Promise<boolean> {
    return this.live.has(identity(cwd, sessionId)) || (await this.repository.findPath(cwd, sessionId)) !== null;
  }

  /** Copies a Pi v3 transcript, then lets JsonlSessionRepo upgrade the copy on its first write. */
  async importLegacy(cwd: string, sessionId: string, source: string, config: PiConfig): Promise<RuntimeResult> {
    if (await this.owns(cwd, sessionId)) return { success: true };
    const handle = await open(source, "r");
    let firstLine = "";
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    } finally { await handle.close(); }
    let header: { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
    try { header = JSON.parse(firstLine) as typeof header; }
    catch { return { success: false, code: "legacy_session_invalid", error: "legacy session header is invalid" }; }
    if (header.type !== "session" || header.version !== 3 || header.id !== sessionId || header.cwd !== cwd) {
      return { success: false, code: "legacy_session_unsupported", error: "only workspace-local Pi v3 sessions can be imported" };
    }
    const directory = join(metadataRoot(cwd), "agent-sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}_${encodeURIComponent(sessionId)}.jsonl`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary);
      await rename(temporary, destination);
      await writeJsonAtomic(configPath(cwd, sessionId), { model: config.model, thinking: config.thinking, skills: config.skills });
      const opened = await this.open(cwd, sessionId, config);
      if ("success" in opened) throw new Error(String(opened.error));
      return { success: true };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      await unlink(configPath(cwd, sessionId)).catch(() => undefined);
      return { success: false, code: "legacy_import_failed", error: String(error) };
    }
  }

  liveSessions(cwd: string): Array<{ id: string; cwd: string }> {
    return [...this.live.values()].filter((item) => item.runtime.cwd === cwd && !item.runtime.isClosed)
      .map((item) => ({ id: item.runtime.sessionId, cwd }));
  }

  liveRuntime(cwd: string, expectedModel?: string): AgentCoreRuntimeClient | null {
    return [...this.live.values()].find((item) => item.runtime.cwd === cwd && !item.runtime.isClosed
      && (!expectedModel || item.model === expectedModel))?.runtime ?? null;
  }

  async create(cwd: string, config: PiConfig): Promise<{ id: string } | { error: string; code: string }> {
    const model = splitModel(config.model);
    if (!model) return { error: "An agent-core session requires a provider/model setting", code: "invalid_model" };
    try {
      await this.beforeStart?.(cwd);
      seedWorkspaceAssets(cwd);
      const key = randomUUID();
      const runtime = await this.manager.start(key, {
        cwd,
        sessionsRoot: join(metadataRoot(cwd), "agent-sessions"),
        model,
        thinking: thinking(config.thinking),
        systemPrompt: await systemPrompt(),
        skillPaths: config.skills,
        skillPolicy: await globalSkillPolicy(),
        env: await this.workerEnvironment(cwd),
      });
      try { await writeJsonAtomic(configPath(cwd, runtime.sessionId), { model: config.model, thinking: config.thinking, skills: config.skills }); }
      catch (error) { await this.manager.stop(key); throw error; }
      this.attach(key, runtime, config.model!, config.thinking ?? null);
      return { id: runtime.sessionId };
    } catch (error) { return { error: String(error), code: "spawn_failed" }; }
  }

  private attach(key: string, runtime: AgentCoreRuntimeClient, model: string, level: string | null): Live {
    const item: Live = { key, runtime, busy: false, restartPending: false, model, thinking: level };
    this.live.set(identity(runtime.cwd, runtime.sessionId), item);
    this.events.bind(runtime.cwd, runtime, {
      activeSessionId: () => runtime.sessionId,
      observe: async (event, sessionId) => {
        await observeNodePiEvent(runtime.cwd, item.model, event, sessionId,
          (payload) => this.events.publish(runtime.cwd, sessionId, payload));
        if (event.type === "agent_settled") {
          const stats = await this.repository.stats(runtime.cwd, sessionId);
          if (stats) await this.events.publish(runtime.cwd, sessionId, { type: "session.stats", sessionId, stats });
        }
      },
      onBusy: (busy) => {
        item.busy = busy;
        if (!busy && item.restartPending) void this.stopForReload(item);
      },
      onExit: () => { this.live.delete(identity(runtime.cwd, runtime.sessionId)); },
    });
    return item;
  }

  private async open(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult> {
    const key = identity(cwd, sessionId);
    const current = this.live.get(key);
    if (current && !current.runtime.isClosed) return current;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const started = this.openOnce(cwd, sessionId, config);
    this.opening.set(key, started);
    try { return await started; }
    finally { if (this.opening.get(key) === started) this.opening.delete(key); }
  }

  private async openOnce(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult> {
    const key = identity(cwd, sessionId);
    if (!(await this.repository.findPath(cwd, sessionId))) return { success: false, code: "not_found", error: "session not found in this workspace" };
    const saved = await readJson<{ model?: string; thinking?: string; skills?: string[] } | null>(configPath(cwd, sessionId), null);
    const model = splitModel(saved?.model ?? config.model);
    if (!model) return { success: false, code: "invalid_model", error: "An agent-core session requires a provider/model setting" };
    try {
      await this.beforeStart?.(cwd);
      seedWorkspaceAssets(cwd);
      const runtime = await this.manager.start(key, {
        cwd,
        sessionId,
        sessionsRoot: join(metadataRoot(cwd), "agent-sessions"),
        model,
        thinking: thinking(saved?.thinking ?? config.thinking),
        systemPrompt: await systemPrompt(),
        skillPaths: saved?.skills ?? config.skills,
        skillPolicy: await globalSkillPolicy(),
        env: await this.workerEnvironment(cwd),
      });
      return this.attach(key, runtime, saved?.model ?? config.model!, saved?.thinking ?? config.thinking ?? null);
    } catch (error) { return failed(error); }
  }

  async command(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> {
    const opened = await this.open(cwd, sessionId, config);
    if ("success" in opened) return opened;
    try { return await opened.runtime.sendCommand(type, params); }
    catch (error) { return failed(error); }
  }

  async notify(cwd: string, sessionId: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult> {
    const current = this.live.get(identity(cwd, sessionId));
    if (!current || current.runtime.isClosed) return { success: false, code: "not_found", error: "active agent worker not found" };
    try {
      await current.runtime.sendNotification(type, params);
      if (type === "extension_ui_response" && typeof params.id === "string") {
        this.events.resolvePendingInteraction(cwd, sessionId, params.id);
      }
      return { success: true };
    } catch (error) { return failed(error); }
  }

  async setGlobalSkillPolicy(policy: RuntimeSkillPolicy): Promise<void> {
    for (const item of this.live.values()) {
      const result = await item.runtime.setSkillPolicy(policy);
      if (!result.success) throw new Error(String(result.error ?? "unable to update agent skills"));
    }
  }

  async refreshAllSkills(): Promise<void> {
    for (const item of this.live.values()) {
      const result = await item.runtime.refreshSkills();
      if (!result.success) throw new Error(String(result.error ?? "unable to refresh agent skills"));
    }
  }

  /** Rebuilds idle workers with current MCP and environment settings; active turns finish first. */
  async reloadConfiguration(): Promise<void> {
    await Promise.allSettled(this.opening.values());
    for (const item of [...this.live.values()]) {
      if (item.busy) item.restartPending = true;
      else await this.stopForReload(item);
    }
  }

  private async stopForReload(item: Live): Promise<void> {
    if (this.live.get(identity(item.runtime.cwd, item.runtime.sessionId)) !== item) return;
    item.restartPending = false;
    this.events.expectExit(item.runtime);
    await this.manager.stop(item.key);
    this.live.delete(identity(item.runtime.cwd, item.runtime.sessionId));
  }

  async resume(cwd: string, sessionId: string, config: PiConfig): Promise<RuntimeResult> {
    const opened = await this.open(cwd, sessionId, config);
    if ("success" in opened) return opened;
    return opened.runtime.sendCommand("get_state");
  }

  async state(cwd: string, sessionId: string, config: PiConfig): Promise<SessionState | { error: string; code: string }> {
    const current = this.live.get(identity(cwd, sessionId));
    if (!current || current.runtime.isClosed) {
      if (!(await this.repository.findPath(cwd, sessionId))) return { error: "session not found in this workspace", code: "not_found" };
      const saved = await readJson<{ model?: string; thinking?: string } | null>(configPath(cwd, sessionId), null);
      return { id: sessionId, cwd, is_streaming: false, is_compacting: false, pending_message_count: 0,
        model: saved?.model ?? config.model ?? null, thinking: saved?.thinking ?? config.thinking ?? null, context_tokens: null,
        context_window: null, context_percent: null, compaction_enabled: config.compaction_enabled !== false,
        compaction_threshold_percent: config.compaction_threshold_percent ?? null };
    }
    const result = await current.runtime.sendCommand("get_state").catch(failed);
    if (!result.success) return { error: String(result.error), code: String(result.code) };
    const data = result.data as Record<string, unknown>;
    const model = data.model as { provider?: string; modelId?: string } | undefined;
    const operation = data.operation as { kind?: string } | null;
    return { id: sessionId, cwd, is_streaming: Boolean(data.busy), is_compacting: operation?.kind === "compaction",
      pending_message_count: Array.isArray(data.queues) ? data.queues.length : 0,
      model: model?.provider && model.modelId ? `${model.provider}/${model.modelId}` : current.model,
      thinking: typeof data.thinkingLevel === "string" ? data.thinkingLevel : current.thinking,
      context_tokens: null, context_window: null, context_percent: null,
      compaction_enabled: config.compaction_enabled !== false,
      compaction_threshold_percent: config.compaction_threshold_percent ?? null };
  }

  async configure(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> {
    const ref = splitModel(model);
    if (!ref) return { success: false, code: "invalid_model", error: "Model must use provider/model notation" };
    const opened = await this.open(cwd, sessionId, config);
    if ("success" in opened) return opened;
    const result = await opened.runtime.sendCommand("set_model", ref).catch(failed);
    if (!result.success) return result;
    if (level) {
      const changed = await opened.runtime.sendCommand("set_thinking_level", { level }).catch(failed);
      if (!changed.success) return changed;
    }
    opened.model = model;
    opened.thinking = level ?? opened.thinking;
    const saved = await readJson<{ skills?: string[] } | null>(configPath(cwd, sessionId), null);
    await writeJsonAtomic(configPath(cwd, sessionId), { model, thinking: opened.thinking, skills: saved?.skills ?? config.skills });
    return { success: true, sessionId, model, thinking: opened.thinking, restarted: false };
  }

  async fork(cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult> {
    const result = await this.command(cwd, sessionId, entryId ? "fork" : "clone", entryId ? { entryId } : {}, config);
    if (result.success && typeof result.sessionId === "string") {
      const saved = await readJson<{ model?: string; thinking?: string; skills?: string[] } | null>(configPath(cwd, sessionId), null);
      await writeJsonAtomic(configPath(cwd, result.sessionId), saved ?? { model: config.model, thinking: config.thinking, skills: config.skills });
    }
    return result;
  }

  async stats(cwd: string, sessionId: string): Promise<{ stats: SessionStats } | { error: string; code: string }> {
    const stats = await this.repository.stats(cwd, sessionId);
    return stats ? { stats } : { error: "session not found in this workspace", code: "not_found" };
  }

  async delete(cwd: string, sessionId: string): Promise<RuntimeResult> {
    const key = identity(cwd, sessionId);
    const live = this.live.get(key);
    if (live?.busy) return { success: false, code: "busy", error: "cannot delete a conversation while it is running" };
    if (live) { this.events.expectExit(live.runtime); await this.manager.stop(live.key); this.live.delete(key); }
    const path = await this.repository.findPath(cwd, sessionId);
    if (!path) return { success: false, code: "not_found", error: "session not found in this workspace" };
    await unlink(path);
    await unlink(configPath(cwd, sessionId)).catch(() => undefined);
    return { success: true };
  }

  async shutdownAll(): Promise<void> {
    for (const item of this.live.values()) this.events.expectExit(item.runtime);
    await this.manager.shutdownAll();
    this.live.clear();
  }

  get processCount(): number { return this.manager.processCount; }
}
