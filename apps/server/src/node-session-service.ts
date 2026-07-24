import type { CreateSessionRequest, PiConfig, SessionState } from "@pi-science/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { conversationEventHub } from "./conversation-event-hub.js";
import { observeNodePiEvent } from "./node-event-observer.js";
import { piManager } from "./pi-manager.js";
import type { PiProcess, PiProcessOptions, PiResult } from "./pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "./pi-runtime-launch.js";
import { validateWorkspaceCwd } from "./workspace-security.js";
import { sessionRepository } from "./session-repository.js";

type ServiceFailure = { success: false; error: string; code: string };
type PendingOperation = "prompt" | "compact";
type RuntimeRecord = {
  cwd: string;
  managerKey: string;
  process: PiProcess;
  activeSessionId: string;
  config: PiConfig;
  busy: boolean;
  operationPending?: PendingOperation;
  operationDeadline?: number;
  restartPending: boolean;
  reconcileTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
  lastState?: Record<string, unknown>;
  lastStateAt?: number;
};

function runtimeKey(cwd: string, sessionId: string): string {
  return `${resolve(cwd)}\0${sessionId}`;
}

function reconciliationDelayMs(): number {
  const value = Number(process.env.PI_SCIENCE_RECONCILE_DELAY_MS ?? 0);
  return value > 0 ? value : 2_000;
}

function reconciliationDeadlineMs(): number {
  const value = Number(process.env.PI_SCIENCE_RECONCILE_DEADLINE_MS ?? 0);
  return value > 0 ? value : 45_000;
}

function idleRuntimeMs(): number {
  const configured = process.env.PI_SCIENCE_IDLE_RUNTIME_MS;
  if (configured === undefined || configured === "") return 30 * 60_000;
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
  const model = requested?.model || defaults.model || null;
  return {
    model,
    provider: requested?.provider || defaults.provider || null,
    api_key: requested?.api_key || null,
    // A thinking level has no stable meaning until a model is configured;
    // Pi may normalize it differently for its placeholder unknown model.
    thinking: model ? (requested?.thinking ?? defaults.thinking ?? "high") : null,
    skills: requested?.skills?.length ? requested.skills : defaults.skills,
    extensions: requested?.extensions?.length ? requested.extensions : defaults.extensions,
  };
}

export class NodeSessionService {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private scientificRuntime: { origin: string; token?: string } | null = null;

  configureScientificRuntime(origin: string, token?: string): void {
    this.scientificRuntime = { origin: origin.replace(/\/$/, ""), ...(token ? { token } : {}) };
  }

