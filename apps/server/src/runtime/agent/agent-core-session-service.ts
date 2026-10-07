import type { PiConfig, SessionState, SessionStats } from "@pi-science/contracts";
import { createHash, randomUUID } from "node:crypto";
import { workspaceIdentity } from "./workspace-session-identity.js";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { observeAgentEvent } from "../events/agent-event-observer.js";
import { configPath as globalConfigPath, metadataRoot, readJson, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { RuntimeResult, RuntimeSkillPolicy } from "./agent-runtime-types.js";
import type { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { seedWorkspaceAssets } from "../agent/runtime-config.js";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { projectedEnvironmentNames } from "../shared/extensions/pi-science-mcp.js";
import { AgentRuntimeCapacityError, AgentRuntimeExitedError, AgentRuntimeTimeoutError } from "./agent-runtime-errors.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { DurableTurnLifecycle } from "../artifacts/turn-lifecycle.js";
import { promptOperationId } from "./agent-message.js";
import { isAiTitlePrompt } from "../title/title-prompt.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

type Live = { key: string; runtime: AgentCoreRuntimeClient; busy: boolean; restartPending: boolean; model: string; thinking: string | null;
  config: PiConfig; eventSequence: number; expectedOperationId?: string; watchdog?: NodeJS.Timeout; suppressRecovery?: boolean;
  lastProgressAt: number; interactionWaitStartedAt?: number;
  reload?: Promise<void> };
type ProductHooks = {
  observe?: (cwd: string, sessionId: string, event: Record<string, unknown>) => void;
  settled?: (cwd: string, sessionId: string, turnId: string) => void;
  stats?: (cwd: string, sessionId: string, stats: SessionStats) => Promise<SessionStats>;
};

function identity(cwd: string, id: string): string { return `${workspaceIdentity(cwd)}\0${id}`; }
const OPERATION_PROGRESS_EVENTS = new Set([
  "model.turn.started", "message.started", "message.updated", "message.completed",
  "tool.started", "tool.updated", "tool.completed", "compaction.start", "compaction.end",
  "retry.start", "retry.update", "retry.end",
]);
function noProgressTimeoutMs(): number {
  const value = Number(process.env.PI_SCIENCE_OPERATION_NO_PROGRESS_MS ?? 15 * 60_000);
  return Number.isFinite(value) && value > 0 ? value : 15 * 60_000;
}
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
function failed(error: unknown): RuntimeResult<never> {
  const code = error instanceof AgentRuntimeTimeoutError ? "timeout"
    : error instanceof AgentRuntimeExitedError ? "process_exit"
    : error instanceof AgentRuntimeCapacityError ? "runtime_capacity_exceeded"
    : "runtime_command_failed";
  return { success: false, code, error: error instanceof Error ? error.message : String(error) };
}

/** The live-map key of a record. item.key is the runtime manager's key, which is a
 *  generated id for a created session rather than the identity, so it cannot address
 *  the live map or anything keyed like it. */
function liveKey(item: Live): string {
  return identity(item.runtime.cwd, item.runtime.sessionId);
}

/** A deferred model change that could not be applied. The code is the worker's
 *  own failure code where it has one, so the caller answers the real condition. */
class ReloadFailedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReloadFailedError";
  }
}

/** Re-publishes the terminal fact of an operation whose event was lost. A
 *  compaction produces no turn, so its settle must say so, or the hub reports
 *  the recovery as an empty model response. */
function emitRecoveredSettle(runtime: AgentCoreRuntimeClient, runId: string, kind: string | undefined, status: string): void {
  if (kind === "compaction") runtime.emit("event", { type: status === "failed" ? "compaction.error" : "compaction.end", runId, message: "" });
  runtime.emit("event", { type: "operation.settled", runId, status, recovery: true,
    ...(kind === "compaction" ? { handledWithoutTurn: true } : {}) });
}

/** One AgentHarness worker per v4 session. */
export class AgentCoreSessionService {
  private readonly manager = new AgentRuntimeManager();
  private readonly repository = new AgentSessionRepository();
  private readonly registry = new AgentSessionRegistry();
  private readonly live = new Map<string, Live>();
  private readonly opening = new Map<string, Promise<Live | RuntimeResult>>();
  /** The model each session must move to, keyed by workspace identity. It lives
   *  here rather than on the Live record because the worker can exit, be replaced by
   *  recovery, or be reopened before the change lands, and the change has to outlive
   *  all of that. openOnce resolves it, so every reopen picks it up. */
  private readonly modelTargets = new Map<string, { model: string; thinking: string }>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private beforeStart: ((cwd: string) => Promise<void>) | null = null;
  private readonly turns: DurableTurnLifecycle;
  private hooks: ProductHooks = {};
  private readonly migrating = new Set<string>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private stopping = false;

