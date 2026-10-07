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

type Live = { key: string; runtime: AgentCoreRuntimeClient; busy: boolean; model: string; thinking: string | null;
  config: PiConfig; eventSequence: number; openedGeneration: number; expectedOperationId?: string; watchdog?: NodeJS.Timeout;
  suppressRecovery?: boolean; lastProgressAt: number; interactionWaitStartedAt?: number };
/** The model a session must start on. A revision orders the writers: a global settings
 *  change and a per-session choice both reserve one at their entry point, so the newest
 *  intent wins whichever of them finishes first. */
type ModelIntent = { revision: number; model: string; thinking: string; refusedAt?: number };
type ProductHooks = {
  observe?: (cwd: string, sessionId: string, event: Record<string, unknown>) => void;
  settled?: (cwd: string, sessionId: string, turnId: string) => void;
  stats?: (cwd: string, sessionId: string, stats: SessionStats) => Promise<SessionStats>;
};

function identity(cwd: string, id: string): string { return `${workspaceIdentity(cwd)}\0${id}`; }
/** Key of the settings-wide model choice in the intent ledger. */
const GLOBAL_INTENT = "*";
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
  /** Model intent per session, plus GLOBAL_INTENT for the settings default. It is
   *  desired state rather than outstanding work, so nothing has to clear it once a
   *  worker catches up, and it outlives every worker lifecycle event. openOnce
   *  resolves it, so every start picks it up. */
  private readonly modelIntents = new Map<string, ModelIntent>();
  private intentRevision = 0;
  /** Bumped by every reload. A worker built under an older generation is stale and is
   *  replaced rather than reconfigured, because a replacement starts on current intent
   *  while reconfiguring a live worker is a second writer of the same state. */
  private reloadGeneration = 0;
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
    // Capture the generation and reserve the intent revision before the first await, so a reload
    // that lands anywhere in creation outranks this session's own model and the first turn
    // replaces this worker.
    const generation = this.reloadGeneration;
    const revision = ++this.intentRevision;
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
      // Hold the session mutation while the worker attaches. A reload that retires an
      // idle worker must not catch a record that is still being bound, or the create
      // fails after its transcript is already registered.
      const created = await this.withMutation(cwd, runtime.sessionId,
        () => this.attach(key, runtime, config.model!, config.thinking ?? null, config, generation));
      // A session created with its own model keeps it. Without recording that as this session's
      // intent, the settings-wide choice outranks the durable model on the first turn and
      // silently replaces the model the session was created with.
      if (created.thinking) {
        this.modelIntents.set(identity(cwd, runtime.sessionId),
          { revision, model: created.model, thinking: created.thinking });
      }
      return { id: runtime.sessionId };
    } catch (error) {
      // Keep the typed classification: one capacity condition must not answer 429
      // when reopening a session and 503 when creating one.
      return { error: String(error), code: error instanceof AgentRuntimeCapacityError ? "runtime_capacity_exceeded" : "spawn_failed" };
    }
  }

  private async attach(key: string, runtime: AgentCoreRuntimeClient, model: string, level: string | null, config: PiConfig,
    generation: number): Promise<Live> {
    const item: Live = { key, runtime, busy: false, model, thinking: level, config, eventSequence: 0, openedGeneration: generation,
      lastProgressAt: Date.now() };
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
        // The turn has settled, so this is the boundary where a stale worker can be
        // replaced. Through the mutation queue, so an admitted turn cannot have its
        // worker stopped underneath it.
        if (!busy) void this.withMutation(runtime.cwd, runtime.sessionId, () => this.retireStaleOnce(item)).catch((error) =>
          this.events.publish(runtime.cwd, runtime.sessionId, { type: "error", message: `Settings reload failed: ${String(error)}` }));
      },
      onExit: () => {
        if (item.watchdog) clearTimeout(item.watchdog);
        if (this.live.get(identity(runtime.cwd, runtime.sessionId)) === item) this.live.delete(identity(runtime.cwd, runtime.sessionId));
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

  private async open(cwd: string, sessionId: string, config: PiConfig, model?: { provider: string; modelId: string },
    generation = this.reloadGeneration): Promise<Live | RuntimeResult> {
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
    const started = this.openOnce(cwd, sessionId, config, model, generation);
    this.opening.set(key, started);
    try { return await started; }
    finally { if (this.opening.get(key) === started) this.opening.delete(key); }
  }

  private async openOnce(cwd: string, sessionId: string, config: PiConfig, modelOverride?: { provider: string; modelId: string },
    generation = this.reloadGeneration): Promise<Live | RuntimeResult> {
    const key = identity(cwd, sessionId);
    const path = await this.repository.findPath(cwd, sessionId);
    if (!path) return { success: false, code: "not_found", error: "session not found in this workspace" };
    const saved = await readJson<Pick<PiConfig, "skills" | "model_context_window_override"> | null>(configPath(cwd, sessionId), null);
    const persisted = await this.repository.configuration(cwd, sessionId);
    // An explicit model change must not need the model it replaces. Disabling a
    // provider removes its model from the catalog, so resolving the persisted
    // model first would leave that session permanently unconfigurable.
    const selection = this.desiredModel(key, persisted, config);
    const chosen = modelOverride ?? selection;
    if (!chosen) return { success: false, code: "invalid_model", error: "An agent-core session requires a provider/model setting" };
    const model = { provider: chosen.provider, modelId: chosen.modelId };
    // A restored lane keeps its durable model and level, so this only decides what a new lane
    // starts on. The worker adopts the selection when the durable model is gone, and
    // ensureCurrent configures it afterwards for every other case. An explicit override
    // reconciles its own level instead.
    const level = modelOverride ? (persisted?.thinkingLevel ?? config.thinking ?? null) : selection?.thinking ?? null;
    try {
      await this.beforeStart?.(cwd);
      seedWorkspaceAssets(cwd);
      await this.registry.register(cwd, sessionId, path);
      const runtime = await this.manager.start(key, {
        cwd,
        sessionId,
        sessionsRoot: join(metadataRoot(cwd), "agent-sessions"),
        model,
        thinking: thinking(level ?? undefined),
        settings: { ...config, model_context_window_override: config.model_context_window_override?.model === `${model.provider}/${model.modelId}`
          ? config.model_context_window_override : saved?.model_context_window_override },
        systemPrompt: await systemPrompt(),
        skillPaths: saved?.skills ?? config.skills,
        skillPolicy: await globalSkillPolicy(),
        env: await this.workerEnvironment(cwd),
        credentialEnvNames: await this.credentialEnvNames(cwd),
        deferActivation: true,
      });
      return await this.attach(key, runtime, `${model.provider}/${model.modelId}`, level, config, generation);
    } catch (error) { return failed(error); }
  }

  async command(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> {
    // abort and steer must reach a turn that is already running, so they stay outside
    // the queue. Everything else can start or queue a turn, so it is serialized.
    if (["abort", "steer"].includes(type)) return this.commandOnce(cwd, sessionId, type, params, config);
    return this.withMutation(cwd, sessionId, () => this.commandOnce(cwd, sessionId, type, params, config));
  }

  private async commandOnce(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> {
    // abort and steer act on the turn that is already running, so they must reach it
    // whatever model it holds. Everything else can start a turn and is held to the
    // current intent.
    const passing = type === "abort" || type === "steer";
    const opened = passing ? await this.open(cwd, sessionId, config) : await this.ensureCurrent(cwd, sessionId, config);
    if ("success" in opened) return opened;
    // A command that starts an operation must not use a worker the settings outdate,
    // whether the model moved or the resources did. This holds at dispatch: a follow-up
    // queued before the change still belongs to the turn that was already running, and the
    // worker it runs on is replaced once that turn settles. Only these commands are held
    // back, so abort and steer still reach the turn that is already there.
    if ((type === "prompt" || type === "follow_up" || type === "compact") && this.isStale(opened)) {
      return { success: false, code: "configuration_reload_failed", error: "the settings change has not landed yet" };
    }
    // A prompt only owns the record's operation id when it is the one that armed it. A retry of a
    // request that is already running carries the same id, and clearing it would cancel that
    // operation's supervision while it is still going.
    const ownsOperation = type === "prompt" && !opened.expectedOperationId;
    if (type === "prompt") {
      const clientMessageId = typeof params.client_message_id === "string" ? params.client_message_id : randomUUID();
      params = { ...params, client_message_id: clientMessageId };
      const operationId = promptOperationId(sessionId, clientMessageId);
      try { await this.turns.prepare(cwd, sessionId, operationId); }
      catch (error) { return { success: false, code: "lifecycle_prepare_failed", error: String(error) }; }
      // The settings can change while preparation awaits. This runs inside the session
      // mutation, so nothing can replace the worker between this check and dispatch.
      if (this.isStale(opened)) {
        await this.turns.discardRejected(cwd, sessionId, operationId).catch(() => undefined);
        return { success: false, code: "configuration_reload_failed", error: "the settings change has not landed yet" };
      }
      if (!opened.expectedOperationId) {
        opened.expectedOperationId = operationId;
        opened.lastProgressAt = Date.now();
        opened.interactionWaitStartedAt = undefined;
      }
      this.scheduleWatchdog(opened);
    }
    try {
      const result = await opened.runtime.sendCommand(type, params);
      if (type === "prompt" && result.code === "busy" && typeof params.client_message_id === "string") {
        await this.turns.discardRejected(cwd, sessionId, promptOperationId(sessionId, params.client_message_id)).catch(() => undefined);
      }
      if (ownsOperation && !opened.busy && (!result.success || result.deduplicated)) {
        opened.expectedOperationId = undefined;
        this.scheduleWatchdog(opened);
      }
      // A compaction is an admitted operation too. Without recording it the record looks idle
      // until the event that marks the worker busy arrives, and a reload landing in that window
      // would stop the worker and drop the operation.
      const compacted = (result as { operationId?: unknown }).operationId;
      if (type === "compact" && result.success && typeof compacted === "string") {
        opened.expectedOperationId = compacted;
        opened.lastProgressAt = Date.now();
        this.scheduleWatchdog(opened);
      }
      return result;
    } catch (error) {
      // A deliberate stop is not a worker that stopped responding, so it must not raise a
      // recovery card or spend an attempt. A scheduled recovery retry still gets through,
      // because it is the only thing that can bring a failed replacement back.
      if ((error instanceof AgentRuntimeTimeoutError || error instanceof AgentRuntimeExitedError) && !opened.suppressRecovery) {
        void this.recover(opened);
      }
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
  /** The model a worker for this session must start on, and the level it should hold. The
   *  newest intent wins: a per-session choice against the global one, then the durable
   *  configuration, then the configured default. This is what the worker is started with,
   *  and an explicit configure reconciles the worker itself after startup.
   *  The intent is not durable. After a restart a session with a durable model of its own
   *  starts on that model rather than on the settings default, which is the same behaviour a
   *  session has when it was never live during the change. A model that is no longer in the
   *  catalog is only replaced once the settings publish an intent for it. */
  private desiredModel(key: string, persisted: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null } | null,
    config: PiConfig): { provider: string; modelId: string; thinking: string | null } | null {
    const intent = this.newestIntent(key);
    const model = (intent ? splitModel(intent.model) : null) ?? persisted?.model ?? splitModel(config.model);
    if (!model) return null;
    return { ...model, thinking: intent?.thinking ?? persisted?.thinkingLevel ?? config.thinking ?? null };
  }

  /** The newest model intent for a session, whether the user chose it for that session
   *  or for every session in settings. */
  private newestIntent(key: string): ModelIntent | undefined {
    const session = this.modelIntents.get(key);
    const global = this.modelIntents.get(GLOBAL_INTENT);
    const intent = session && (!global || session.revision > global.revision) ? session : global;
    // A refusal only holds until the next reload, because the resources that made the intent
    // unreachable may be back. Both readers take this same answer, so the start path and the
    // staleness check cannot disagree about what this session should run.
    return intent?.refusedAt === this.reloadGeneration ? undefined : intent;
  }

  /** The intent a worker does not match, or null when it is current. Its model and level
   *  are what it actually started on, so no separate bookkeeping is needed. */
  private staleIntent(item: Live): ModelIntent | null {
    const intent = this.newestIntent(identity(item.runtime.cwd, item.runtime.sessionId));
    if (!intent) return null;
    return item.model === intent.model && item.thinking === intent.thinking ? null : intent;
  }

  /** A worker the settings outdate: built under an older reload, or running on another
   *  model or level. A command that starts an operation must not use one. */
  private isStale(item: Live): boolean {
    return item.openedGeneration !== this.reloadGeneration || this.staleIntent(item) !== null;
  }

  /** Brings a worker onto the current intent before a turn starts. Runs inside the
   *  session mutation, so nothing can race it. A worker built under an older reload is
   *  replaced, because only a fresh process picks up changed resources; a worker that is
   *  merely on another model is configured, which persists the choice for later starts.
   *  One replacement attempt only: a stream of settings changes fails the command
   *  instead of looping. */
  private async ensureCurrent(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult> {
    let opened = await this.open(cwd, sessionId, config);
    // A worker with a turn in flight keeps it. The caller decides how to report that,
    // because abort and steer must still reach it.
    let state = "success" in opened ? null : await this.workerState(opened);
    if ("success" in opened || state === true) return opened;
    if (opened.openedGeneration !== this.reloadGeneration) {
      await this.retire(opened, state === null);
      opened = await this.open(cwd, sessionId, config);
      state = "success" in opened ? null : await this.workerState(opened);
      if ("success" in opened || state === true) return opened;
      if (opened.openedGeneration !== this.reloadGeneration) {
        return { success: false, code: "configuration_reload_failed", error: "the settings change has not landed yet" };
      }
    }
    const intent = this.staleIntent(opened);
    if (!intent) return opened;
    // configureOnce runs inside this mutation, so nothing can race it, and it persists
    // the choice, so a later start resolves the same model.
    const applied = await this.configureOnce(cwd, sessionId, intent.model, intent.thinking, config);
    if (applied.success) return opened;
    // The worker refused this intent outright, so re-applying it would fail every later command.
    // Mark the entry rather than recording a new one: a revision allocated here would be minted
    // at completion and would outrank a change that landed while this ran, which is the ordering
    // this design exists to keep.
    if (applied.code === "invalid_model" || applied.code === "invalid_thinking") intent.refusedAt = this.reloadGeneration;
    return applied;
  }

  /** Stops a worker and drops its record, so the next open starts a replacement on the
   *  current intent. The caller must already hold the session mutation. */
  private async retire(item: Live, force = false): Promise<void> {
    const key = identity(item.runtime.cwd, item.runtime.sessionId);
    if (this.live.get(key) !== item) return;
    item.suppressRecovery = true;
    if (item.watchdog) clearTimeout(item.watchdog);
    // A worker whose state could not be observed must not be closed gracefully: that seals its
    // lane and discards an admitted operation's checkpoint. Killing it keeps the checkpoint for
    // the replacement, which is what recovery does for the same reason.
    if (force && !item.runtime.isClosed) item.runtime.child.kill("SIGKILL");
    this.events.expectExit(item.runtime);
    await this.manager.stop(item.key);
    if (this.live.get(key) === item) this.live.delete(key);
  }

  /** True when the worker has work in flight. The event that marks a worker busy is
   *  emitted at the first model turn, which is after the command that durably admitted the
   *  operation, so an idle-looking record is not enough evidence to stop it. The caller
   *  must hold the session mutation. A snapshot the worker cannot answer counts as work,
   *  because the alternative is stopping a worker whose state is unknown. */
  private async workerState(item: Live): Promise<boolean | null> {
    if (item.busy || item.expectedOperationId) return true;
    const snapshot = await item.runtime.sendCommand("get_state").catch(failed);
    // null means the worker could not be observed. That is not evidence of work, because
    // treating it as work would leave a session with an unresponsive worker unable to migrate
    // and unable to run a turn, but it does change how the worker has to be stopped.
    if (!snapshot.success) return null;
    // Queued inbox items do not count. They are durable, so a replacement lane restores them
    // and the next accepted turn delivers them, while treating them as work would leave a
    // session with an idle queue unable to reconcile: every command would be held back as stale
    // and nothing would ever drain it.
    return Boolean(snapshot.data?.busy);
  }

  /** Replaces an idle worker that a reload outdates, and leaves a working one alone. The
   *  caller must already hold the session mutation. Every reload outdates the workers that
   *  predate it, because a settings save can change the resources a worker was built with. */
  private async retireStaleOnce(item: Live): Promise<void> {
    const key = identity(item.runtime.cwd, item.runtime.sessionId);
    if (this.live.get(key) !== item) return;
    // A session that is opening is not bound yet. Abort and steer open outside the session
    // mutation, so this is the only thing that keeps a reload off a record mid-attach.
    if (this.opening.has(key)) return;
    if (item.openedGeneration === this.reloadGeneration) return;
    const state = await this.workerState(item);
    if (state === true) return;
    await this.retire(item, state === null);
  }

  async reloadConfiguration(modelChange?: { model: string; thinking: string }): Promise<void> {
    // Publishing the intent is the whole change: the model a worker starts on is
    // resolved when it starts, so nothing has to be pushed onto a live worker. Doing it
    // before awaiting anything means a session that opens, recovers or is created while
    // this runs still sees it, and nothing can overwrite it afterwards.
    this.reloadGeneration += 1;
    if (modelChange) this.modelIntents.set(GLOBAL_INTENT, { ...modelChange, revision: ++this.intentRevision });
    // Replace the idle workers this reload outdates, serialized with the session
    // mutation. Every reload outdates them, because a settings save can change the
    // resources a worker was built with, so an idle one is replaced rather than kept
    // running on the old resources. A busy one finishes its turn first.
    const items = [...this.live.values()];
    const settled = await Promise.allSettled(items.map((item) => this.withMutation(item.runtime.cwd, item.runtime.sessionId,
      () => this.retireStaleOnce(item))));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
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
      // A session with no worker reports the model it would start on, which is the
      // intent when one is recorded rather than whatever it last ran.
      const selected = this.desiredModel(identity(cwd, sessionId), saved, config);
      return { id: sessionId, cwd, is_streaming: false, is_compacting: false, pending_message_count: 0,
        model: selected ? `${selected.provider}/${selected.modelId}` : null,
        thinking: selected?.thinking ?? null,
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

  /** Sets the model for one session. The revision is reserved at entry, before the
   *  queue, so invocation order decides and a global change that lands while this waits
   *  is not erased by it. */
  async configure(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> {
    const key = identity(cwd, sessionId);
    const revision = ++this.intentRevision;
    const result = await this.withMutation(cwd, sessionId, () => this.configureOnce(cwd, sessionId, model, level, config));
    // Publish only a verified choice, and only while nothing newer has been recorded.
    // The level is the one the worker reported: an omitted level means "keep the current
    // one", and recording the omission would leave the intent unsatisfiable.
    if (result.success && (this.modelIntents.get(key)?.revision ?? -1) < revision) {
      // configureOnce reports success only when the worker returned a string level.
      const verified = (result as { thinking?: string | null }).thinking;
      if (typeof verified === "string") this.modelIntents.set(key, { revision, model, thinking: verified });
    }
    return result;
  }

  /** Stops a worker whose configuration cannot be trusted, and drops its record so the next
   *  start resolves the current intent. The caller must already hold the session mutation. */
  private async quarantine(item: Live): Promise<void> {
    item.suppressRecovery = true;
    if (item.watchdog) clearTimeout(item.watchdog);
    this.events.expectExit(item.runtime);
    await this.manager.stop(item.key).catch(() => undefined);
    const key = identity(item.runtime.cwd, item.runtime.sessionId);
    if (this.live.get(key) === item) this.live.delete(key);
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
    let result: Awaited<ReturnType<AgentCoreRuntimeClient["sendCommand"]>>;
    try { result = await opened.runtime.sendCommand("configure", { ...ref, ...(level ? { level } : {}) }); }
    catch (error) {
      // The worker writes the change before it answers, so a dropped reply leaves the
      // service unable to tell which side of that write it failed on. Stop the worker, so
      // the next start resolves the intent again rather than running on a configuration
      // nothing recorded. A worker that answered is a different case and keeps running.
      await this.quarantine(opened);
      return failed(error);
    }
    if (!result.success) return result;
    const state = result.data as { model?: { provider?: string; modelId?: string }; thinkingLevel?: string } | undefined;
    if (state?.model?.provider !== ref.provider || state.model.modelId !== ref.modelId
      || typeof state.thinkingLevel !== "string" || (level !== undefined && state.thinkingLevel !== level)) {
      // A worker that cannot prove its configuration is not worth keeping.
      await this.quarantine(opened);
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
      // The session is gone, so an intent for it can never be applied.
      this.modelIntents.delete(key);
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
    // A deliberate stop is not a lost worker, and its replacement is already on its way.
    } catch { if (!item.suppressRecovery) await this.recover(item); }
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
      // open() resolves the current intent itself, so a replacement is seeded with the
      // model the user selected rather than the one being replaced, and a start that
      // fails leaves the intent in place for the retry. An operation that was already
      // admitted resumes on the model its durable lane records, which is the turn that
      // was running when the worker was lost.
      // A replacement is built from this record's older configuration, so it keeps that
      // record's generation and the next command replaces it from the current settings.
      const opened = await this.open(cwd, sessionId, item.config, undefined, item.openedGeneration);
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
    }).catch(async (error) => {
      try { await this.events.publish(cwd, sessionId, { type: "error", sessionId, code: "worker_recovery_failed", terminal: true, message: String(error) }); } catch { /* The event store may itself be unavailable. */ }
    }).finally(() => { if (this.recovering.get(key) === work) this.recovering.delete(key); });
    this.recovering.set(key, work);
    return work;
  }
}
