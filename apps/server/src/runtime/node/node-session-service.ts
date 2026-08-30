import type { CreateSessionRequest, PiConfig, SessionState, SessionStats } from "@pi-science/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import nodeProcess from "node:process";
import { ConversationEventHub, conversationEventHub } from "../events/conversation-event-hub.js";
import { durableEventStore } from "../events/event-store.js";
import { observeNodePiEvent } from "../events/node-event-observer.js";
import { PiManager, piManager } from "../pi/pi-manager.js";
import { PiOrbitRequestError } from "../pi/pi-orbit-host.js";
import type { PiProcess, PiProcessOptions, PiResult, RuntimeSkillPolicy } from "../pi/pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../pi/pi-runtime-launch.js";
import { canonicalFromRuntimeModelRef, canonicalRuntimeModelRef, projectedRuntimeModelRef } from "../pi/pi-runtime-projection.js";
import type { ProjectReviewService } from "../../project-review/service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { SessionRepository, invalidateSessionFileCache, sessionRepository } from "./session-repository.js";
import { deleteSessionStats, foldSessionFileStats, loadSessionStats, saveSessionStats } from "./session-stats-repository.js";
import { foldEventRecordsTiming, maxTiming, mergeSessionStats, SessionStatsProjector, timingFromStats, type SessionTiming } from "./session-stats-projector.js";
import { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { diffWorkspaceSnapshots, previewKind, previewMime, snapshotWorkspace, type WorkspaceSnapshotEntry } from "../artifacts/workspace-artifact-snapshot.js";
import { turnArtifactRepository } from "../artifacts/turn-artifact-repository.js";
import { readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { ensureProject } from "../../project/project-registry.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";

type RuntimeFailure = { error: string; code: string; diagnostics?: unknown };
type ServiceFailure = RuntimeFailure & { success: false };
type PendingOperation = "prompt" | "compact";
/** Minimal structural view of the durable event store: only the read side
 *  needed to backfill whole-session timing from persisted SSE records. */
type StatsEventStore = {
  readAfter(cwd: string, sessionId: string, lastEventId?: string | null): Promise<Array<{ created_at: string; data: string }>>;
};
type RuntimeRecord = {
  cwd: string;
  managerKey: string;
  process: PiProcess;
  activeSessionId: string;
  config: PiConfig;
  busy: boolean;
  operationPending?: PendingOperation;
  operationDeadline?: number;
  /** Generation token for the accepted prompt/compact reconciliation. */
  operationToken?: string;
  /** Consecutive idle re-checks while a prompt/compact was accepted but the
   *  agent has not started its turn yet. Pi Orbit may need time to resume a
   *  session or warm a model after the HTTP ack; this is startup reconciliation,
   *  not a timeout for the full agent response. Only applies to the
   *  accepted-then-idle window (prompt returned OK); a transport timeout path
   *  skips this and fails fast. */
  reconcileAttempts?: number;
  /** True when the pending operation was acknowledged via a transport timeout
   *  rather than an OK response. Those are already-dead operations: an idle
   *  probe must fail fast, not retry into a phantom turn. */
  reconcileFromTimeout?: boolean;
  restartPending: boolean;
  reconcileTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  /** Event-stream watchdog: fires while an operation is pending / the runtime
   *  is busy and the Pi Orbit event stream has gone silent. Reconnects first
   *  (cheap), restarts only when the runtime also stops answering get_state. */
  watchdogTimer?: NodeJS.Timeout;
  /** Consecutive watchdog reconnects for the current operation window. */
  watchdogReconnects?: number;
  closing: boolean;
  lastState?: Record<string, unknown>;
  lastStateAt?: number;
  /** Turn-level artifact tracking: baseline snapshot taken at agent_start,
   *  diffed at agent_settled to surface files the turn produced. */
  turnId?: string;
  turnBaseline?: Promise<WorkspaceSnapshotEntry[] | null>;
  /** Last text.updated partId seen this turn. Pi's agent_settled carries no
   *  message id, so the strip is anchored to the assistant part (the frontend
   *  keys live agent blocks by partId) to avoid every turn's artifacts being
   *  appended at the end of the thread. */
  turnAssistantPartId?: string;
  /** 1-based ordinal of the current turn (incremented on each agent_start).
   *  Persisted with turn-artifacts records so the frontend can anchor a strip
   *  to the n-th agent block even when earlier turns produced no files (pure
   *  record-ordinal fallback misplaces strips when a turn has no record). */
  turnOrdinal?: number;
  /** JSONL cursor captured at prompt-accept time (fallback evidence when the
   *  Pi event stream dies and agent_start never arrives): snapshot_version,
   *  last message role/id. The reconciliation probe compares a fresh tail read
   *  against this to prove the turn actually completed from the message file
   *  alone, so it can recover the artifact summary instead of misreporting
   *  did-not-start. */
  acceptSnapshot?: Promise<{ version: string; role: string | null; id: string | null } | null>;
};

function runtimeKey(cwd: string, sessionId: string): string {
  return `${resolve(cwd)}\0${sessionId}`;
}

function reconciliationDelayMs(): number {
  const value = Number(process.env.PI_SCIENCE_RECONCILE_DELAY_MS ?? 0);
  return value > 0 ? value : 2_000;
}

/** Bounds only accepted-idle startup reconciliation while Pi Orbit resumes a
 *  session or warms a model; it is not an agent-response timeout. */
function reconciliationDeadlineMs(): number {
  const value = Number(process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS ?? 0);
  return value > 0 ? value : 120_000;
}

/** Bounded retry for recovery commands right after a session switch: the Pi
 *  Orbit runtime may still be settling and reject config commands with
 *  runtime_busy. Non-busy failures (unknown model, unreadable session) are
 *  config errors and must surface immediately. */
function recoveryBusyRetryAttempts(): number {
  const value = Number(process.env.PI_SCIENCE_RECOVERY_BUSY_RETRIES ?? 0);
  return value > 0 ? value : 3;
}

function recoveryBusyRetryDelayMs(): number {
  const value = Number(process.env.PI_SCIENCE_RECOVERY_BUSY_RETRY_DELAY_MS ?? 0);
  return value > 0 ? value : 250;
}

function idleRuntimeMs(): number {
  const configured = process.env.PI_SCIENCE_IDLE_RUNTIME_MS;
  if (configured === undefined || configured === "") return 30 * 60_000;
  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function eventWatchdogMs(): number {
  const configured = process.env.PI_SCIENCE_EVENT_WATCHDOG_MS;
  if (configured === undefined || configured === "") return 60_000;
  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function failure(result: PiResult | Record<string, unknown>, fallback: string): ServiceFailure {
  return {
    success: false,
    code: String(result.code ?? "runtime_error"),
    error: String(result.error ?? fallback),
  };
}

function effectiveConfig(requested?: Partial<PiConfig>): PiConfig {
  const defaults = loadDefaultPiConfig();
  const rawModel = requested?.model || defaults.model || null;
  const model = rawModel ? canonicalRuntimeModelRef(rawModel) : null;
  return {
    model,
    provider: requested?.provider || defaults.provider || null,
    api_key: requested?.api_key || null,
    // A thinking level has no stable meaning until a model is configured;
    // Pi may normalize it differently for its placeholder unknown model.
    thinking: model ? (requested?.thinking ?? defaults.thinking ?? "high") : null,
    compaction_enabled: requested?.compaction_enabled ?? defaults.compaction_enabled ?? true,
    compaction_threshold_percent: requested?.compaction_threshold_percent ?? defaults.compaction_threshold_percent,
    model_context_window: requested?.model_context_window ?? defaults.model_context_window,
    skills: requested?.skills?.length ? requested.skills : defaults.skills,
    extensions: requested?.extensions?.length ? requested.extensions : defaults.extensions,
  };
}

/** First error-level diagnostic from a failed runtime init: the actionable
 *  cause (broken skill, model catalog failure ...) that the generic
 *  "Runtime initialization failed" message hides from the user. */
function firstErrorDiagnostic(diagnostics: unknown): string | null {
  if (!Array.isArray(diagnostics)) return null;
  for (const item of diagnostics) {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "error" && typeof (item as { message?: unknown }).message === "string") {
      return (item as { message: string }).message;
    }
  }
  return null;
}

export class NodeSessionService {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly autoReviews = new Set<string>();
  /** Whole-session wall-clock timing (LLM/TTFT/decode/tool durations) folded
   *  from the raw Pi event stream; persisted via the stats checkpoint. */
  private readonly statsProjector = new SessionStatsProjector();
  private hostReloadPending = false;
  private log: (level: "info" | "warn" | "error", message: string) => void = () => {};
  private beforeRuntimeStart: ((cwd: string) => Promise<void>) | null = null;

  constructor(
    private readonly eventHub: ConversationEventHub = conversationEventHub,
    private readonly manager: PiManager = piManager,
    private readonly repository: SessionRepository = sessionRepository,
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment"> = new WorkspaceEnvironmentService(),
    private readonly projectReview: Pick<ProjectReviewService, "run"> | null = null,
    private readonly statsEventStore: StatsEventStore = durableEventStore,
    private readonly modelResources: Pick<ModelResourceService, "ensureMigrated" | "isModelAvailable"> | null = null,
  ) {}

  configureLogging(log: (level: "info" | "warn" | "error", message: string) => void): void {
    this.log = log;
  }

  configureBeforeRuntimeStart(hook: ((cwd: string) => Promise<void>) | null): void {
    this.beforeRuntimeStart = hook;
  }

  async create(body: CreateSessionRequest): Promise<{ id: string; cwd: string; project_id: string } | RuntimeFailure & { sessionId?: string }> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(body.cwd); }
    catch (error) { return { error: String(error), code: "workspace_invalid" }; }
    const migration = await this.ensureModelResources();
    if (migration) return migration;
    const project = await ensureProject(cwd);
    await mkdir(resolve(cwd, ".pi-science", "sessions"), { recursive: true });
    return this.withLock(`create:${cwd}`, async () => {
      let runtime: RuntimeRecord | undefined;
      const config = effectiveConfig(body.config);
      const started = await this.startRuntime(cwd, config);
      if ("error" in started) return started;
      runtime = started;
      const state = await this.refreshState(runtime);
      if (!state.success || !runtime.activeSessionId) { await this.cleanupRuntime(runtime); return { error: String(state.error ?? "pi runtime did not return a session"), code: String(state.code ?? "spawn_failed") }; }
      const configured = await this.applyConfig(runtime, config);
      if (!configured.success) { await this.cleanupRuntime(runtime); return { error: String(configured.error ?? "unable to configure session"), code: String(configured.code ?? "runtime_error") }; }
      this.registerRuntime(runtime);
      invalidateSessionFileCache(cwd);
      return { id: runtime.activeSessionId, cwd, project_id: project.id };
    });
  }

  async command(sessionId: string, cwdValue: string, type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      // Abort is safe to acknowledge when there is no live runtime. Command
      // discovery must activate the persisted session so project skills and
      // other runtime-provided metadata are available after a server restart.
      if (type === "abort") {
        const runtime = this.runtimes.get(runtimeKey(cwd, sessionId));
        if (!runtime) {
          const sessionPath = await this.repository.findPath(cwd, sessionId);
          if (!sessionPath) return { success: false, code: "not_found", error: "session not found in this workspace" };
          if (type === "abort") return { success: true };
        }
      }
      const activated = await this.activateUnlocked(sessionId, cwd);
      if ("error" in activated) return activated;
      const runtime = activated;
      const mutating = new Set(["prompt", "new_session", "switch_session", "fork", "clone", "set_model", "set_thinking_level", "compact", "abort"]);
      if (mutating.has(type) && type !== "abort") {
        // Item 5: revive a KNOWN-dead event stream BEFORE the mutation
        // preflight. A dead stream often means get_state also fails, which
        // would otherwise short-circuit reconcileForMutation before the
        // health check gets a chance to reconnect/restart.
        const healthy = await this.ensureHealthyEventStream(runtime, type);
        if (!healthy.success) return healthy;
        const ready = await this.reconcileForMutation(runtime);
        if (!ready.success) return ready;
      }
      const oldId = runtime.activeSessionId;
      if (type === "prompt" || type === "compact") this.beginPendingOperation(runtime, type);
      const result = await runtime.process.sendCommand(type, params);
      if (!result.success) {
        if ((type === "prompt" || type === "compact") && result.code === "timeout") {
          runtime.reconcileFromTimeout = true;
          this.scheduleOperationReconciliation(runtime, true);
        }
        else if (type === "prompt" || type === "compact") this.clearPendingOperation(runtime);
        return result;
      }
      if (type === "prompt" || type === "compact") {
        if (type === "prompt") this.recordAcceptTurnBaseline(runtime);
        this.scheduleOperationReconciliation(runtime, false);
        return result;
      }
      if (type === "abort") this.clearPendingOperation(runtime);
      if (mutating.has(type)) {
        const state = await this.refreshState(runtime);
        if (!state.success) {
          await this.cleanupRuntime(runtime);
          return failure(state, `unable to confirm state after ${type}`);
        }
        if (runtime.activeSessionId !== oldId) this.registerRuntime(runtime, oldId);
        if (["new_session", "fork", "clone"].includes(type) && runtime.activeSessionId === oldId) {
          return { success: false, code: "reconcile_failed", error: `${type} did not create a distinct session` };
        }
        if (type === "abort" && runtime.busy) {
          return { success: false, code: "reconcile_failed", error: "abort was acknowledged but the runtime is still busy" };
        }
      }
      return result;
    });
  }

  async notify(sessionId: string, cwdValue: string, type: string, params: Record<string, unknown>): Promise<PiResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const activated = await this.activateUnlocked(sessionId, cwd);
      if ("error" in activated) return activated;
      try {
        await activated.process.sendNotification(type, params);
        if (type === "extension_ui_response" && typeof params.id === "string") {
          this.eventHub.resolvePendingInteraction(cwd, sessionId, params.id);
        }
        return { success: true };
      } catch (error) {
        return { success: false, code: "write_failed", error: String(error) };
      }
    });
  }

  async fork(sessionId: string, cwdValue: string, entryId?: string): Promise<PiResult & { sessionId?: string }> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const source = await this.activateUnlocked(sessionId, cwd);
      if ("error" in source) return source;
      const ready = await this.reconcileForMutation(source);
      if (!ready.success) return ready;
      const sessionPath = await this.repository.findPath(cwd, sessionId);
      if (!sessionPath) return { success: false, code: "not_found", error: "session not found" };
      if (source.process.runtimeIdentity) {
        const result = await source.process.sendCommand(entryId ? "fork" : "clone", entryId ? { entryId } : {});
        if (!result.success) return result;
        const state = await this.refreshState(source);
        if (!state.success || !source.activeSessionId || source.activeSessionId === sessionId) {
          return { success: false, code: "reconcile_failed", error: "fork did not create a distinct session" };
        }
        const forkedSessionId = source.activeSessionId;
        this.registerRuntime(source, sessionId);

        // Pi Orbit enforces exclusive ownership of a persisted session. Fork
        // the source runtime first (which releases that ownership), then
        // recreate the original session in a separate runtime.
        const restored = await this.startRuntime(cwd, { ...source.config }, sessionPath);
        if ("error" in restored) {
          this.log("warn", `fork succeeded but the source session could not be restored: ${restored.error}`);
        } else {
          const restoredState = await this.refreshState(restored);
          if (restoredState.success && restored.activeSessionId === sessionId) this.registerRuntime(restored);
          else {
            await this.cleanupRuntime(restored);
            this.log("warn", "fork succeeded but the source session runtime returned a mismatched identity");
          }
        }
        invalidateSessionFileCache(cwd);
        return { ...result, sessionId: forkedSessionId };
      }
      const started = await this.startRuntime(cwd, { ...source.config });
      if ("error" in started) return started;
      const switched = await started.process.sendCommand("switch_session", { sessionPath });
      if (!switched.success) { await this.cleanupRuntime(started); return failure(switched, "unable to resume session for fork"); }
      const result = await started.process.sendCommand(entryId ? "fork" : "clone", entryId ? { entryId } : {});
      if (!result.success) { await this.cleanupRuntime(started); return result; }
      const state = await this.refreshState(started);
      if (!state.success || !started.activeSessionId || started.activeSessionId === sessionId) {
        await this.cleanupRuntime(started);
        return { success: false, code: "reconcile_failed", error: "fork did not create a distinct session" };
      }
      this.registerRuntime(started);
      invalidateSessionFileCache(cwd);
      return { ...result, sessionId: started.activeSessionId };
    });
  }

  async configure(sessionId: string, cwdValue: string, model: string, thinking?: string): Promise<PiResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    if (!model.includes("/")) return { success: false, code: "invalid_request", error: "model must use provider/model notation" };
    if (this.modelResources) {
      try { await this.modelResources.ensureMigrated(); }
      catch (error) { return { success: false, code: "model_resources_migration_failed", error: `unable to migrate model resources: ${error instanceof Error ? error.message : String(error)}` }; }
      model = canonicalRuntimeModelRef(model);
      if (model.startsWith("user-") && !(await this.modelResources.isModelAvailable(model))) return { success: false, code: "no_routable_endpoint", error: `model is not routable: ${model}` };
      // Pi only knows the projected runtime identity (split provider per
      // endpoint, aliased model id). The canonical ref stays user-facing.
      model = projectedRuntimeModelRef(model);
    }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const activated = await this.activateUnlocked(sessionId, cwd);
      if ("error" in activated) return activated;
      const ready = await this.reconcileForMutation(activated);
      if (!ready.success) return ready;
      const previous = { ...activated.config };
      const separator = model.indexOf("/");
      const provider = model.slice(0, separator);
      const modelId = model.slice(separator + 1);
      const modelResult = await activated.process.sendCommand("set_model", { provider, modelId });
      if (!modelResult.success && (provider.startsWith("custom-") || provider.startsWith("user-"))) {
        const oldSessionId = activated.activeSessionId;
        const restarted = await this.restartRuntimeUnlocked(activated, { ...effectiveConfig(), model, thinking: thinking || previous.thinking });
        if ("error" in restarted) return restarted;
        const verified = await this.refreshState(restarted);
        if (!verified.success || !this.configMatches(restarted, model, thinking)) {
          return { success: false, code: "reconcile_failed", error: "Pi runtime restarted but did not apply the requested model configuration" };
        }
        const normalized = this.toSessionState(restarted, verified.data as Record<string, unknown>);
        return { success: true, restarted: true, replacedBlank: oldSessionId !== restarted.activeSessionId, sessionId: restarted.activeSessionId, model: normalized.model, thinking: normalized.thinking, data: normalized };
      }
      if (!modelResult.success) return modelResult;
      if (thinking) {
        const thinkingResult = await activated.process.sendCommand("set_thinking_level", { level: thinking });
        if (!thinkingResult.success) {
          const rollback = await this.rollbackConfig(activated, previous);
          if (!rollback.success) return rollback;
          return thinkingResult;
        }
      }
      const state = await this.refreshState(activated);
      if (!state.success || !this.configMatches(activated, model, thinking)) {
        const rollback = await this.rollbackConfig(activated, previous);
        if (!rollback.success) return rollback;
        return { success: false, code: "reconcile_failed", error: "Pi runtime acknowledged the model change but its state did not match the requested configuration" };
      }
      activated.config = { ...activated.config, model, thinking: thinking || activated.config.thinking };
      const normalized = this.toSessionState(activated, state.data && typeof state.data === "object" ? state.data as Record<string, unknown> : {});
      return { success: true, restarted: false, sessionId: activated.activeSessionId, model: normalized.model, thinking: normalized.thinking, data: normalized };
    });
  }

  activeSessionId(cwdValue: string): string | null {
    try { return [...this.runtimes.values()].find((runtime) => runtime.cwd === resolve(cwdValue))?.activeSessionId ?? null; }
    catch { return null; }
  }

  liveSession(cwdValue: string): { id: string; cwd: string } | null {
    return this.liveSessions(cwdValue)[0] ?? null;
  }

  liveSessions(cwdValue: string): Array<{ id: string; cwd: string }> {
    try {
      const cwd = resolve(cwdValue);
      return [...this.runtimes.values()]
        .filter((runtime) => runtime.cwd === cwd && runtime.activeSessionId)
        .map((runtime) => ({ id: runtime.activeSessionId, cwd }));
    } catch { return []; }
  }

  async availableModels(cwdValue: string): Promise<PiResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    const runtime = [...this.runtimes.values()].find((candidate) => candidate.cwd === cwd && !candidate.closing);
    if (!runtime?.activeSessionId) return { success: false, code: "not_found", error: "pi process not found" };
    const key = runtimeKey(cwd, runtime.activeSessionId);
    return this.withLock(key, async () => {
      if (this.runtimes.get(key) !== runtime || runtime.closing) {
        return { success: false, code: "not_found", error: "pi process not found" };
      }
      this.scheduleIdleCleanup(runtime);
      return runtime.process.sendCommand("get_available_models");
    });
  }

  async availableThinkingLevels(cwdValue: string, expectedModel?: string): Promise<PiResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    const expectedCanonical = expectedModel ? canonicalRuntimeModelRef(expectedModel) : null;
    // Runtime state uses projected provider/model IDs. Compare canonical IDs so
    // split providers and model aliases still match the saved settings model.
    const candidates = [...this.runtimes.values()]
      .filter((candidate) => candidate.cwd === cwd && !candidate.closing && candidate.activeSessionId)
      .filter((candidate) => !expectedCanonical || canonicalFromRuntimeModelRef(candidate.config.model ?? "") === expectedCanonical);
    const runtime = candidates[0];
    if (!runtime) {
      return { success: false, code: expectedModel ? "model_mismatch" : "not_found", error: expectedModel ? "no runtime is using the requested model" : "pi process not found" };
    }
    const key = runtimeKey(cwd, runtime.activeSessionId);
    return this.withLock(key, async () => {
      if (this.runtimes.get(key) !== runtime || runtime.closing) {
        return { success: false, code: "not_found", error: "pi process not found" };
      }
      const state = await this.refreshState(runtime);
      if (!state.success || !state.data || typeof state.data !== "object") return state;
      const actualModel = runtime.config.model ? canonicalFromRuntimeModelRef(runtime.config.model) : null;
      if (expectedCanonical && actualModel !== expectedCanonical) {
        return { success: false, code: "model_mismatch", error: `runtime is using ${actualModel ?? "unknown"} instead of ${expectedCanonical}` };
      }
      this.scheduleIdleCleanup(runtime);
      const result = await runtime.process.sendCommand("get_available_thinking_levels");
      if (this.runtimes.get(key) !== runtime || runtime.closing) {
        return { success: false, code: "not_found", error: "pi process not found" };
      }
      if (!result.success || !result.data || typeof result.data !== "object") return result;
      return { success: true, data: { ...result.data, model: actualModel } };
    });
  }

  async exists(sessionId: string, cwdValue: string): Promise<boolean> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch { return false; }
    return (await this.repository.findPath(cwd, sessionId)) !== null;
  }

  async resume(sessionId: string, cwdValue: string): Promise<{ success: boolean; error?: string; code?: string }> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const activated = await this.activateUnlocked(sessionId, cwd);
      return "error" in activated ? activated : { success: true };
    });
  }

  async state(sessionId: string, cwdValue: string): Promise<SessionState | { error: string; code: string }> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { error: String(error), code: "workspace_invalid" }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const runtime = this.runtimes.get(runtimeKey(cwd, sessionId));
      if (!runtime) {
        const sessionPath = await this.repository.findPath(cwd, sessionId);
        if (!sessionPath) return { error: "session not found in this workspace", code: "not_found" };
        const config = effectiveConfig();
        return {
          id: sessionId,
          cwd,
          is_streaming: false,
          is_compacting: false,
          pending_message_count: 0,
          model: config.model ?? null,
          thinking: config.thinking ?? null,
          context_tokens: null,
          context_window: config.model_context_window ?? null,
          context_percent: null,
          compaction_enabled: config.compaction_enabled ?? true,
          compaction_threshold_percent: config.compaction_threshold_percent ?? null,
        };
      }
      const result = runtime.lastState && runtime.lastStateAt && Date.now() - runtime.lastStateAt < 500
        ? { success: true, data: runtime.lastState }
        : await this.refreshState(runtime);
      if (!result.success || !result.data || typeof result.data !== "object") return { error: String(result.error ?? "unable to read session state"), code: String(result.code ?? "runtime_error") };
      const stats = await runtime.process.sendCommand("get_session_stats");
      return this.toSessionState(
        runtime,
        result.data as Record<string, unknown>,
        stats.success && stats.data && typeof stats.data === "object" ? stats.data as Record<string, unknown> : undefined,
      );
    });
  }

  /** Whole-session cumulative stats (turns, tool calls, tokens, wall time).
   *  Live runtimes are read fresh from `get_session_stats`; idle sessions fall
   *  back to the persisted checkpoint, then to a fold of the session JSONL.
   *  The result is persisted so the next cold read is cheap and consistent. */
  async stats(sessionId: string, cwdValue: string): Promise<{ stats: SessionStats } | RuntimeFailure> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { error: String(error), code: "workspace_invalid" }; }
    return this.withLock(runtimeKey(cwd, sessionId), async () => {
      const runtime = this.runtimes.get(runtimeKey(cwd, sessionId));
      const stats = await this.collectStats(cwd, sessionId, runtime && runtime.activeSessionId === sessionId ? runtime : undefined);
      if (!stats) return { error: "session not found in this workspace", code: "not_found" };
      await saveSessionStats(cwd, sessionId, stats).catch(() => undefined);
      return { stats };
    });
  }

  private async collectStats(cwd: string, sessionId: string, runtime?: RuntimeRecord): Promise<SessionStats | null> {
    const key = runtimeKey(cwd, sessionId);
    const checkpoint = await loadSessionStats(cwd, sessionId).catch(() => null);
    // Backfill wall-clock timing from the durable normalized SSE records when
    // the raw-event projector had no timing to persist (id-less Pi Orbit web
    // events, sessions that predate the projector). Element-wise max with the
    // checkpoint keeps the checkpoint authoritative and never accumulates.
    const backfillTiming = await this.backfillTiming(cwd, sessionId);
    let runtimeData: Record<string, unknown> | undefined;
    if (runtime) {
      const result = await runtime.process.sendCommand("get_session_stats").catch(() => null);
      if (result?.success && result.data && typeof result.data === "object") {
        runtimeData = result.data as Record<string, unknown>;
      }
    }
    if (runtimeData) {
      // First `timingWithCheckpoint` call decides the checkpoint prefix for
      // this runtime generation: a fresh session (null checkpoint) ignores
      // its own later checkpoints; a rebuild generation folds the persisted
      // base in exactly once and the live tracker covers the suffix only.
      // The backfill is merged AFTER the tracker (never folded into it) so
      // live suffix events are counted once regardless of which source wins.
      const checkpointTiming = timingFromStats(checkpoint);
      const live = this.statsProjector.timingWithCheckpoint(key, checkpointTiming);
      return mergeSessionStats(runtimeData, maxTiming(live, backfillTiming));
    }
    if (checkpoint) {
      return { ...checkpoint, ...maxTiming(timingFromStats(checkpoint), backfillTiming) };
    }
    const path = await this.repository.findPath(cwd, sessionId);
    if (!path) return null;
    const folded = await foldSessionFileStats(path).catch(() => null);
    if (!folded) return null;
    return { ...folded, ...maxTiming(null, backfillTiming) };
  }

  /** Recover whole-session timing by folding the durable normalized SSE
   *  records for the session. Returns null when there is nothing to fold, so
   *  `maxTiming` treats the backfill as absent. */
  private async backfillTiming(cwd: string, sessionId: string): Promise<SessionTiming | null> {
    try {
      const records = await this.statsEventStore.readAfter(cwd, sessionId);
      if (!records || records.length === 0) return null;
      return foldEventRecordsTiming(records);
    } catch {
      return null;
    }
  }

  /** Refresh the whole-session counters from the runtime, persist the
   *  checkpoint, and push the live stats to subscribers so the composer stats
   *  line updates. Called at settled boundaries (message_end, tool end,
   *  agent_settled) — the same moments the DeepSeek harness refreshes its
   *  stats line — never per token. Runs under the runtime key lock so
   *  concurrent boundaries cannot race on the same `.tmp` checkpoint file.
   *  The lock is a promise chain: queued refreshes run in order, and the
   *  final agent_settled refresh is authoritative. */
  private refreshAndPublishStats(runtime: RuntimeRecord, sessionId: string): Promise<void> {
    return this.withLock(runtimeKey(runtime.cwd, sessionId), async () => {
      const stats = await this.collectStats(runtime.cwd, sessionId, runtime);
      if (!stats) return;
      await saveSessionStats(runtime.cwd, sessionId, stats).catch(() => undefined);
      await this.eventHub.publish(runtime.cwd, sessionId, { type: "session.stats", sessionId, stats }).catch(() => undefined);
    });
  }

  async delete(sessionId: string, cwdValue: string): Promise<{ success: boolean; error?: string; code?: string }> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const runtime = this.runtimes.get(runtimeKey(cwd, sessionId));
      if (runtime?.activeSessionId === sessionId) {
        if (runtime.busy) return { success: false, code: "busy", error: "cannot delete a conversation while it is running" };
        // Stop the runtime first: its JSONL is flushed by the dying process, so
        // the on-disk file may only exist (or be rewritten) after cleanup.
        await this.cleanupRuntime(runtime);
      }
      // After cleanup the disk is authoritative. Invalidate the scan cache so
      // the lookup below cannot be served from (or overwritten by) a stale
      // in-flight scan that predates the flush.
      invalidateSessionFileCache(cwd);
      const path = await this.repository.findPathOnDisk(cwd, sessionId);
      if (!path) {
        // The file is already gone (ghost 404) or was never durable — nothing
        // left to delete, so the delete itself succeeded.
        return { success: true };
      }
      try { await unlink(path); }
      catch (error) { return { success: false, code: "delete_failed", error: String(error) }; }
      invalidateSessionFileCache(cwd);
      await deleteSessionStats(cwd, sessionId);
      return { success: true };
    });
  }

  async reloadConfiguration(): Promise<Array<{ cwd: string; oldId: string; newId: string }>> {
    return this.withLock("\0configuration-reload", async () => {
      const runtimes = [...new Set(this.runtimes.values())];
      if (this.manager.hostProcessCount > 0) this.hostReloadPending = true;
      if (this.hostReloadPending && runtimes.some((runtime) => runtime.busy)) {
        for (const runtime of runtimes) runtime.restartPending = true;
        return [];
      }
      if (this.hostReloadPending) {
        await this.manager.recycleWebHost();
        this.hostReloadPending = false;
      }
      const replacements: Array<{ cwd: string; oldId: string; newId: string }> = [];
      const failures: Array<{ cwd: string; code: string; error: string }> = [];
      for (const [key, snapshot] of [...this.runtimes.entries()]) {
        const cwd = snapshot.cwd;
        const result = await this.withLock(key, async () => {
          const current = this.runtimes.get(key);
          if (current !== snapshot) return {};
          const runtime = current;
          if (!runtime) return {};
          if (runtime.busy) {
            runtime.restartPending = true;
            return {};
          }
          const oldId = runtime.activeSessionId;
          const restarted = await this.restartRuntimeUnlocked(runtime, effectiveConfig());
          if ("error" in restarted) return { failure: { cwd, code: restarted.code, error: restarted.error } };
          if (oldId && restarted.activeSessionId !== oldId) {
            return { replacement: { cwd, oldId, newId: restarted.activeSessionId } };
          }
          return {};
        });
        if (result.replacement) replacements.push(result.replacement);
        if (result.failure) failures.push(result.failure);
      }
      if (failures.length) {
        throw new Error(failures.map((item) => `${item.cwd}: ${item.code}: ${item.error}`).join("; "));
      }
      return replacements;
    });
  }

  async setGlobalSkillPolicy(policy: RuntimeSkillPolicy): Promise<void> {
    const runtimes = [...new Set(this.runtimes.values())];
    for (const runtime of runtimes) {
      const result = await this.withLock(runtimeKey(runtime.cwd, runtime.activeSessionId), async () => {
        if (runtime.busy) return { success: false, code: "runtime_busy", error: "Runtime is busy" };
        return runtime.process.setRuntimeSkillPolicy(policy);
      });
      if (!result.success) throw Object.assign(new Error(String(result.error ?? "Unable to update runtime skills")), { code: String(result.code ?? "runtime_error") });
    }
  }

  async refreshAllRuntimeSkills(): Promise<void> {
    const runtimes = [...new Set(this.runtimes.values())];
    for (const runtime of runtimes) {
      const result = await this.withLock(runtimeKey(runtime.cwd, runtime.activeSessionId), async () => {
        if (runtime.busy) return { success: false, code: "runtime_busy", error: "Runtime is busy" };
        return runtime.process.refreshRuntimeSkills();
      });
      if (!result.success) throw Object.assign(new Error(String(result.error ?? "Unable to refresh runtime skills")), { code: String(result.code ?? "runtime_error") });
    }
  }

  async shutdownAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.closing = true;
      this.clearIdleTimer(runtime);
      this.clearEventWatchdog(runtime);
      this.eventHub.expectExit(runtime.process);
    }
    await this.manager.shutdownAll();
    await this.eventHub.flush();
    this.runtimes.clear();
  }

  get activeCount(): number { return this.runtimes.size; }
  get processCount(): number { return this.manager.processCount; }

  private async ensureModelResources(): Promise<RuntimeFailure | null> {
    if (!this.modelResources) return null;
    try {
      await this.modelResources.ensureMigrated();
      return null;
    } catch (error) {
      return { error: `unable to migrate model resources: ${error instanceof Error ? error.message : String(error)}`, code: "model_resources_migration_failed" };
    }
  }

  private async activateUnlocked(sessionId: string, cwd: string): Promise<RuntimeRecord | ServiceFailure> {
    const key = runtimeKey(cwd, sessionId);
    let runtime = this.runtimes.get(key);
    if (runtime) {
      if (runtime.activeSessionId !== sessionId) {
        await this.cleanupRuntime(runtime);
        runtime = undefined;
      } else {
        this.scheduleIdleCleanup(runtime);
        return runtime;
      }
    }
    const sessionPath = await this.repository.findPath(cwd, sessionId);
    if (!sessionPath) return { success: false, code: "not_found", error: "session not found in this workspace" };
    const migration = await this.ensureModelResources();
    if (migration) return { success: false, ...migration };
    const config = effectiveConfig();
    const started = await this.startRuntime(cwd, config);
    if ("error" in started) return { success: false, ...started };
    runtime = started;
    // The restored session's jsonl may carry model_change events from
    // session-local switching; the workspace configuration must win, so the
    // model/thinking are re-applied after the switch and before the state
    // read that confirms the resume.
    const resumed = await this.resumeSessionWithConfig(runtime, sessionPath, config);
    if (!resumed.success) { await this.cleanupRuntime(runtime); return failure(resumed, "unable to resume session"); }
    if (runtime.activeSessionId !== sessionId) { await this.cleanupRuntime(runtime); return { success: false, code: "session_mismatch", error: "runtime resumed a different session" }; }
    this.registerRuntime(runtime);
    return runtime;
  }

  private async startRuntime(cwd: string, config: PiConfig, sessionPath?: string, preparedOptions?: PiProcessOptions): Promise<RuntimeRecord | RuntimeFailure> {
    try { await this.beforeRuntimeStart?.(cwd); }
    catch (error) { return { error: `unable to materialize runtime configuration: ${String(error)}`, code: "configuration_failed" }; }
    const migration = await this.ensureModelResources();
    if (migration) return migration;
    if (this.modelResources && config.model && config.model.startsWith("user-") && !(await this.modelResources.isModelAvailable(config.model))) {
      return { error: `model is not routable: ${config.model}`, code: "no_routable_endpoint" };
    }
    let options: PiProcessOptions | null;
    if (preparedOptions) options = preparedOptions;
    else {
      if (!nodeProcess.env.PI_CLI_PATH) return { error: "PI_CLI_PATH is not configured", code: "spawn_failed" };
      let environment: NodeJS.ProcessEnv;
      try { environment = await this.environments.environment(cwd); }
      catch (error) { return { error: `unable to prepare isolated workspace environment: ${String(error)}`, code: "environment_failed" }; }
      try { options = buildPiProcessOptions(cwd, config, sessionPath, environment); }
      catch (error) { return { error: `unable to prepare Pi runtime configuration: ${String(error)}`, code: "configuration_failed" }; }
    }
    if (!options) return { error: "PI_CLI_PATH is not configured", code: "spawn_failed" };
    let process: PiProcess;
    const managerKey = randomUUID();
    try { process = await this.manager.start(managerKey, options); }
    catch (error) {
      if (error instanceof PiOrbitRequestError) {
        const detail = firstErrorDiagnostic(error.payload.diagnostics);
        return {
          error: detail
            ? `unable to start Pi Orbit runtime: ${error.message}: ${detail}`
            : `unable to start Pi Orbit runtime: ${error.message}`,
          code: error.code,
          ...(error.payload.diagnostics === undefined ? {} : { diagnostics: error.payload.diagnostics }),
        };
      }
      return { error: `unable to start Pi runtime: ${String(error)}`, code: "spawn_failed" };
    }
    const runtime: RuntimeRecord = { cwd, managerKey, process, activeSessionId: "", config: { ...config }, busy: false, restartPending: false, closing: false };
    this.eventHub.bind(cwd, process, {
      activeSessionId: () => runtime.activeSessionId || null,
      onBusy: (busy) => {
        // agent_start/agent_settled are authoritative runtime events. They
        // invalidate any in-flight reconciliation so a late get_state result
        // cannot publish a synthetic terminal event for the next turn.
        this.invalidatePendingOperation(runtime);
        // The lifecycle event is newer than any cached get_state snapshot.
        // Without invalidation, a refresh within the 500 ms cache window can
        // restore an already-settled turn as streaming; its terminal SSE event
        // has passed, so the browser then remains stuck on Working forever.
        runtime.lastState = undefined;
        runtime.lastStateAt = undefined;
        runtime.busy = busy;
        if (busy) {
          // The turn is running: keep the event-stream watchdog armed so a
          // silently dead stream is detected and revived mid-turn.
          this.scheduleEventWatchdog(runtime);
        } else if (runtime.restartPending) {
          queueMicrotask(() => {
            void this.reloadRuntimeAfterTurn(runtime).catch((error: unknown) => {
              this.log("error", `failed to reload Pi runtime after turn: ${error instanceof Error ? error.message : String(error)}`);
            });
          });
        } else {
          this.scheduleIdleCleanup(runtime);
        }
      },
      onExit: () => {
        runtime.closing = true;
        this.clearIdleTimer(runtime);
        for (const [key, current] of this.runtimes) {
          if (current === runtime && current.process === process) this.runtimes.delete(key);
        }
      },
      observe: async (event, sessionId) => {
        await observeNodePiEvent(cwd, runtime.config.model ?? null, event, sessionId, (payload) => this.eventHub.publish(cwd, sessionId, payload));
        this.statsProjector.track(runtimeKey(cwd, sessionId), event, Date.now());
        // DeepSeek refreshes its stats line at settled boundaries (assistant
        // message done, tool/result done), not per token. Mirror that: refresh
        // after each completed assistant message and completed tool execution;
        // agent_settled below stays the final authoritative refresh.
        if (event.type === "message_end" || event.type === "tool_execution_end") {
          void this.refreshAndPublishStats(runtime, sessionId).catch((error: unknown) => {
            this.log("warn", `failed to refresh session stats for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (event.type === "agent_start") {
          runtime.turnId = randomUUID();
          runtime.turnBaseline = snapshotWorkspace(cwd);
          runtime.turnAssistantPartId = undefined;
          // Derive the ordinal from persisted records so it keeps counting
          // across runtime rebuilds (idle cleanup, restarts); the in-memory
          // field alone would reset to 1 and misanchor strips for later turns.
          runtime.turnOrdinal = await turnArtifactRepository
            .nextTurnOrdinal(runtime.cwd, sessionId)
            .catch(() => (runtime.turnOrdinal ?? 0) + 1);
        }
        // Pi's raw event type is "message_update" with an inner
        // assistantMessageEvent (text_delta/text/text_end); the hub normalizes
        // these to text.updated with partId = message.id. Listen on the raw
        // shape so the anchor is the last assistant message of the turn.
        if (event.type === "message_update") {
          const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined;
          const message = event.message as Record<string, unknown> | undefined;
          const kind = String(assistant?.type ?? "");
          if (["text_delta", "text", "text_end"].includes(kind)) {
            const messageId = typeof message?.id === "string" && message.id ? message.id : "";
            if (messageId) runtime.turnAssistantPartId = messageId;
          }
        }
        if (event.type === "agent_settled") {
          await this.finishTurnArtifacts(runtime, event, sessionId);
          this.scheduleAutoReview(cwd, sessionId);
          void this.refreshAndPublishStats(runtime, sessionId).catch((error: unknown) => {
            this.log("warn", `failed to refresh settled session stats for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    });
    return runtime;
  }

  private async reloadRuntimeAfterTurn(runtime: RuntimeRecord): Promise<void> {
    if (this.hostReloadPending) {
      if ([...new Set(this.runtimes.values())].some((candidate) => candidate.busy)) return;
      try { await this.reloadConfiguration(); }
      catch (error) {
        if (runtime.activeSessionId) await this.eventHub.publish(runtime.cwd, runtime.activeSessionId, { type: "error", sessionId: runtime.activeSessionId, message: `Failed to reload Pi runtime after settings changed: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    await this.withLock(runtimeKey(runtime.cwd, runtime.activeSessionId), async () => {
      if (this.runtimes.get(runtimeKey(runtime.cwd, runtime.activeSessionId)) !== runtime || runtime.busy) return;
      const oldId = runtime.activeSessionId;
      const restarted = await this.restartRuntimeUnlocked(runtime, effectiveConfig());
      if ("error" in restarted) {
        if (oldId) await this.eventHub.publish(runtime.cwd, oldId, { type: "error", sessionId: oldId, message: `Failed to reload Pi runtime after settings changed: ${restarted.error}` });
      }
    });
  }

  /** Standby per-turn tracking captured at prompt-accept time. The Pi event
   *  stream is the authoritative turn signal, but when it dies (silently, no
   *  exception) agent_start/agent_settled never arrive and the turn bookkeeping
   *  never starts. Recording a baseline snapshot + JSONL cursor here gives the
   *  reconciliation probe enough evidence to recover the artifact summary.
   *  A real agent_start overwrites these fields with fresh turn values. */
  private recordAcceptTurnBaseline(runtime: RuntimeRecord): void {
    if (runtime.operationPending !== "prompt" || !runtime.activeSessionId) return;
    runtime.turnId ??= randomUUID();
    runtime.turnBaseline ??= snapshotWorkspace(runtime.cwd);
    runtime.acceptSnapshot = this.repository
      .messagesPage(runtime.cwd, runtime.activeSessionId, { limit: 1 })
      .then((page) => {
        const last = page.messages[page.messages.length - 1];
        return { version: page.snapshot_version, role: last?.role ?? null, id: last?.id ?? null };
      })
      .catch(() => null);
  }

  /** Compare the message file against the accept-time cursor: any version
   *  change whose newest message is an assistant reply proves the accepted
   *  prompt actually produced a turn, even with a dead event stream. */
  private async turnCompletedEvidence(runtime: RuntimeRecord): Promise<"none" | "completed" | "unknown"> {
    const accept = runtime.acceptSnapshot;
    if (!accept) return "unknown";
    const before = await accept;
    if (!before) return "unknown";
    const page = await this.repository.messagesPage(runtime.cwd, runtime.activeSessionId, { limit: 1 }).catch(() => null);
    if (!page) return "unknown";
    if (page.snapshot_version === before.version) return "none";
    const last = page.messages[page.messages.length - 1];
    return last?.role === "assistant" ? "completed" : "none";
  }

  private beginPendingOperation(runtime: RuntimeRecord, operation: PendingOperation): void {
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    runtime.reconcileTimer = undefined;
    runtime.operationToken = randomUUID();
    runtime.operationPending = operation;
    runtime.operationDeadline = Date.now() + reconciliationDeadlineMs();
    runtime.reconcileAttempts = 0;
    runtime.reconcileFromTimeout = false;
    runtime.busy = true;
    this.scheduleEventWatchdog(runtime);
  }

  /** Start (or extend) the event-stream watchdog while an operation is in
   *  flight. Pure-idle runtimes never run it: zero events are the normal idle
   *  state. Only Pi Orbit runtimes have an event stream to watch. */
  private scheduleEventWatchdog(runtime: RuntimeRecord): void {
    if (runtime.watchdogTimer) clearTimeout(runtime.watchdogTimer);
    runtime.watchdogTimer = undefined;
    const intervalMs = eventWatchdogMs();
    if (intervalMs <= 0 || !runtime.process.attachedToHost) return;
    if (runtime.closing || (!runtime.busy && !runtime.operationPending)) return;
    runtime.watchdogTimer = setTimeout(() => {
      runtime.watchdogTimer = undefined;
      void this.runEventWatchdog(runtime).catch((error: unknown) => {
        this.log("error", `Pi Orbit event watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!runtime.closing) this.scheduleEventWatchdog(runtime);
      });
    }, intervalMs);
  }

  private clearEventWatchdog(runtime: RuntimeRecord): void {
    if (runtime.watchdogTimer) clearTimeout(runtime.watchdogTimer);
    runtime.watchdogTimer = undefined;
  }

  private async runEventWatchdog(runtime: RuntimeRecord): Promise<void> {
    if (runtime.closing || (!runtime.busy && !runtime.operationPending)) return;
    // A live stream keeps lastEventAt fresh. Anything that arrived within the
    // interval is proof of life; re-arm and move on.
    if (runtime.process.lastEventAt > 0 && Date.now() - runtime.process.lastEventAt < eventWatchdogMs()) {
      this.scheduleEventWatchdog(runtime);
      return;
    }
    // Stream silent for the whole window while work is supposed to happen:
    // revive the connection first (cheap, never hold the lock on the
    // untimeoutable request), escalating to a runtime restart only when the
    // runtime also stops answering get_state.
    const reconnects = runtime.watchdogReconnects ?? 0;
    if (reconnects < 2) {
      runtime.watchdogReconnects = reconnects + 1;
      this.log("warn", `Pi Orbit event stream silent for ${eventWatchdogMs()}ms while busy; reconnecting (attempt ${reconnects + 1})`);
      void runtime.process.reconnectEventStream().catch((error: unknown) => {
        this.log("warn", `Pi Orbit event stream reconnect failed: ${String(error)}`);
      });
      this.scheduleEventWatchdog(runtime);
      return;
    }
    // Reconnects exhausted: confirm the runtime is unresponsive before
    // restarting it (a busy-but-answering runtime must never be torn down).
    const state = await runtime.process.sendCommand("get_state");
    if (state.success) {
      this.scheduleEventWatchdog(runtime);
      return;
    }
    const key = runtimeKey(runtime.cwd, runtime.activeSessionId);
    await this.withLock(key, async () => {
      const current = this.runtimes.get(key);
      if (current !== runtime || runtime.closing) return;
      const sessionId = runtime.activeSessionId;
      const config = { ...runtime.config };
      this.log("warn", `Pi Orbit runtime unresponsive (event stream dead, get_state failed); restarting runtime for ${sessionId}`);
      this.resetPendingOperationState(runtime);
      const restarted = await this.restartRuntimeUnlocked(runtime, config);
      if ("error" in restarted && sessionId) {
        await this.eventHub.publish(runtime.cwd, sessionId, {
          type: "error",
          sessionId,
          message: `Unable to restart unresponsive Pi runtime: ${restarted.error}`,
          terminal: true,
        });
      }
    });
  }

  private invalidatePendingOperation(runtime: RuntimeRecord): void {
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    runtime.reconcileTimer = undefined;
    runtime.operationToken = undefined;
    runtime.operationPending = undefined;
    runtime.operationDeadline = undefined;
    this.clearEventWatchdog(runtime);
  }

  private resetPendingOperationState(runtime: RuntimeRecord): void {
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    runtime.reconcileTimer = undefined;
    runtime.operationPending = undefined;
    runtime.operationDeadline = undefined;
    runtime.reconcileAttempts = 0;
    runtime.reconcileFromTimeout = false;
    runtime.busy = false;
    this.clearEventWatchdog(runtime);
    runtime.watchdogReconnects = 0;
  }

  private clearPendingOperation(runtime: RuntimeRecord): void {
    this.resetPendingOperationState(runtime);
    runtime.operationToken = undefined;
  }

  private isCurrentPendingOperation(runtime: RuntimeRecord, token: string): boolean {
    return runtime.operationToken === token && runtime.operationPending !== undefined;
  }

  private scheduleOperationReconciliation(runtime: RuntimeRecord, immediate: boolean): void {
    const operationToken = runtime.operationToken;
    if (!operationToken || !runtime.operationPending) return;
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    const deadline = runtime.operationDeadline ?? Date.now();
    const delay = immediate ? 0 : reconciliationDelayMs();
    const remaining = Math.max(0, deadline - Date.now());
    // Do not schedule a probe whose configured delay cannot fit entirely
    // before the deadline. Scheduling it at the deadline creates a race where
    // a timer that fires just early can still issue one late reconciliation
    // request under CI or a busy event loop.
    const probeAllowed = immediate || delay < remaining;
    const timerDelay = immediate ? 0 : probeAllowed ? delay : remaining + 1;
    runtime.reconcileTimer = setTimeout(() => {
      runtime.reconcileTimer = undefined;
      void this.withLock(runtimeKey(runtime.cwd, runtime.activeSessionId), async () => {
        const current = this.runtimes.get(runtimeKey(runtime.cwd, runtime.activeSessionId));
        if (current !== runtime || !this.isCurrentPendingOperation(runtime, operationToken)) return;
        // Never start a new probe after the deadline. The deadline check is
        // deliberately at callback entry because the timer can be delayed by
        // process scheduling or a preceding lock holder.
        const state = probeAllowed && Date.now() < (runtime.operationDeadline ?? 0)
          ? await runtime.process.sendCommand("get_state")
          : null;
        // A runtime event may have invalidated this reconciliation while the
        // state RPC was in flight. Never act on that stale result.
        if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
        const data = state?.data && typeof state.data === "object" ? state.data as Record<string, unknown> : {};
        const active = Boolean(data.busy) || Boolean(data.isStreaming) || Boolean(data.isCompacting) || Number(data.pendingMessageCount ?? 0) > 0;
        if (state?.success && active && Date.now() < (runtime.operationDeadline ?? 0)) {
          runtime.reconcileAttempts = 0;
          runtime.busy = true;
          this.scheduleOperationReconciliation(runtime, false);
          return;
        }
        if (state && !state.success && Date.now() < (runtime.operationDeadline ?? 0)) {
          runtime.reconcileAttempts = 0;
          this.scheduleOperationReconciliation(runtime, false);
          return;
        }
        const operation = runtime.operationPending;
        if (!state || (state.success && !active)) {
          // Message-side evidence: when the Pi event stream dies, agent_start/
          // agent_settled never arrive and the get_state probe stays idle even
          // though the turn actually ran (messages were appended to the session
          // JSONL by Pi Orbit). Compare a fresh tail read against the cursor
          // captured at accept time: a new assistant message proves completion
          // and lets us recover the artifact summary + end the operation
          // normally instead of misreporting did-not-start.
          if (operation === "prompt" && (await this.turnCompletedEvidence(runtime)) === "completed") {
            if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
            await this.finishTurnArtifacts(runtime, {}, runtime.activeSessionId).catch(() => undefined);
            if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
            await this.eventHub.publish(runtime.cwd, runtime.activeSessionId, {
              type: "session.idle",
              sessionId: runtime.activeSessionId,
            }, () => this.isCurrentPendingOperation(runtime, operationToken));
            if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
            this.clearPendingOperation(runtime);
            return;
          }
          // An accepted prompt/compact may remain idle while Pi Orbit resumes
          // a session or warms a model. This startup window is not a timeout for
          // the full agent response. Attempts are diagnostic only: keep probing
          // until the operation deadline. Transport-timeout acks are
          // explicitly fail-fast and do not enter this retry window. When a
          // delayed timer reaches the deadline without a probe, enter this
          // same terminal path directly.
          runtime.reconcileAttempts = (runtime.reconcileAttempts ?? 0) + 1;
          if (!runtime.reconcileFromTimeout && state && Date.now() < (runtime.operationDeadline ?? 0)) {
            runtime.busy = true;
            this.scheduleOperationReconciliation(runtime, false);
            return;
          }
          // Check the token immediately before terminal reconciliation and
          // before each synthetic event. A late agent_start invalidates it.
          if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
          const shouldPublish = () => this.isCurrentPendingOperation(runtime, operationToken);
          if (operation === "prompt") {
            await this.eventHub.publish(runtime.cwd, runtime.activeSessionId, {
              type: "error",
              sessionId: runtime.activeSessionId,
              message: "The prompt was accepted but the Pi runtime did not start an agent turn.",
            }, shouldPublish);
            if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
            await this.eventHub.publish(runtime.cwd, runtime.activeSessionId, { type: "session.idle", sessionId: runtime.activeSessionId }, shouldPublish);
            // The synthetic idle event resets the pending operation state via
            // the normal runtime-event path. Its generation token must still
            // be cleared here unless a newer operation replaced it.
            if (runtime.operationToken !== operationToken) return;
          }
          if (runtime.operationToken !== operationToken) return;
          this.clearPendingOperation(runtime);
          return;
        }
        if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
        runtime.reconcileAttempts = 0;
        const sessionId = runtime.activeSessionId;
        const config = { ...runtime.config };
        // Restart needs the operation state cleared so it can proceed, but
        // retain the generation token until its failure event is published.
        // A late runtime event can still invalidate that token in the window.
        this.resetPendingOperationState(runtime);
        const restarted = await this.restartRuntimeUnlocked(runtime, config);
        if ("error" in restarted && sessionId && runtime.operationToken === operationToken) {
          await this.eventHub.publish(runtime.cwd, sessionId, {
            type: "error",
            sessionId,
            message: `Unable to safely reconcile timed-out ${operation} operation: ${restarted.error}`,
            terminal: true,
          }, () => runtime.operationToken === operationToken);
        }
        this.clearPendingOperation(runtime);
      }).catch(async (error: unknown) => {
        this.log("error", `operation reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!this.isCurrentPendingOperation(runtime, operationToken)) return;
        const sessionId = runtime.activeSessionId;
        this.clearPendingOperation(runtime);
        await this.eventHub.publish(runtime.cwd, sessionId, {
          type: "error",
          sessionId,
          message: `Unable to reconcile the accepted operation: ${error instanceof Error ? error.message : String(error)}`,
          terminal: true,
        }).catch(() => undefined);
      });
    }, timerDelay);
  }

  /** Turn-level artifact summary: diff the workspace snapshot taken at
   *  agent_start against the state at agent_settled, attach persisted
   *  artifact ids when available, persist a turn-artifacts record and publish
   *  `turn.artifacts` for the frontend strip. Failures degrade to nothing
   *  (the conversation itself is the source of truth for the turn).
   *
   *  Known limitation: the baseline/after snapshots are workspace-wide, so
   *  with parallel sessions in the same workspace a file created by another
   *  session's turn can be attributed to this turn. Consumers display the
   *  strip per session (session_id is persisted and published), so the
   *  mis-attribution is cosmetic only. */
  private async finishTurnArtifacts(runtime: RuntimeRecord, event: Record<string, unknown>, sessionId: string): Promise<void> {
    const turnId = runtime.turnId;
    if (!turnId) return;
    runtime.turnId = undefined;
    const baseline = runtime.turnBaseline;
    runtime.turnBaseline = undefined;
    if (!baseline) return;
    const before = await baseline;
    const after = await snapshotWorkspace(runtime.cwd);
    if (!after) return;
    const { created, modified } = diffWorkspaceSnapshots(before, after);
    const changed = [...created, ...modified];
    if (changed.length === 0) return;
    const items = await this.toTurnArtifactItems(runtime.cwd, changed);
    if (items.length === 0) return;
    // The tracked last assistant message id of this turn is the most accurate
    // anchor (PRD: artifact cards must land after the turn's FINAL assistant
    // message). A settled event's own ids may point to an earlier message of
    // a multi-message turn, so they are consulted only as secondary fallbacks.
    const assistantMessageId = runtime.turnAssistantPartId
      ?? (typeof event.assistantMessageId === "string"
        ? event.assistantMessageId
        : typeof event.messageId === "string"
          ? event.messageId
          : null);
    const turnOrdinal = runtime.turnOrdinal ?? null;
    const record = {
      turn_id: turnId,
      session_id: sessionId,
      assistant_message_id: assistantMessageId,
      turn_ordinal: turnOrdinal,
      ended_at: new Date().toISOString(),
      artifacts: items,
    };
    // Defensive idempotency: a reconciliation-recovered turn and a late
    // (replayed) agent_settled could both carry the same turn id; never append
    // a duplicate record for one turn.
    const existing = await turnArtifactRepository.forSession(runtime.cwd, sessionId).catch(() => []);
    if (!existing.some((r) => r.turn_id === turnId)) {
      await turnArtifactRepository.append(runtime.cwd, record).catch(() => undefined);
    }
    await this.eventHub.publish(runtime.cwd, sessionId, {
      type: "turn.artifacts",
      sessionId,
      turnId,
      turnOrdinal,
      assistantMessageId,
      artifacts: items,
    }).catch(() => undefined);
  }

  private async toTurnArtifactItems(cwd: string, entries: WorkspaceSnapshotEntry[]): Promise<Array<{ path: string; kind: string; mime: string; size: number; artifactId?: string; version?: number }>> {
    let manifests: Array<{ artifact_id?: string; version?: unknown; path?: unknown }> = [];
    try {
      manifests = await readJsonLines<{ artifact_id?: string; version?: unknown; path?: unknown }>(workspaceFile(cwd, "artifacts.jsonl"));
    } catch {
      manifests = [];
    }
    const byPath = new Map<string, { artifactId: string; version: number }>();
    for (const manifest of manifests) {
      const path = typeof manifest.path === "string" ? manifest.path : "";
      if (!path || typeof manifest.artifact_id !== "string") continue;
      byPath.set(path, { artifactId: manifest.artifact_id, version: Number(manifest.version ?? 0) });
    }
    return entries
      .map((entry) => {
        const manifest = byPath.get(entry.path);
        return {
          path: entry.path,
          kind: previewKind(entry.path),
          mime: previewMime(entry.path),
          size: entry.size,
          ...(manifest ? { artifactId: manifest.artifactId, version: manifest.version } : {}),
        };
      })
      .sort((a, b) => b.size - a.size)
      .slice(0, 12);
  }

  /** One auto review per settled turn: a second settle for a session whose
   *  review is still in flight is dropped, and the reviewer itself is
   *  single-flight per workspace and gated on policy.auto_review. */
  private scheduleAutoReview(cwd: string, sessionId: string): void {
    const review = this.projectReview;
    if (!review || !sessionId) return;
    const key = runtimeKey(cwd, sessionId);
    if (this.autoReviews.has(key)) return;
    this.autoReviews.add(key);
    void review.run(cwd, { sessionId, trigger: "auto" })
      .catch((error: unknown) => this.log("warn", `automatic project review failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.autoReviews.delete(key));
  }

  private async restartRuntimeUnlocked(runtime: RuntimeRecord, config: PiConfig): Promise<RuntimeRecord | ServiceFailure> {
    const cwd = runtime.cwd;
    if (runtime.busy) return { success: false, code: "busy", error: "agent is busy" };
    const oldId = runtime.activeSessionId;
    const oldConfig = { ...runtime.config };
    const restartPending = runtime.restartPending;
    const sessionPath = runtime.activeSessionId ? await this.repository.findPath(cwd, runtime.activeSessionId) : null;
    let options: PiProcessOptions | null;
    try { options = buildPiProcessOptions(cwd, config, undefined, await this.environments.environment(cwd)); }
    catch (error) { return { success: false, code: "configuration_failed", error: `unable to prepare Pi runtime configuration: ${String(error)}` }; }
    if (!options) return { success: false, code: "spawn_failed", error: "PI_CLI_PATH is not configured" };
    this.eventHub.expectExit(runtime.process);
    await this.manager.stop(runtime.managerKey);
    for (const [key, current] of this.runtimes) {
      if (current === runtime) this.runtimes.delete(key);
    }
    const started = await this.startRuntime(cwd, config, undefined, options);
    if (!("error" in started)) {
      // The restored session's jsonl may carry model_change events from
      // session-local switching; the workspace configuration must win after a
      // settings-driven reload, so re-apply model/thinking after the switch
      // and only then confirm the state.
      const state = await this.resumeSessionWithConfig(started, sessionPath, config);
      if (state.success && started.activeSessionId) {
        started.restartPending = false;
        this.registerRuntime(started, oldId);
        if (oldId && started.activeSessionId !== oldId) await this.publishReplacement(cwd, oldId, started.activeSessionId);
        return started;
      }
      await this.cleanupRuntime(started);
      const originalFailure = failure(state, "unable to restart Pi runtime");
      await this.restoreRuntimeAfterFailedRestart(cwd, oldConfig, sessionPath, restartPending);
      return originalFailure;
    }
    await this.restoreRuntimeAfterFailedRestart(cwd, oldConfig, sessionPath, restartPending);
    return { success: false, ...started };
  }

  private async applyConfig(runtime: RuntimeRecord, config: PiConfig): Promise<PiResult> {
    const replayed = await this.replaySessionConfig(runtime.process, config);
    if (!replayed.success) return replayed;
    const state = await this.refreshState(runtime);
    if (!state.success) return failure(state, "unable to confirm session configuration");
    if (!this.configMatches(runtime, config.model ?? undefined, config.thinking ?? undefined)) {
      return { success: false, code: "reconcile_failed", error: "Pi runtime state does not match the requested session configuration" };
    }
    runtime.config = { ...config };
    return { success: true };
  }

  /** Re-apply a workspace config's model + thinking on a live runtime. The
   *  restored session jsonl may carry model_change events from session-local
   *  switching; the workspace configuration must win on every recovery path.
   *  Fails fast on the first rejected step (after transient busy retries) and
   *  leaves the runtime untouched. */
  private async replaySessionConfig(process: PiProcess, config: PiConfig): Promise<PiResult> {
    const model = config.model ? projectedRuntimeModelRef(config.model) : null;
    if (model?.includes("/")) {
      const separator = model.indexOf("/");
      const result = await this.sendRecoveryCommand(process, "set_model", {
        provider: model.slice(0, separator),
        modelId: model.slice(separator + 1),
      });
      if (!result.success) return result;
    }
    if (config.thinking) {
      const result = await this.sendRecoveryCommand(process, "set_thinking_level", { level: config.thinking });
      if (!result.success) return result;
    }
    return { success: true };
  }

  /** Send one recovery command with a bounded retry on transient busy
   *  responses. Right after switch_session the Pi Orbit runtime may still be
   *  settling and reject config commands with runtime_busy; a short retry
   *  absorbs that window. Any other failure (unknown model, unreadable
   *  session) is a config/session error and fails fast — the recovery path
   *  must never silently continue on a model the runtime rejected. */
  private async sendRecoveryCommand(process: PiProcess, type: string, params: Record<string, unknown>): Promise<PiResult> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await process.sendCommand(type, params);
      if (result.success || (result.code !== "runtime_busy" && result.code !== "busy")) return result;
      if (attempt >= recoveryBusyRetryAttempts()) return result;
      await new Promise((resolve) => setTimeout(resolve, recoveryBusyRetryDelayMs()));
    }
  }

  /** Switch a freshly started runtime to a persisted session, re-apply the
   *  workspace configuration, and only then read state — the same recovery
   *  sequence every resume/restart path uses so the workspace config is never
   *  shadowed by session-local model records. */
  private async resumeSessionWithConfig(runtime: RuntimeRecord, sessionPath: string | null, config: PiConfig): Promise<PiResult> {
    const switched = sessionPath
      ? await this.sendRecoveryCommand(runtime.process, "switch_session", { sessionPath })
      : { success: true };
    if (!switched.success) return switched;
    const replayed = await this.replaySessionConfig(runtime.process, config);
    if (!replayed.success) return replayed;
    return this.refreshState(runtime);
  }

  /** Prompt-time event-stream health check (item 5). A KNOWN-dead stream
   *  (was alive, then failed: eventStreamAlive === false with lastEventAt > 0)
   *  is reconnected before the mutation is sent; if the runtime also stops
   *  answering get_state it is restarted (reconcileForMutation has already
   *  guaranteed !busy). Freshly started runtimes (never connected,
   *  lastEventAt === 0) and alive streams are left alone; a stale-but-alive
   *  stream is only logged. Runs inside the mutation lock, so the reconnect
   *  race is bounded to 5s because the underlying events request has no
   *  timeout of its own. */
  private async ensureHealthyEventStream(runtime: RuntimeRecord, type: string): Promise<PiResult> {
    const process = runtime.process;
    if (!process.attachedToHost) return { success: true };
    if (process.eventStreamAlive) {
      if (process.lastEventAt > 0 && Date.now() - process.lastEventAt > eventWatchdogMs() * 2) {
        this.log("warn", `Pi Orbit event stream stale (${Math.round((Date.now() - process.lastEventAt) / 1000)}s of silence) before ${type}; continuing`);
      }
      return { success: true };
    }
    if (!process.lastEventAt) return { success: true }; // still establishing
    this.log("warn", `Pi Orbit event stream dead before ${type}; reconnecting`);
    try {
      await Promise.race([
        process.reconnectEventStream(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("event stream reconnect timed out after 5s")), 5_000);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.log("warn", `Pi Orbit event stream reconnect failed: ${String(error)}`);
    }
    const state = await process.sendCommand("get_state");
    if (state.success) return { success: true, data: state.data };
    this.log("warn", `Pi Orbit runtime unresponsive before ${type} (get_state failed after reconnect); restarting`);
    const config = { ...runtime.config };
    const oldId = runtime.activeSessionId;
    const restarted = await this.restartRuntimeUnlocked(runtime, config);
    if ("error" in restarted) {
      return { success: false, code: "runtime_restart_failed", error: `unable to restart runtime before ${type}: ${restarted.error}` };
    }
    if (oldId && restarted.activeSessionId !== oldId) {
      return { success: false, code: "session_mismatch", error: `runtime restarted but session identity changed (${oldId} -> ${restarted.activeSessionId})` };
    }
    this.log("info", `Pi Orbit runtime restarted before ${type} (event stream was dead)`);
    return { success: true };
  }

  private async reconcileForMutation(runtime: RuntimeRecord): Promise<PiResult> {
    const state = await this.refreshState(runtime);
    if (!state.success || !state.data || typeof state.data !== "object") return failure(state, "unable to confirm runtime state before mutation");
    if (runtime.busy) return { success: false, code: "busy", error: "agent is busy; wait for the current task to finish or stop it" };
    return { success: true, data: state.data };
  }

  private configMatches(runtime: RuntimeRecord, model?: string | null, thinking?: string | null): boolean {
    const runtimeModel = model ? projectedRuntimeModelRef(model) : null;
    return (!runtimeModel || runtime.config.model === runtimeModel) && (!thinking || runtime.config.thinking === thinking);
  }

  private async rollbackConfig(runtime: RuntimeRecord, previous: PiConfig): Promise<PiResult> {
    if (previous.model?.includes("/")) {
      const model = projectedRuntimeModelRef(previous.model);
      const separator = model.indexOf("/");
      const result = await runtime.process.sendCommand("set_model", {
        provider: model.slice(0, separator),
        modelId: model.slice(separator + 1),
      });
      if (!result.success) return { success: false, code: "rollback_failed", error: `unable to roll back model configuration: ${String(result.error ?? "runtime rejected rollback")}` };
    }
    if (previous.thinking) {
      const thinking = await runtime.process.sendCommand("set_thinking_level", { level: previous.thinking });
      if (!thinking.success) return { success: false, code: "rollback_failed", error: `unable to roll back thinking configuration: ${String(thinking.error ?? "runtime rejected rollback")}` };
    }
    const state = await this.refreshState(runtime);
    if (!state.success || !this.configMatches(runtime, previous.model, previous.thinking)) {
      return { success: false, code: "rollback_failed", error: "runtime configuration rollback could not be verified" };
    }
    runtime.config = { ...previous };
    return { success: true };
  }

  private async cleanupRuntime(runtime: RuntimeRecord): Promise<void> {
    if (runtime.closing) return;
    runtime.closing = true;
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    this.clearEventWatchdog(runtime);
    this.clearIdleTimer(runtime);
    this.eventHub.expectExit(runtime.process);
    const registeredKeys = [...this.runtimes.entries()]
      .filter(([, current]) => current === runtime)
      .map(([key]) => key);
    if (registeredKeys.length > 0) {
      await this.manager.stop(runtime.managerKey);
    } else {
      await runtime.process.shutdown();
    }
    for (const key of registeredKeys) this.runtimes.delete(key);
    for (const key of registeredKeys) this.statsProjector.clear(key);
  }

  private async restoreRuntimeAfterFailedRestart(cwd: string, config: PiConfig, sessionPath: string | null, restartPending: boolean): Promise<void> {
    let options: PiProcessOptions | null;
    try { options = buildPiProcessOptions(cwd, config, undefined, await this.environments.environment(cwd)); }
    catch { return; }
    if (!options) return;
    const restored = await this.startRuntime(cwd, config, undefined, options);
    if ("error" in restored) return;
    // Restore the previous workspace configuration on the recovered runtime
    // before confirming its state, same as every other recovery path.
    const state = await this.resumeSessionWithConfig(restored, sessionPath, config);
    if (!state.success || !restored.activeSessionId) {
      await this.cleanupRuntime(restored);
      return;
    }
    restored.restartPending = restartPending;
    this.registerRuntime(restored);
  }

  private registerRuntime(runtime: RuntimeRecord, previousSessionId?: string): void {
    const nextKey = runtime.activeSessionId ? runtimeKey(runtime.cwd, runtime.activeSessionId) : null;
    if (previousSessionId) {
      const previousKey = runtimeKey(runtime.cwd, previousSessionId);
      if (this.runtimes.get(previousKey) === runtime) this.runtimes.delete(previousKey);
    }
    for (const [key, current] of this.runtimes) {
      if (current === runtime && key !== nextKey) this.runtimes.delete(key);
    }
    if (nextKey) {
      runtime.closing = false;
      this.runtimes.set(nextKey, runtime);
      this.scheduleIdleCleanup(runtime);
    }
  }

  private async publishReplacement(cwd: string, oldId: string, newId: string): Promise<void> {
    if (!oldId || !newId || oldId === newId) return;
    await this.eventHub.publish(cwd, oldId, { type: "session.replaced", sessionId: oldId, replacementSessionId: newId });
  }

  private async refreshState(runtime: RuntimeRecord): Promise<PiResult> {
    const state = await runtime.process.sendCommand("get_state");
    if (!state.success || !state.data || typeof state.data !== "object") return state;
    const data = state.data as Record<string, unknown>;
    runtime.lastState = data;
    runtime.lastStateAt = Date.now();
    if (typeof data.sessionId === "string") runtime.activeSessionId = data.sessionId;
    runtime.busy = Boolean(runtime.operationPending) || Boolean(data.busy) || Boolean(data.isStreaming) || Boolean(data.isCompacting) || Number(data.pendingMessageCount ?? 0) > 0;
    const model = data.model as { provider?: unknown; id?: unknown } | undefined;
    if (model?.provider && model.id) runtime.config.model = `${model.provider}/${model.id}`;
    if (typeof data.thinkingLevel === "string") runtime.config.thinking = data.thinkingLevel;
    if (runtime.busy) this.clearIdleTimer(runtime);
    else this.scheduleIdleCleanup(runtime);
    return state;
  }

  private clearIdleTimer(runtime: RuntimeRecord): void {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }

  private scheduleIdleCleanup(runtime: RuntimeRecord): void {
    this.clearIdleTimer(runtime);
    const timeoutMs = idleRuntimeMs();
    if (
      timeoutMs <= 0
      || runtime.closing
      || runtime.busy
      || runtime.operationPending
      || runtime.restartPending
      || !runtime.activeSessionId
      || this.runtimes.get(runtimeKey(runtime.cwd, runtime.activeSessionId)) !== runtime
    ) return;

    const key = runtimeKey(runtime.cwd, runtime.activeSessionId);
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = undefined;
      void this.withLock(key, async () => {
        if (this.runtimes.get(key) !== runtime || runtime.closing) return;
        if (runtime.busy || runtime.operationPending || this.eventHub.hasSubscribers(runtime.cwd, runtime.activeSessionId)) {
          this.scheduleIdleCleanup(runtime);
          return;
        }
        await this.cleanupRuntime(runtime);
      }).catch(() => {
        if (this.runtimes.get(key) === runtime && !runtime.closing) this.scheduleIdleCleanup(runtime);
      });
    }, timeoutMs);
    runtime.idleTimer.unref?.();
  }

  private async stateData(runtime: RuntimeRecord): Promise<SessionState> {
    const result = await this.refreshState(runtime);
    return this.toSessionState(runtime, result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {});
  }

  private toSessionState(runtime: RuntimeRecord, data: Record<string, unknown>, stats?: Record<string, unknown>): SessionState {
    const model = data.model as { provider?: unknown; id?: unknown } | undefined;
    const contextUsage = stats?.contextUsage && typeof stats.contextUsage === "object"
      ? stats.contextUsage as Record<string, unknown>
      : undefined;
    const contextWindow = Number(contextUsage?.contextWindow ?? (data.model as Record<string, unknown> | undefined)?.contextWindow ?? runtime.config.model_context_window ?? 0);
    const contextTokens = contextUsage?.tokens === null ? null : Number(contextUsage?.tokens ?? NaN);
    const contextPercent = contextUsage?.percent === null ? null : Number(contextUsage?.percent ?? NaN);
    return {
      id: runtime.activeSessionId,
      cwd: runtime.cwd,
      is_streaming: runtime.busy || Boolean(data.isStreaming),
      is_compacting: Boolean(data.isCompacting),
      pending_message_count: Number(data.pendingMessageCount ?? 0),
      model: model?.provider && model.id ? canonicalFromRuntimeModelRef(`${model.provider}/${model.id}`) : runtime.config.model ? canonicalFromRuntimeModelRef(runtime.config.model) : null,
      thinking: typeof data.thinkingLevel === "string" ? data.thinkingLevel : runtime.config.thinking ?? null,
      context_tokens: contextTokens === null || Number.isFinite(contextTokens) ? contextTokens : null,
      context_window: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
      context_percent: contextPercent === null || Number.isFinite(contextPercent) ? contextPercent : null,
      compaction_enabled: data.autoCompactionEnabled !== false && runtime.config.compaction_enabled !== false,
      compaction_threshold_percent: runtime.config.compaction_threshold_percent
        ?? (Number.isFinite(contextWindow) && contextWindow > 16384 ? Math.min(95, Math.round((1 - 16384 / contextWindow) * 100)) : null),
    };
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

export const nodeSessionService = new NodeSessionService();