  constructor(
    private readonly events: ConversationEventHub,
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
    private readonly server: { backendUrl?: string; internalToken?: string } = {},
  ) { this.turns = new DurableTurnLifecycle(events); }

  configureProductLifecycle(hooks: ProductHooks): void { this.hooks = hooks; }

  configureBeforeStart(hook: ((cwd: string) => Promise<void>) | null): void { this.beforeStart = hook; }

  private async workerEnvironment(cwd: string): Promise<Record<string, string>> {
    const environment = await this.environments.environment(cwd);
    return {
      ...environment,
      ...(this.server.backendUrl ? { PI_SCIENCE_BACKEND_URL: this.server.backendUrl } : {}),
      ...(this.server.internalToken ? { PI_SCIENCE_INTERNAL_TOKEN: this.server.internalToken } : {}),
    } as Record<string, string>;
  }

  private async credentialEnvNames(cwd: string): Promise<string[]> {
    const metadata = await new CredentialStore().listMetadata();
    return [...new Set([
      ...metadata.filter((item) => item.backend === "environment").map((item) => item.environment_variable).filter((name): name is string => Boolean(name)),
      ...projectedEnvironmentNames(cwd),
    ])];
  }

  async waitForMutation(cwd: string, sessionId: string): Promise<void> {
    await this.mutations.get(identity(cwd, sessionId))?.catch(() => undefined);
  }

  async owns(cwd: string, sessionId: string): Promise<boolean> {
    return Boolean(await this.registry.get(cwd, sessionId))
      || this.live.has(identity(cwd, sessionId)) || (await this.repository.findPath(cwd, sessionId)) !== null;
  }

  /** Ownership is durable and no conversion is still running. A conversion
   *  registers ownership before it finishes, so owns() alone is not readiness:
   *  a reader that trusted it could observe a half-converted session. */
  async ready(cwd: string, sessionId: string): Promise<boolean> {
    return !this.migrating.has(identity(cwd, sessionId)) && await this.owns(cwd, sessionId);
  }

  /** Copies a Pi v3 transcript, then lets JsonlSessionRepo upgrade the copy on its first write. */
  async importLegacy(cwd: string, sessionId: string, source: string, config: PiConfig, options: { activate?: boolean } = {}): Promise<RuntimeResult> {
    const key = identity(cwd, sessionId);
    this.migrating.add(key);
    try {
      return await this.withMutation(cwd, sessionId, () => this.importLegacyOnce(cwd, sessionId, source, config, options)).catch(failed);
    } finally { this.migrating.delete(key); }
  }

  private async importLegacyOnce(cwd: string, sessionId: string, source: string, config: PiConfig, options: { activate?: boolean }): Promise<RuntimeResult> {
    if ((await this.registry.get(cwd, sessionId))?.state === "deleted") return { success: false, code: "not_found", error: "session was deleted" };
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
    if (header.type !== "session" || header.version !== 3 || header.id !== sessionId || typeof header.cwd !== "string" || workspaceIdentity(header.cwd) !== workspaceIdentity(cwd)) {
      return { success: false, code: "legacy_session_unsupported", error: "only workspace-local Pi v3 sessions can be imported" };
    }
    const directory = join(metadataRoot(cwd), "agent-sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}_${encodeURIComponent(sessionId)}.jsonl`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary);
      // Validate the complete copied file before granting durable ownership.
      // Core tolerates damaged JSONL tails during ordinary crash recovery; an
      // explicit migration must reject corruption rather than silently drop it.
      const messageIds: string[] = [];
      let expectedMessages = 0;
      let hidden = relative(join(metadataRoot(cwd), "sessions"), source).split(/[/\\]/).slice(0, -1).some((part) => part.endsWith(".jsonl") || /^run-\d+$/.test(part) || /^(parallel|dynamic|async)-/.test(part));
      const ids = new Set<string>();
      const lines = createInterface({ input: createReadStream(temporary), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as { type?: string; id?: string; parentId?: string | null; name?: string; message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> } };
          if (entry.type === "session") continue;
          if (typeof entry.id !== "string" || ids.has(entry.id)) throw new Error("Legacy transcript has missing or duplicate entry IDs");
          if (entry.parentId && !ids.has(entry.parentId)) throw new Error("Legacy transcript has a missing parent entry");
          ids.add(entry.id);
          if (entry.type === "session_info" && entry.name?.startsWith("subagent-")) hidden = true;
          if (entry.message?.role === "user" && isAiTitlePrompt(typeof entry.message.content === "string" ? entry.message.content : (entry.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(""))) hidden = true;
          if (entry.type === "message" || entry.type === "custom_message") { expectedMessages++; messageIds.push(entry.id); }
        }
      } finally { lines.close(); }
      await rename(temporary, destination);
      const imported = await this.repository.messages(cwd, sessionId);
      if (imported.length !== expectedMessages) throw new Error("Legacy import did not preserve every message");
      await this.repository.upgradeLegacy(cwd, sessionId, source, messageIds);
      await this.repository.runtimeState(cwd, sessionId);
      await writeJsonAtomic(configPath(cwd, sessionId), { skills: config.skills, model_context_window_override: config.model_context_window_override });
      await this.registry.register(cwd, sessionId, destination, source, hidden ? { purpose: "subagent" } : undefined);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      await unlink(configPath(cwd, sessionId)).catch(() => undefined);
      return { success: false, code: "legacy_import_failed", error: String(error) };
    }
    // Copy/ownership are committed before starting a worker. An unavailable
    // model must not discard a completed migration or rediscover its backup.
    if (options.activate === false) return { success: true };
    const opened = await this.open(cwd, sessionId, config);
    return "success" in opened ? opened : { success: true };
  }

