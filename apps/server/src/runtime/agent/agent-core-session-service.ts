import type { ApprovalMode, CreateSessionRequest } from "@pi-science/contracts";
import { withWorkspaceAdmission } from "../workspace/workspace-lifecycle.js";
import type { PiConfig, SessionState, SessionStats } from "@pi-science/contracts";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { RuntimeResult, RuntimeSkillPolicy } from "./agent-runtime-types.js";
import type { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { DurableTurnLifecycle } from "../artifacts/turn-lifecycle.js";
import { createSessionContext, type SessionContext } from "./session/context.js";
import type { Live, ProductHooks } from "./session/types.js";
import { identity } from "./session/identity.js";
import { workerEnvironment, composerCommands, credentialEnvNames, setGlobalSkillPolicy, refreshAllSkills } from "./session/resources.js";
import { importLegacy, importLegacyOnce } from "./session/legacy-import.js";
import { waitForMutation, owns, liveSessions, sessionBusy, hasActiveOperations, closeIdleWorkspace, liveRuntime } from "./session/queries.js";
import { create, createAdmitted, attach, open, openOnce } from "./session/startup.js";
import { command, commandOnce, notify, notifyAdmitted, configure, configureOnce } from "./session/commands.js";
import { approvalTransitionPending, setApprovalMode } from "./session/approval.js";
import { reloadConfiguration, stopForReload, resume, state, fork, forkAdmitted, stats, deleteSession, deleteOnce, shutdownAll } from "./session/lifecycle.js";
import { scheduleWatchdog, probe, recover } from "./session/supervision.js";

/** Public session API and owner of per-instance locks/lifecycle state. */
export class AgentCoreSessionService {
  private readonly manager: AgentRuntimeManager;
  private readonly repository = new AgentSessionRepository();
  private readonly registry = new AgentSessionRegistry();
  private readonly approvalRetirements = new Map<string, Live | null>();
  private readonly live = new Map<string, Live>();
  private readonly opening = new Map<string, Promise<Live | RuntimeResult>>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private beforeStart: ((cwd: string) => Promise<void>) | null = null;
  private readonly turns: DurableTurnLifecycle;
  private hooks: ProductHooks = {};
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private stopping = false;

  private readonly context: SessionContext;

  constructor(
    private readonly events: ConversationEventHub,
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
    private readonly server: { backendUrl?: string; internalToken?: string; onWorkerExit?: (cwd: string, sessionId: string) => Promise<void>; hasApprovalResources?: (cwd: string, sessionId: string) => boolean; revokeApprovalResources?: (cwd: string, sessionId: string) => Promise<{ kernelRestartCount: number }> } = {},
  ) {
    this.manager = new AgentRuntimeManager(server.onWorkerExit); this.turns = new DurableTurnLifecycle(events);
    this.context = createSessionContext({
      manager: this.manager,
      repository: this.repository,
      registry: this.registry,
      events: this.events,
      environments: this.environments,
      server: this.server,
      turns: this.turns,
      approvalRetirements: this.approvalRetirements,
      live: this.live,
      opening: this.opening,
      mutations: this.mutations,
      recovering: this.recovering,
      recoveryAttempts: this.recoveryAttempts,
      recoveryTimers: this.recoveryTimers,
      configureProductLifecycle: (...args) => this.configureProductLifecycle(...args),
      configureBeforeStart: (...args) => this.configureBeforeStart(...args),
      workerEnvironment: (...args) => this.workerEnvironment(...args),
      composerCommands: (...args) => this.composerCommands(...args),
      credentialEnvNames: (...args) => this.credentialEnvNames(...args),
      waitForMutation: (...args) => this.waitForMutation(...args),
      owns: (...args) => this.owns(...args),
      importLegacy: (...args) => this.importLegacy(...args),
      importLegacyOnce: (...args) => this.importLegacyOnce(...args),
      liveSessions: (...args) => this.liveSessions(...args),
      sessionBusy: (...args) => this.sessionBusy(...args),
      hasActiveOperations: (...args) => this.hasActiveOperations(...args),
      closeIdleWorkspace: (...args) => this.closeIdleWorkspace(...args),
      liveRuntime: (...args) => this.liveRuntime(...args),
      create: (...args) => this.create(...args),
      createAdmitted: (...args) => this.createAdmitted(...args),
      attach: (...args) => this.attach(...args),
      open: (...args) => this.open(...args),
      openOnce: (...args) => this.openOnce(...args),
      command: (...args) => this.command(...args),
      commandOnce: (...args) => this.commandOnce(...args),
      notify: (...args) => this.notify(...args),
      notifyAdmitted: (...args) => this.notifyAdmitted(...args),
      setGlobalSkillPolicy: (...args) => this.setGlobalSkillPolicy(...args),
      refreshAllSkills: (...args) => this.refreshAllSkills(...args),
      approvalTransitionPending: (...args) => this.approvalTransitionPending(...args),
      setApprovalMode: (...args) => this.setApprovalMode(...args),
      reloadConfiguration: (...args) => this.reloadConfiguration(...args),
      stopForReload: (...args) => this.stopForReload(...args),
      resume: (...args) => this.resume(...args),
      state: (...args) => this.state(...args),
      configure: (...args) => this.configure(...args),
      configureOnce: (...args) => this.configureOnce(...args),
      fork: (...args) => this.fork(...args),
      forkAdmitted: (...args) => this.forkAdmitted(...args),
      stats: (...args) => this.stats(...args),
      delete: (...args) => this.delete(...args),
      deleteOnce: (...args) => this.deleteOnce(...args),
      withMutation: <T>(cwd: string, sessionId: string, operation: () => Promise<T>) => this.withMutation(cwd, sessionId, operation),
      withSessionMutation: <T>(cwd: string, sessionId: string, operation: () => Promise<T>) => this.withSessionMutation(cwd, sessionId, operation),
      shutdownAll: (...args) => this.shutdownAll(...args),
      scheduleWatchdog: (...args) => this.scheduleWatchdog(...args),
      probe: (...args) => this.probe(...args),
      recover: (...args) => this.recover(...args),
    }, {
      beforeStart: { read: () => this.beforeStart, write: (value) => { this.beforeStart = value; } },
      hooks: { read: () => this.hooks, write: (value) => { this.hooks = value; } },
      stopping: { read: () => this.stopping, write: (value) => { this.stopping = value; } },
    });
  }
  configureProductLifecycle(hooks: ProductHooks): void { this.hooks = hooks; }
  configureBeforeStart(hook: ((cwd: string) => Promise<void>) | null): void { this.beforeStart = hook; }
  private workerEnvironment(cwd: string): Promise<Record<string, string>> { return workerEnvironment(this.context, cwd); }
  composerCommands(cwd: string, config: PiConfig): Promise<{ commands: Array<{ name: string; description: string; source: string; group: string }>; revision: string }> { return composerCommands(this.context, cwd, config); }
  private credentialEnvNames(cwd: string): Promise<string[]> { return credentialEnvNames(this.context, cwd); }
  waitForMutation(cwd: string, sessionId: string): Promise<void> { return waitForMutation(this.context, cwd, sessionId); }
  owns(cwd: string, sessionId: string): Promise<boolean> { return owns(this.context, cwd, sessionId); }
  importLegacy(cwd: string, sessionId: string, source: string, config: PiConfig, options: { activate?: boolean } = {}): Promise<RuntimeResult> { return importLegacy(this.context, cwd, sessionId, source, config, options); }
  private importLegacyOnce(cwd: string, sessionId: string, source: string, config: PiConfig, options: { activate?: boolean }): Promise<RuntimeResult> { return importLegacyOnce(this.context, cwd, sessionId, source, config, options); }
  liveSessions(cwd: string): Array<{ id: string; cwd: string }> { return liveSessions(this.context, cwd); }
  /** True when a live runtime for this session is mid-turn. Reads only the in-memory live table. */
  sessionBusy(cwd: string, sessionId: string): boolean { return sessionBusy(this.context, cwd, sessionId); }
  hasActiveOperations(cwd: string): Promise<boolean> { return hasActiveOperations(this.context, cwd); }
  closeIdleWorkspace(cwd: string): Promise<void> { return closeIdleWorkspace(this.context, cwd); }
  liveRuntime(cwd: string, expectedModel?: string): AgentCoreRuntimeClient | null { return liveRuntime(this.context, cwd, expectedModel); }
  create(cwd: string, config: PiConfig, initialApproval?: CreateSessionRequest["initialApproval"]): Promise<{ id: string } | { error: string; code: string }> { return create(this.context, cwd, config, initialApproval); }
  private createAdmitted(cwd: string, config: PiConfig, initialApproval?: CreateSessionRequest["initialApproval"]): Promise<{ id: string } | { error: string; code: string }> { return createAdmitted(this.context, cwd, config, initialApproval); }
  private attach(key: string, runtime: AgentCoreRuntimeClient, model: string, level: string | null, config: PiConfig): Promise<Live> { return attach(this.context, key, runtime, model, level, config); }
  private open(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult> { return open(this.context, cwd, sessionId, config); }
  private openOnce(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult> { return openOnce(this.context, cwd, sessionId, config); }
  command(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> { return command(this.context, cwd, sessionId, type, params, config); }
  private commandOnce(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult> { return commandOnce(this.context, cwd, sessionId, type, params, config); }
  notify(cwd: string, sessionId: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult> { return notify(this.context, cwd, sessionId, type, params); }
  private notifyAdmitted(cwd: string, sessionId: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult> { return notifyAdmitted(this.context, cwd, sessionId, type, params); }
  setGlobalSkillPolicy(policy: RuntimeSkillPolicy): Promise<void> { return setGlobalSkillPolicy(this.context, policy); }
  refreshAllSkills(): Promise<void> { return refreshAllSkills(this.context); }
  approvalTransitionPending(cwd: string, sessionId: string): boolean { return approvalTransitionPending(this.context, cwd, sessionId); }
  setApprovalMode(cwd: string, sessionId: string, mode: ApprovalMode, revision: number): Promise<RuntimeResult> { return setApprovalMode(this.context, cwd, sessionId, mode, revision); }
  reloadConfiguration(): Promise<void> { return reloadConfiguration(this.context); }
  private stopForReload(item: Live): Promise<void> { return stopForReload(this.context, item); }
  resume(cwd: string, sessionId: string, config: PiConfig): Promise<RuntimeResult> { return resume(this.context, cwd, sessionId, config); }
  state(cwd: string, sessionId: string, config: PiConfig): Promise<SessionState | { error: string; code: string }> { return state(this.context, cwd, sessionId, config); }
  configure(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> { return configure(this.context, cwd, sessionId, model, level, config); }
  private configureOnce(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult> { return configureOnce(this.context, cwd, sessionId, model, level, config); }
  fork(cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult> { return fork(this.context, cwd, sessionId, entryId, config); }
  private forkAdmitted(cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult> { return forkAdmitted(this.context, cwd, sessionId, entryId, config); }
  stats(cwd: string, sessionId: string): Promise<{ stats: SessionStats } | { error: string; code: string }> { return stats(this.context, cwd, sessionId); }
  delete(cwd: string, sessionId: string): Promise<RuntimeResult> { return deleteSession(this.context, cwd, sessionId); }
  private deleteOnce(cwd: string, sessionId: string): Promise<RuntimeResult> { return deleteOnce(this.context, cwd, sessionId); }
  private async withMutation<T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    return withWorkspaceAdmission(cwd, () => this.withSessionMutation(cwd, sessionId, operation));
  }
  private async withSessionMutation<T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = identity(cwd, sessionId);
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.mutations.set(key, next);
    try { return await next; }
    finally { if (this.mutations.get(key) === next) this.mutations.delete(key); }
  }
  shutdownAll(): Promise<void> { return shutdownAll(this.context); }
  private scheduleWatchdog(item: Live): void { return scheduleWatchdog(this.context, item); }
  private probe(item: Live): Promise<void> { return probe(this.context, item); }
  private recover(item: Live, force = false): Promise<void> { return recover(this.context, item, force); }
  get processCount(): number { return this.manager.processCount; }
}