  async create(body: CreateSessionRequest): Promise<{ id: string; cwd: string } | { error: string; code: string; sessionId?: string }> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(body.cwd); }
    catch (error) { return { error: String(error), code: "workspace_invalid" }; }
    await mkdir(resolve(cwd, ".pi-science", "sessions"), { recursive: true });
    return this.withLock(`create:${cwd}`, async () => {
      let runtime: RuntimeRecord | undefined;
      const config = { ...effectiveConfig(), ...body.config };
      const started = this.startRuntime(cwd, config);
      if ("error" in started) return started;
      runtime = started;
      const state = await this.refreshState(runtime);
      if (!state.success || !runtime.activeSessionId) { await this.cleanupRuntime(runtime); return { error: String(state.error ?? "pi runtime did not return a session"), code: String(state.code ?? "spawn_failed") }; }
      const configured = await this.applyConfig(runtime, config);
      if (!configured.success) { await this.cleanupRuntime(runtime); return { error: String(configured.error ?? "unable to configure session"), code: String(configured.code ?? "runtime_error") }; }
      this.registerRuntime(runtime);
      return { id: runtime.activeSessionId, cwd };
    });
  }

  async command(sessionId: string, cwdValue: string, type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const activated = await this.activateUnlocked(sessionId, cwd);
      if ("error" in activated) return activated;
      const runtime = activated;
      const mutating = new Set(["prompt", "new_session", "switch_session", "fork", "clone", "set_model", "set_thinking_level", "compact", "abort"]);
      if (mutating.has(type) && type !== "abort") {
        const ready = await this.reconcileForMutation(runtime);
        if (!ready.success) return ready;
      }
      const oldId = runtime.activeSessionId;
      if (type === "prompt" || type === "compact") this.beginPendingOperation(runtime, type);
      const result = await runtime.process.sendCommand(type, params);
      if (!result.success) {
        if ((type === "prompt" || type === "compact") && result.code === "timeout") this.scheduleOperationReconciliation(runtime, true);
        else if (type === "prompt" || type === "compact") this.clearPendingOperation(runtime);
        return result;
      }
      if (type === "prompt" || type === "compact") {
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
      const sessionPath = await sessionRepository.findPath(cwd, sessionId);
      if (!sessionPath) return { success: false, code: "not_found", error: "session not found" };
      const started = this.startRuntime(cwd, { ...source.config });
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
      return { ...result, sessionId: started.activeSessionId };
    });
  }

  async configure(sessionId: string, cwdValue: string, model: string, thinking?: string): Promise<PiResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    if (!model.includes("/")) return { success: false, code: "invalid_request", error: "model must use provider/model notation" };
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
      if (!modelResult.success && provider.startsWith("custom-")) {
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
      const activated = await this.activateUnlocked(sessionId, cwd);
      if ("error" in activated) return { error: activated.error, code: activated.code };
      const result = activated.lastState && activated.lastStateAt && Date.now() - activated.lastStateAt < 500
        ? { success: true, data: activated.lastState }
        : await this.refreshState(activated);
      if (!result.success || !result.data || typeof result.data !== "object") return { error: String(result.error ?? "unable to read session state"), code: String(result.code ?? "runtime_error") };
      return this.toSessionState(activated, result.data as Record<string, unknown>);
    });
  }

  async delete(sessionId: string, cwdValue: string): Promise<{ success: boolean; error?: string; code?: string }> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return this.withLock(`${cwd}\0${sessionId}`, async () => {
      const runtime = this.runtimes.get(runtimeKey(cwd, sessionId));
      const path = await sessionRepository.findPath(cwd, sessionId);
      if (runtime?.activeSessionId === sessionId) {
        if (runtime.busy) return { success: false, code: "busy", error: "cannot delete a conversation while it is running" };
        await this.cleanupRuntime(runtime);
      }
      if (!path) {
        return runtime?.activeSessionId === sessionId ? { success: true } : { success: false, code: "not_found", error: "session not found" };
      }
      try { await unlink(path); }
      catch (error) { return { success: false, code: "delete_failed", error: String(error) }; }
      return { success: true };
    });
  }

  async reloadConfiguration(): Promise<Array<{ cwd: string; oldId: string; newId: string }>> {
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
  }

  async shutdownAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.closing = true;
      this.clearIdleTimer(runtime);
      conversationEventHub.expectExit(runtime.process);
    }
    await piManager.shutdownAll();
    this.runtimes.clear();
  }

  get activeCount(): number { return this.runtimes.size; }

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
    const sessionPath = await sessionRepository.findPath(cwd, sessionId);
    if (!sessionPath) return { success: false, code: "not_found", error: "session not found in this workspace" };
    const started = this.startRuntime(cwd, effectiveConfig());
    if ("error" in started) return { success: false, ...started };
    runtime = started;
    const switched = await runtime.process.sendCommand("switch_session", { sessionPath });
    if (!switched.success) { await this.cleanupRuntime(runtime); return failure(switched, "unable to resume session"); }
    const state = await this.refreshState(runtime);
    if (!state.success) { await this.cleanupRuntime(runtime); return failure(state, "unable to resume session"); }
    if (runtime.activeSessionId !== sessionId) { await this.cleanupRuntime(runtime); return { success: false, code: "session_mismatch", error: "runtime resumed a different session" }; }
    this.registerRuntime(runtime);
    return runtime;
  }

  private startRuntime(cwd: string, config: PiConfig, sessionPath?: string, preparedOptions?: PiProcessOptions): RuntimeRecord | { error: string; code: string } {
    let options: PiProcessOptions | null;
    try { options = preparedOptions ?? buildPiProcessOptions(cwd, config, sessionPath); }
    catch (error) { return { error: `unable to prepare Pi runtime configuration: ${String(error)}`, code: "configuration_failed" }; }
    if (!options) return { error: "PI_CLI_PATH is not configured", code: "spawn_failed" };
    let process: PiProcess;
    const managerKey = randomUUID();
    try { process = piManager.start(managerKey, options); }
    catch (error) { return { error: `unable to start Pi runtime: ${String(error)}`, code: "spawn_failed" }; }
    const runtime: RuntimeRecord = { cwd, managerKey, process, activeSessionId: "", config: { ...config }, busy: false, restartPending: false, closing: false };
    conversationEventHub.bind(cwd, process, {
      activeSessionId: () => runtime.activeSessionId || null,
      onBusy: (busy) => {
        if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
        runtime.reconcileTimer = undefined;
        runtime.operationPending = undefined;
        runtime.operationDeadline = undefined;
        runtime.busy = busy;
        if (!busy && runtime.restartPending) {
          queueMicrotask(() => { void this.reloadRuntimeAfterTurn(runtime); });
        } else if (!busy) {
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
        await observeNodePiEvent(cwd, runtime.config.model ?? null, event, sessionId, (payload) => conversationEventHub.publish(cwd, sessionId, payload));
        if (event.type === "agent_settled") this.scheduleAutoReview(cwd, sessionId);
      },
    });
    return runtime;
  }

  private async reloadRuntimeAfterTurn(runtime: RuntimeRecord): Promise<void> {
    await this.withLock(runtimeKey(runtime.cwd, runtime.activeSessionId), async () => {
      if (this.runtimes.get(runtimeKey(runtime.cwd, runtime.activeSessionId)) !== runtime || runtime.busy) return;
      const oldId = runtime.activeSessionId;
      const restarted = await this.restartRuntimeUnlocked(runtime, effectiveConfig());
      if ("error" in restarted) {
        if (oldId) await conversationEventHub.publish(runtime.cwd, oldId, { type: "error", sessionId: oldId, message: `Failed to reload Pi runtime after settings changed: ${restarted.error}` });
      }
    });
  }

  private beginPendingOperation(runtime: RuntimeRecord, operation: PendingOperation): void {
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    runtime.reconcileTimer = undefined;
    runtime.operationPending = operation;
    runtime.operationDeadline = Date.now() + reconciliationDeadlineMs();
    runtime.busy = true;
  }

  private clearPendingOperation(runtime: RuntimeRecord): void {
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    runtime.reconcileTimer = undefined;
    runtime.operationPending = undefined;
    runtime.operationDeadline = undefined;
    runtime.busy = false;
  }

  private scheduleOperationReconciliation(runtime: RuntimeRecord, immediate: boolean): void {
    if (runtime.reconcileTimer) clearTimeout(runtime.reconcileTimer);
    runtime.reconcileTimer = setTimeout(() => {
      void this.withLock(runtimeKey(runtime.cwd, runtime.activeSessionId), async () => {
        const current = this.runtimes.get(runtimeKey(runtime.cwd, runtime.activeSessionId));
        if (current !== runtime || !runtime.operationPending) return;
        const state = await runtime.process.sendCommand("get_state");
        const data = state.data && typeof state.data === "object" ? state.data as Record<string, unknown> : {};
        const active = Boolean(data.isStreaming) || Boolean(data.isCompacting) || Number(data.pendingMessageCount ?? 0) > 0;
        if (state.success && active && Date.now() < (runtime.operationDeadline ?? 0)) {
          runtime.busy = true;
          this.scheduleOperationReconciliation(runtime, false);
          return;
        }
        if (!state.success && Date.now() < (runtime.operationDeadline ?? 0)) {
          this.scheduleOperationReconciliation(runtime, false);
          return;
        }
        const operation = runtime.operationPending;
        if (state.success && !active) {
          this.clearPendingOperation(runtime);
          if (operation === "prompt") {
            await conversationEventHub.publish(runtime.cwd, runtime.activeSessionId, {
              type: "error",
              sessionId: runtime.activeSessionId,
              message: "The prompt was accepted but the Pi runtime did not start an agent turn.",
            });
            await conversationEventHub.publish(runtime.cwd, runtime.activeSessionId, { type: "session.idle", sessionId: runtime.activeSessionId });
          }
          return;
        }
        const sessionId = runtime.activeSessionId;
        const config = { ...runtime.config };
        this.clearPendingOperation(runtime);
        const restarted = await this.restartRuntimeUnlocked(runtime, config);
        if ("error" in restarted && sessionId) {
          await conversationEventHub.publish(runtime.cwd, sessionId, {
            type: "error",
            sessionId,
            message: `Unable to safely reconcile timed-out ${operation} operation: ${restarted.error}`,
            terminal: true,
          });
        }
      });
    }, immediate ? 0 : reconciliationDelayMs());
  }

  private scheduleAutoReview(cwd: string, sessionId: string): void {
    const runtime = this.scientificRuntime;
    if (!runtime) return;
    const target = new URL(`${runtime.origin}/api/sessions/${encodeURIComponent(sessionId)}/auto-review`);
    target.searchParams.set("cwd", cwd);
    void fetch(target, {
      method: "POST",
      headers: runtime.token ? { "x-pi-science-internal-token": runtime.token } : undefined,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  private async restartRuntimeUnlocked(runtime: RuntimeRecord, config: PiConfig): Promise<RuntimeRecord | ServiceFailure> {
    const cwd = runtime.cwd;
    if (runtime.busy) return { success: false, code: "busy", error: "agent is busy" };
    const oldId = runtime.activeSessionId;
    const oldConfig = { ...runtime.config };
    const restartPending = runtime.restartPending;
    const sessionPath = runtime.activeSessionId ? await sessionRepository.findPath(cwd, runtime.activeSessionId) : null;
    let options: PiProcessOptions | null;
    try { options = buildPiProcessOptions(cwd, config); }
    catch (error) { return { success: false, code: "configuration_failed", error: `unable to prepare Pi runtime configuration: ${String(error)}` }; }
    if (!options) return { success: false, code: "spawn_failed", error: "PI_CLI_PATH is not configured" };
    conversationEventHub.expectExit(runtime.process);
    await piManager.stop(runtime.managerKey);
    for (const [key, current] of this.runtimes) {
      if (current === runtime) this.runtimes.delete(key);
    }
    const started = this.startRuntime(cwd, config, undefined, options);
    if (!("error" in started)) {
      const switched = sessionPath
        ? await started.process.sendCommand("switch_session", { sessionPath })
        : { success: true };
      const state = switched.success ? await this.refreshState(started) : switched;
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
    if (config.model?.includes("/")) {
      const separator = config.model.indexOf("/");
      const result = await runtime.process.sendCommand("set_model", { provider: config.model.slice(0, separator), modelId: config.model.slice(separator + 1) });
      if (!result.success) return result;
    }
    if (config.thinking) {
      const result = await runtime.process.sendCommand("set_thinking_level", { level: config.thinking });
      if (!result.success) return result;
    }
    const state = await this.refreshState(runtime);
    if (!state.success) return failure(state, "unable to confirm session configuration");
    if (!this.configMatches(runtime, config.model ?? undefined, config.thinking ?? undefined)) {
      return { success: false, code: "reconcile_failed", error: "Pi runtime state does not match the requested session configuration" };
    }
    runtime.config = { ...config };
    return { success: true };
  }

  private async reconcileForMutation(runtime: RuntimeRecord): Promise<PiResult> {
    const state = await this.refreshState(runtime);
    if (!state.success || !state.data || typeof state.data !== "object") return failure(state, "unable to confirm runtime state before mutation");
    if (runtime.busy) return { success: false, code: "busy", error: "agent is busy; wait for the current task to finish or stop it" };
    return { success: true, data: state.data };
  }

  private configMatches(runtime: RuntimeRecord, model?: string | null, thinking?: string | null): boolean {
    return (!model || runtime.config.model === model) && (!thinking || runtime.config.thinking === thinking);
  }

  private async rollbackConfig(runtime: RuntimeRecord, previous: PiConfig): Promise<PiResult> {
    if (previous.model?.includes("/")) {
      const separator = previous.model.indexOf("/");
      const model = await runtime.process.sendCommand("set_model", {
        provider: previous.model.slice(0, separator),
        modelId: previous.model.slice(separator + 1),
      });
      if (!model.success) return { success: false, code: "rollback_failed", error: `unable to roll back model configuration: ${String(model.error ?? "runtime rejected rollback")}` };
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
    this.clearIdleTimer(runtime);
    conversationEventHub.expectExit(runtime.process);
    const registeredKeys = [...this.runtimes.entries()]
      .filter(([, current]) => current === runtime)
      .map(([key]) => key);
    if (registeredKeys.length > 0) {
      await piManager.stop(runtime.managerKey);
    } else {
      await runtime.process.shutdown();
    }
    for (const key of registeredKeys) this.runtimes.delete(key);
  }

  private async restoreRuntimeAfterFailedRestart(cwd: string, config: PiConfig, sessionPath: string | null, restartPending: boolean): Promise<void> {
    let options: PiProcessOptions | null;
    try { options = buildPiProcessOptions(cwd, config); }
    catch { return; }
    if (!options) return;
    const restored = this.startRuntime(cwd, config, undefined, options);
    if ("error" in restored) return;
    const switched = sessionPath
      ? await restored.process.sendCommand("switch_session", { sessionPath })
      : { success: true };
    const state = switched.success ? await this.refreshState(restored) : switched;
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
    await conversationEventHub.publish(cwd, oldId, { type: "session.replaced", sessionId: oldId, replacementSessionId: newId });
  }

  private async refreshState(runtime: RuntimeRecord): Promise<PiResult> {
    const state = await runtime.process.sendCommand("get_state");
    if (!state.success || !state.data || typeof state.data !== "object") return state;
    const data = state.data as Record<string, unknown>;
    runtime.lastState = data;
    runtime.lastStateAt = Date.now();
    if (typeof data.sessionId === "string") runtime.activeSessionId = data.sessionId;
    runtime.busy = Boolean(runtime.operationPending) || Boolean(data.isStreaming) || Boolean(data.isCompacting) || Number(data.pendingMessageCount ?? 0) > 0;
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
        if (runtime.busy || runtime.operationPending || conversationEventHub.hasSubscribers(runtime.cwd, runtime.activeSessionId)) {
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

  private toSessionState(runtime: RuntimeRecord, data: Record<string, unknown>): SessionState {
    const model = data.model as { provider?: unknown; id?: unknown } | undefined;
    return {
      id: runtime.activeSessionId,
      cwd: runtime.cwd,
      is_streaming: runtime.busy || Boolean(data.isStreaming),
      is_compacting: Boolean(data.isCompacting),
      pending_message_count: Number(data.pendingMessageCount ?? 0),
      model: model?.provider && model.id ? `${model.provider}/${model.id}` : runtime.config.model ?? null,
      thinking: typeof data.thinkingLevel === "string" ? data.thinkingLevel : runtime.config.thinking ?? null,
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