  liveSessions(cwd: string): Array<{ id: string; cwd: string }> {
    return [...this.live.values()].filter((item) => workspaceIdentity(item.runtime.cwd) === workspaceIdentity(cwd) && !item.runtime.isClosed)
      .map((item) => ({ id: item.runtime.sessionId, cwd }));
  }

  liveRuntime(cwd: string, expectedModel?: string): AgentCoreRuntimeClient | null {
    return [...this.live.values()].find((item) => workspaceIdentity(item.runtime.cwd) === workspaceIdentity(cwd) && !item.runtime.isClosed
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
        settings: config,
        systemPrompt: await systemPrompt(),
        skillPaths: config.skills,
        skillPolicy: await globalSkillPolicy(),
        env: await this.workerEnvironment(cwd),
        credentialEnvNames: await this.credentialEnvNames(cwd),
        deferActivation: true,
      });
      try {
        await writeJsonAtomic(configPath(cwd, runtime.sessionId), { skills: config.skills, model_context_window_override: config.model_context_window_override });
        const path = await this.repository.findPath(cwd, runtime.sessionId);
        if (!path) throw new Error("created agent session has no durable transcript");
        await this.registry.register(cwd, runtime.sessionId, path);
      }
      catch (error) { await this.manager.stop(key); throw error; }
      await this.attach(key, runtime, config.model!, config.thinking ?? null, config);
      return { id: runtime.sessionId };
    } catch (error) {
      // Keep the typed classification: one capacity condition must not answer 429
      // when reopening a session and 503 when creating one.
      return { error: String(error), code: error instanceof AgentRuntimeCapacityError ? "runtime_capacity_exceeded" : "spawn_failed" };
    }
  }

  private async attach(key: string, runtime: AgentCoreRuntimeClient, model: string, level: string | null, config: PiConfig): Promise<Live> {
    const item: Live = { key, runtime, busy: false, restartPending: false, model, thinking: level, config, eventSequence: 0, lastProgressAt: Date.now() };
    this.live.set(identity(runtime.cwd, runtime.sessionId), item);
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
        this.recoveryAttempts.delete(identity(runtime.cwd, runtime.sessionId));
      }
      this.scheduleWatchdog(item);
    });
    this.events.bind(runtime.cwd, runtime, {
      activeSessionId: () => runtime.sessionId,
      observe: async (event, sessionId, turn) => {
        this.hooks.observe?.(runtime.cwd, sessionId, event);
        await observeAgentEvent(runtime.cwd, item.model, event, sessionId,
          (payload) => this.events.publish(runtime.cwd, sessionId, payload));
        if (await this.turns.observe(runtime.cwd, sessionId, event, turn)) {
          this.hooks.settled?.(runtime.cwd, sessionId, String(event.runId));
        }
        if (["message.completed", "tool.completed", "operation.settled"].includes(event.type)) {
          const stats = await this.repository.stats(runtime.cwd, sessionId);
          if (stats) await this.events.publish(runtime.cwd, sessionId, { type: "session.stats", sessionId,
            stats: await this.hooks.stats?.(runtime.cwd, sessionId, stats) ?? stats });
        }
      },
      onBusy: (busy) => {
        item.busy = busy;
        this.scheduleWatchdog(item);
        if (!busy && item.restartPending) void this.stopForReload(item).catch((error) =>
          this.events.publish(runtime.cwd, runtime.sessionId, { type: "error", message: `Settings reload failed: ${String(error)}` }));
      },
      onExit: () => {
        if (item.watchdog) clearTimeout(item.watchdog);
        this.dropIfSettled(item);
        if (item.expectedOperationId && !item.suppressRecovery && !this.stopping) queueMicrotask(() => { void this.recover(item); });
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
      if (!data.busy && data.lastResult && await this.turns.unfinished(runtime.cwd, runtime.sessionId, data.lastResult.operationId)) {
        runtime.emit("event", { type: "operation.started", runId: data.lastResult.operationId, turnId: data.lastResult.operationId, recovery: true });
        emitRecoveredSettle(runtime, data.lastResult.operationId, data.lastResult.kind, data.lastResult.status);
      }
      const activated = await runtime.sendCommand("activate");
      if (!activated.success) throw new Error(String(activated.error));
      this.scheduleWatchdog(item);
    } catch (error) {
      item.suppressRecovery = true;
      this.events.expectExit(runtime);
      await this.manager.stop(key);
      this.live.delete(identity(runtime.cwd, runtime.sessionId));
      throw error;
    }
    return item;
  }

  private async open(cwd: string, sessionId: string, config: PiConfig, model?: { provider: string; modelId: string }): Promise<Live | RuntimeResult> {
    if ((await this.registry.get(cwd, sessionId))?.state === "deleted") return { success: false, code: "not_found", error: "session was deleted" };
    const key = identity(cwd, sessionId);
    // attach() exposes the live record while binding. Even abort must wait for
    // activation before it can change a recovered operation's lifecycle.
    const pending = this.opening.get(key);
    if (pending) {
      const opened = await pending;
      // A start that already failed on the persisted model fails again for the
      // same reason, so retry with the requested model instead of giving up.
      if (!model || !("success" in opened)) return opened;
    }
    const current = this.live.get(key);
    if (current && !current.runtime.isClosed) return current;
    const started = this.openOnce(cwd, sessionId, config, model);
    this.opening.set(key, started);
    try { return await started; }
    finally { if (this.opening.get(key) === started) this.opening.delete(key); }
  }

  private async openOnce(cwd: string, sessionId: string, config: PiConfig, modelOverride?: { provider: string; modelId: string }): Promise<Live | RuntimeResult> {
    const key = identity(cwd, sessionId);
    const path = await this.repository.findPath(cwd, sessionId);
    if (!path) return { success: false, code: "not_found", error: "session not found in this workspace" };
    const saved = await readJson<Pick<PiConfig, "skills" | "model_context_window_override"> | null>(configPath(cwd, sessionId), null);
    const persisted = await this.repository.configuration(cwd, sessionId);
    // An explicit model change must not need the model it replaces. Disabling a
    // provider removes its model from the catalog, so resolving the persisted
    // model first would leave that session permanently unconfigurable.
    const target = this.modelTargets.get(key);
    const model = modelOverride ?? (target ? splitModel(target.model) : null) ?? persisted?.model ?? splitModel(config.model);
    if (!model) return { success: false, code: "invalid_model", error: "An agent-core session requires a provider/model setting" };
    try {
      await this.beforeStart?.(cwd);
      seedWorkspaceAssets(cwd);
      await this.registry.register(cwd, sessionId, path);
      const runtime = await this.manager.start(key, {
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
        env: await this.workerEnvironment(cwd),
        credentialEnvNames: await this.credentialEnvNames(cwd),
        deferActivation: true,
      });
      const attached = await this.attach(key, runtime, `${model.provider}/${model.modelId}`, persisted?.thinkingLevel ?? config.thinking ?? null, config);
      // A reopened worker still owes the outstanding change, so arm its boundary.
      // Read the target again: one can arrive while the worker is starting.
      if (this.modelTargets.has(key)) attached.restartPending = true;
      return attached;
    } catch (error) { return failed(error); }
  }

  async command(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> {
    if (["abort", "steer"].includes(type)) return this.commandOnce(cwd, sessionId, type, params, config);
    if (type === "prompt" || type === "follow_up") {
      const blocked = await this.awaitPendingReload(cwd, sessionId, type === "follow_up");
      if (blocked) return blocked;
    }
    return this.withMutation(cwd, sessionId, () => this.commandOnce(cwd, sessionId, type, params, config));
  }

  /** A turn must not start on a model the user replaced, so the command waits for a
   *  deferred reload and fails if it cannot land. Outside withMutation on purpose,
   *  because the reload calls configure, which takes the mutation queue itself.
   *  A follow-up is exempt while a turn is running: that turn finishes first and the
   *  reload lands on its boundary, so blocking the follow-up would only break the
   *  exchange that is already in flight. */
  private async awaitPendingReload(cwd: string, sessionId: string, allowBusy: boolean): Promise<RuntimeResult | null> {
    const key = identity(cwd, sessionId);
    const current = this.live.get(key);
    if (!current || (allowBusy && current.busy)) return null;
    if (!current.restartPending && !this.modelTargets.has(key)) return null;
    try { await this.stopForReload(current); }
    catch (error) {
      return { success: false, code: error instanceof ReloadFailedError ? error.code : "configuration_reload_failed",
        error: error instanceof Error ? error.message : String(error) };
    }
    // A target that arrives while the worker is being stopped is left for the next
    // boundary, so dispatching now would run the turn on the model in between.
    if (this.live.get(key)?.restartPending || this.modelTargets.has(key)) {
      return { success: false, code: "configuration_reload_failed", error: "the model change has not landed yet" };
    }
    return null;
  }

  private async commandOnce(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> {
    const opened = await this.open(cwd, sessionId, config);
    if ("success" in opened) return opened;
    if (type === "prompt") {
      const clientMessageId = typeof params.client_message_id === "string" ? params.client_message_id : randomUUID();
      params = { ...params, client_message_id: clientMessageId };
      const operationId = promptOperationId(sessionId, clientMessageId);
      try { await this.turns.prepare(cwd, sessionId, operationId); }
      catch (error) { return { success: false, code: "lifecycle_prepare_failed", error: String(error) }; }
      // The reload guard ran before this mutation, so a settings change can land
      // while preparation awaits. Dispatching now would reach the model the user
      // just replaced, and the reload's configure is queued behind this very
      // mutation, so it cannot have landed yet.
      if (this.modelTargets.has(identity(cwd, sessionId))) {
        await this.turns.discardRejected(cwd, sessionId, operationId).catch(() => undefined);
        return { success: false, code: "configuration_reload_failed", error: "the model change has not landed yet" };
      }
      if (!opened.expectedOperationId) {
        opened.expectedOperationId = operationId;
        opened.lastProgressAt = Date.now();
        opened.interactionWaitStartedAt = undefined;
      }
      this.scheduleWatchdog(opened);
    } else if (type === "follow_up" && !opened.busy && this.modelTargets.has(identity(cwd, sessionId))) {
      // The guard ran before this mutation, so a settings change can land while the
      // worker is being opened. While a turn is running the follow-up belongs to it,
      // but once it is idle, starting a turn now would use the replaced model.
      return { success: false, code: "configuration_reload_failed", error: "the model change has not landed yet" };
    }
    try {
      const result = await opened.runtime.sendCommand(type, params);
      if (type === "prompt" && result.code === "busy" && typeof params.client_message_id === "string") {
        await this.turns.discardRejected(cwd, sessionId, promptOperationId(sessionId, params.client_message_id)).catch(() => undefined);
      }
      if (type === "prompt" && !opened.busy && (!result.success || result.deduplicated)) {
        opened.expectedOperationId = undefined;
        this.scheduleWatchdog(opened);
      }
      return result;
    } catch (error) {
      if (error instanceof AgentRuntimeTimeoutError || error instanceof AgentRuntimeExitedError) void this.recover(opened);
      return failed(error);
    }
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

  /** Rebuilds workers with current MCP and environment settings; active turns finish first. */
  async reloadConfiguration(modelChange?: { model: string; thinking: string }): Promise<void> {
    await Promise.allSettled(this.opening.values());
    const items = [...this.live.values()];
    // Stamp every session before applying any of them. Applying in the same pass
    // would let the first failure strand the rest on the replaced model with no
    // intent recorded, and nothing left to retry.
    for (const item of items) {
      if (modelChange) this.modelTargets.set(liveKey(item), { ...modelChange });
      item.restartPending = true;
    }
    // A busy session finishes its turn first, so only the idle ones apply now.
    const settled = await Promise.allSettled(items.filter((item) => !item.busy).map((item) => this.stopForReload(item)));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  /** Applies the outstanding model change, then stops the worker so the next open()
   *  reopens with it. Concurrent callers share the one in-flight reload instead of
   *  racing past it, and a failure reaches every one of them. */
  private stopForReload(item: Live): Promise<void> {
    if (this.live.get(liveKey(item)) !== item) return Promise.resolve();
    if (item.reload) return item.reload;
    // Publish the shared promise before the pass starts. A pass that returns before
    // its first await would otherwise clear the field and then be stored here as an
    // already-settled promise, and every later caller would skip the work.
    const reload = Promise.resolve().then(() => this.applyReload(item));
    item.reload = reload;
    return reload;
  }

  private async applyReload(item: Live): Promise<void> {
    try {
      // Mark the boundary pending before anything can fail, so a session that was
      // idle when the change arrived is still guarded if this attempt throws.
      item.restartPending = true;
      // Drain every outstanding target. A newer one can arrive while configure
      // awaits, and leaving it behind would let this boundary's caller run a turn
      // on the model in between. Each pass applies a distinct target, so the loop
      // runs once per settings change made while it is working.
      while (true) {
        const pending = this.modelTargets.get(liveKey(item));
        if (!pending) break;
        if (item.model === pending.model && item.thinking === pending.thinking) {
          // The worker already runs the target, so the change has landed. Keeping it
          // would leave every later boundary believing it is still outstanding.
          this.modelTargets.delete(liveKey(item));
          break;
        }
        const result = await this.configure(item.runtime.cwd, item.runtime.sessionId, pending.model, pending.thinking, item.config);
        // A failure keeps the target, so the next boundary retries instead of
        // reopening the model the user replaced.
        if (!result.success) throw new ReloadFailedError(String(result.code ?? "configuration_reload_failed"),
          String(result.error ?? result.code ?? "model configuration failed"));
        if (this.modelTargets.get(liveKey(item)) === pending) this.modelTargets.delete(liveKey(item));
      }
      // A turn that is still running finishes first and the reload lands on its
      // boundary. Stopping here would kill the turn instead.
      if (item.busy) return;
      // The worker this pass started with may have been replaced while configure
      // awaited, and the manager key is shared, so stopping by key would kill its
      // successor.
      if (this.live.get(liveKey(item)) !== item) return;
      item.suppressRecovery = true;
      if (item.watchdog) clearTimeout(item.watchdog);
      this.events.expectExit(item.runtime);
      await this.manager.stop(item.key);
      // Only a stop that finished applies the change, so the boundary is cleared
      // here. A stop that throws leaves it armed and the next boundary retries.
      item.restartPending = false;
    } finally {
      // The reload stops owning the record before the drop, so an exit that lands
      // after this point is free to remove it.
      item.reload = undefined;
    }
    this.dropIfSettled(item);
  }

  /** Settles the record of a worker that stopped. A model change still outstanding
   *  keeps it, armed, because the guard reads restartPending and the apply reads the
   *  target. The exit arrives in the middle of the stop, before a target that
   *  lands during it, so the record has to outlive the worker that was stopping when
   *  the change was made. open() reopens a closed runtime. */
  private dropIfSettled(item: Live): void {
    if (this.modelTargets.has(liveKey(item))) { item.restartPending = true; return; }
    if (item.reload) return;
    const key = liveKey(item);
    if (this.live.get(key) === item) this.live.delete(key);
  }

  async resume(cwd: string, sessionId: string, config: PiConfig): Promise<RuntimeResult> {
    return this.command(cwd, sessionId, "get_state", {}, config);
  }

  async state(cwd: string, sessionId: string, config: PiConfig): Promise<SessionState | { error: string; code: string }> {
    if ((await this.registry.get(cwd, sessionId))?.state === "deleted") return { error: "session was deleted", code: "not_found" };
    const current = this.live.get(identity(cwd, sessionId));
    if (!current || current.runtime.isClosed) {
      if (!(await this.repository.findPath(cwd, sessionId))) return { error: "session not found in this workspace", code: "not_found" };
      const saved = await this.repository.configuration(cwd, sessionId);
      const facts = await this.repository.runtimeState(cwd, sessionId);
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
      model: model?.provider && model.modelId ? `${model.provider}/${model.modelId}` : current.model,
      thinking: typeof data.thinkingLevel === "string" ? data.thinkingLevel : current.thinking,
      context_tokens: typeof data.context_tokens === "number" ? data.context_tokens : null,
      context_window: typeof data.context_window === "number" ? data.context_window : null,
      context_percent: typeof data.context_percent === "number" ? data.context_percent : null,
      compaction_enabled: data.compaction.enabled,
      compaction_threshold_percent: typeof data.compaction_threshold_percent === "number" ? data.compaction_threshold_percent : null };
  }

  async configure(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> {
    return this.withMutation(cwd, sessionId, () => this.configureOnce(cwd, sessionId, model, level, config));
  }

  private async configureOnce(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> {
    const ref = splitModel(model);
    if (!ref) return { success: false, code: "invalid_model", error: "Model must use provider/model notation" };
    if (level !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
      return { success: false, code: "invalid_thinking", error: "invalid thinking level" };
    }
    const opened = await this.open(cwd, sessionId, config, ref);
    if ("success" in opened) return opened;
    if (opened.busy) return { success: false, code: "busy", error: "agent is busy; wait for the current task to finish or stop it" };
    const result = await opened.runtime.sendCommand("configure", { ...ref, ...(level ? { level } : {}) }).catch(failed);
    if (!result.success) return result;
    const state = result.data as { model?: { provider?: string; modelId?: string }; thinkingLevel?: string } | undefined;
    if (state?.model?.provider !== ref.provider || state.model.modelId !== ref.modelId
      || typeof state.thinkingLevel !== "string" || (level !== undefined && state.thinkingLevel !== level)) {
      // This runs inside the session mutation, so it must not call stopForReload:
      // that would take the mutation queue again and wait on itself. Stopping the
      // worker is enough; the exit handler decides whether the record survives.
      opened.suppressRecovery = true;
      if (opened.watchdog) clearTimeout(opened.watchdog);
      this.events.expectExit(opened.runtime);
      await this.manager.stop(opened.key).catch(() => undefined);
      return { success: false, code: "reconcile_failed", error: "agent runtime returned an inconsistent configuration" };
    }
    opened.model = `${state.model.provider}/${state.model.modelId}`;
    opened.thinking = state.thinkingLevel;
    // The harness log is the configuration authority. The sidecar contains
    // product settings only, so a cache write cannot roll back a newer commit.
    return { success: true, sessionId, model: opened.model, thinking: opened.thinking, restarted: false };
  }

  async fork(cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult> {
    const result = await this.command(cwd, sessionId, entryId ? "fork" : "clone", entryId ? { entryId } : {}, config);
    if (result.success && typeof result.sessionId === "string") {
      const saved = await readJson<Pick<PiConfig, "skills" | "model_context_window_override"> | null>(configPath(cwd, sessionId), null);
      await writeJsonAtomic(configPath(cwd, result.sessionId), { skills: saved?.skills ?? config.skills,
        model_context_window_override: saved?.model_context_window_override ?? config.model_context_window_override });
      const path = await this.repository.findPath(cwd, result.sessionId);
      if (path) await this.registry.register(cwd, result.sessionId, path);
    }
    return result;
  }

  async stats(cwd: string, sessionId: string): Promise<{ stats: SessionStats } | { error: string; code: string }> {
    const stats = await this.repository.stats(cwd, sessionId);
    return stats ? { stats: await this.hooks.stats?.(cwd, sessionId, stats) ?? stats } : { error: "session not found in this workspace", code: "not_found" };
  }

  async delete(cwd: string, sessionId: string): Promise<RuntimeResult> {
    return this.withMutation(cwd, sessionId, () => this.deleteOnce(cwd, sessionId));
  }

  private async deleteOnce(cwd: string, sessionId: string): Promise<RuntimeResult> {
    const key = identity(cwd, sessionId);
    const live = this.live.get(key);
    if (live?.busy) return { success: false, code: "busy", error: "cannot delete a conversation while it is running" };
    if (live && !live.runtime.isClosed) {
      const snapshot = await live.runtime.sendCommand("get_state").catch(failed);
      if (!snapshot.success) return snapshot;
      if (snapshot.data?.busy) return { success: false, code: "busy", error: "cannot delete a conversation while it is running" };
    }
    const registered = await this.registry.get(cwd, sessionId);
    const path = registered?.target ?? await this.repository.findPath(cwd, sessionId);
    if (!path) return { success: false, code: "not_found", error: "session not found in this workspace" };
    try {
      // Commit deletion before cleanup: retries and server restarts must never
      // rediscover an imported transcript through its retained legacy source.
      await this.registry.markDeleted(cwd, sessionId, path);
      if (live) { live.suppressRecovery = true; this.events.expectExit(live.runtime); await this.manager.stop(live.key); this.live.delete(key); }
      // The session is gone, so a target for it can never land.
      this.modelTargets.delete(key);
      const remove = async (file: string) => { await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); };
      await remove(path);
      await remove(configPath(cwd, sessionId));
      return { success: true };
    } catch (error) { return { success: false, code: "delete_failed", error: String(error) }; }
  }

  private async withMutation<T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = identity(cwd, sessionId);
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.mutations.set(key, next);
    try { return await next; }
    finally { if (this.mutations.get(key) === next) this.mutations.delete(key); }
  }

  async shutdownAll(): Promise<void> {
    this.stopping = true;
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    for (const item of this.live.values()) if (item.watchdog) clearTimeout(item.watchdog);
    await Promise.allSettled(this.recovering.values());
    for (const item of this.live.values()) this.events.expectExit(item.runtime);
    await this.manager.shutdownAll();
    this.live.clear();
    await this.events.flush();
  }

  get processCount(): number { return this.manager.processCount; }

  private scheduleWatchdog(item: Live): void {
    const delay = Number(process.env.PI_SCIENCE_EVENT_WATCHDOG_MS ?? 60000);
    if (this.stopping || item.suppressRecovery || item.runtime.isClosed || !item.expectedOperationId || !Number.isFinite(delay) || delay <= 0) {
      if (item.watchdog) clearTimeout(item.watchdog);
      item.watchdog = undefined;
      return;
    }
    // Keep probes periodic. Non-progress events must not postpone supervision.
    if (item.watchdog) return;
    item.watchdog = setTimeout(() => { item.watchdog = undefined; void this.probe(item); }, delay);
    item.watchdog.unref?.();
  }

  private async probe(item: Live): Promise<void> {
    if (this.stopping || this.live.get(identity(item.runtime.cwd, item.runtime.sessionId)) !== item) return;
    try {
      const result = await item.runtime.sendCommand("get_state", {}, 5000);
      if (!result.success) throw new Error(String(result.error));
      const data = result.data;
      if (!data) throw new Error("Worker returned no snapshot");
      if (this.stopping || this.live.get(identity(item.runtime.cwd, item.runtime.sessionId)) !== item || !item.expectedOperationId) return;
      if (data.faulted || Number(data.eventSequence ?? 0) > item.eventSequence) { await this.recover(item); return; }
      const now = Date.now();
      if (data.pendingInteraction) item.interactionWaitStartedAt ??= now;
      else if (item.interactionWaitStartedAt !== undefined) {
        // Waiting for a person is not an agent-loop stall. Exclude that time
        // without counting successful IPC probes as operation progress.
        item.lastProgressAt += now - item.interactionWaitStartedAt;
        item.interactionWaitStartedAt = undefined;
      }
      if (data.busy && !data.pendingInteraction && now - item.lastProgressAt >= noProgressTimeoutMs()) {
        await this.recover(item, true);
        return;
      }
      if (!data.busy && item.expectedOperationId && data.lastResult?.operationId === item.expectedOperationId) {
        emitRecoveredSettle(item.runtime, data.lastResult.operationId, data.lastResult.kind, data.lastResult.status);
      } else this.scheduleWatchdog(item);
    } catch { await this.recover(item); }
  }

  private recover(item: Live, force = false): Promise<void> {
    const cwd = item.runtime.cwd, sessionId = item.runtime.sessionId;
    const key = identity(cwd, sessionId);
    if (this.stopping) return Promise.resolve();
    const existing = this.recovering.get(key);
    if (existing) return existing;
    const work = this.withMutation(cwd, sessionId, async () => {
      if (this.stopping) return;
      const current = this.live.get(key);
      if (current && current !== item && !current.runtime.isClosed) return;
      const attempt = (this.recoveryAttempts.get(key) ?? 0) + 1;
      this.recoveryAttempts.set(key, attempt);
      const exhausted = attempt > 3;
      item.suppressRecovery = true;
      if (item.watchdog) clearTimeout(item.watchdog);
      if (!exhausted) await this.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovering", recoverable: true,
        message: "The agent worker stopped responding; restoring its durable operation." });
      this.events.expectExit(item.runtime);
      // Graceful Harness.close can cancel/settle an operation. A hung loop must
      // instead retain its checkpoint so the replacement worker can resume it.
      if ((force || exhausted) && !item.runtime.isClosed) item.runtime.child.kill("SIGKILL");
      await this.manager.stop(item.key); // Await exit before opening the same durable session.
      if (this.live.get(key) === item) this.live.delete(key);
      if (this.stopping) return;
      if (exhausted) {
        await this.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovery_failed", terminal: true,
          message: "The agent operation stalled repeatedly; automatic recovery has stopped. Reopen the session to retry." });
        await this.events.publish(cwd, sessionId, { type: "runtime.paused", sessionId });
        return;
      }
      // open() resolves the outstanding model change itself, so recovery starts on
      // the model the user selected rather than the one being replaced, and a start
      // that fails leaves the change in place for the retry.
      const opened = await this.open(cwd, sessionId, item.config);
      if ("success" in opened) {
        await this.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovery_failed", terminal: attempt >= 3, message: String(opened.error) });
        if (attempt < 3) {
          const timer = setTimeout(() => { this.recoveryTimers.delete(key); void this.recover(item); }, 250 * attempt);
          timer.unref?.();
          this.recoveryTimers.set(key, timer);
        }
      } else if (!opened.busy) {
        // A replacement can be idle because Core already persisted the result
        // before the previous worker lost its terminal event. Reconcile from
        // that authoritative result; process liveness alone cannot settle it.
        const operationId = item.expectedOperationId;
        const result = operationId ? await opened.runtime.sendCommand("get_operation_result", { operationId }) : undefined;
        if (result?.success && result.data) emitRecoveredSettle(opened.runtime, result.data.operationId, result.data.kind, result.data.status);
        else await this.events.publish(cwd, sessionId, { type: "runtime.paused", sessionId });
      }
      if (!("success" in opened) && opened.restartPending && !opened.busy) {
        // configure() takes the mutation queue, so it cannot run inside this one.
        const timer = setTimeout(() => { void this.stopForReload(opened).catch(() => undefined); }, 0);
        timer.unref?.();
      }
    }).catch(async (error) => {
      try { await this.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovery_failed", terminal: true, message: String(error) }); } catch { /* The event store may itself be unavailable. */ }
    }).finally(() => { if (this.recovering.get(key) === work) this.recovering.delete(key); });
    this.recovering.set(key, work);
    return work;
  }
}
