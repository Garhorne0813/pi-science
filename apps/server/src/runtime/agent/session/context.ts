import type { ApprovalMode, CreateSessionRequest } from "@pi-science/contracts";
import type { PiConfig, SessionState, SessionStats } from "@pi-science/contracts";
import type { ConversationEventHub } from "../../events/conversation-event-hub.js";
import type { AgentRuntimeManager } from "../agent-runtime-manager.js";
import type { AgentSessionRepository } from "../agent-session-repository.js";
import type { AgentCoreRuntimeClient } from "../agent-runtime-client.js";
import type { RuntimeResult, RuntimeSkillPolicy } from "../agent-runtime-types.js";
import type { WorkspaceEnvironmentService } from "../../workspace/workspace-environment.js";
import type { AgentSessionRegistry } from "../agent-session-registry.js";
import type { DurableTurnLifecycle } from "../../artifacts/turn-lifecycle.js";
import type { Live, ProductHooks, SessionServerOptions } from "./types.js";

export interface SessionContext {
  readonly manager: AgentRuntimeManager;
  readonly repository: AgentSessionRepository;
  readonly registry: AgentSessionRegistry;
  readonly events: ConversationEventHub;
  readonly environments: Pick<WorkspaceEnvironmentService, "environment">;
  readonly server: SessionServerOptions;
  readonly turns: DurableTurnLifecycle;
  readonly approvalRetirements: Map<string, Live | null>;
  readonly live: Map<string, Live>;
  readonly opening: Map<string, Promise<Live | RuntimeResult>>;
  readonly mutations: Map<string, Promise<unknown>>;
  readonly recovering: Map<string, Promise<void>>;
  readonly recoveryAttempts: Map<string, number>;
  readonly recoveryTimers: Map<string, NodeJS.Timeout>;
  beforeStart: ((cwd: string) => Promise<void>) | null;
  hooks: ProductHooks;
  stopping: boolean;
  configureProductLifecycle(hooks: ProductHooks): void;
  configureBeforeStart(hook: ((cwd: string) => Promise<void>) | null): void;
  workerEnvironment(cwd: string): Promise<Record<string, string>>;
  composerCommands(cwd: string, config: PiConfig): Promise<{ commands: Array<{ name: string; description: string; source: string; group: string }>; revision: string }>;
  credentialEnvNames(cwd: string): Promise<string[]>;
  waitForMutation(cwd: string, sessionId: string): Promise<void>;
  owns(cwd: string, sessionId: string): Promise<boolean>;
  importLegacy(cwd: string, sessionId: string, source: string, config: PiConfig, options?: { activate?: boolean }): Promise<RuntimeResult>;
  importLegacyOnce(cwd: string, sessionId: string, source: string, config: PiConfig, options: { activate?: boolean }): Promise<RuntimeResult>;
  liveSessions(cwd: string): Array<{ id: string; cwd: string }>;
  hasActiveOperations(cwd: string): Promise<boolean>;
  closeIdleWorkspace(cwd: string): Promise<void>;
  liveRuntime(cwd: string, expectedModel?: string): AgentCoreRuntimeClient | null;
  create(cwd: string, config: PiConfig, initialApproval?: CreateSessionRequest["initialApproval"]): Promise<{ id: string } | { error: string; code: string }>;
  createAdmitted(cwd: string, config: PiConfig, initialApproval?: CreateSessionRequest["initialApproval"]): Promise<{ id: string } | { error: string; code: string }>;
  attach(key: string, runtime: AgentCoreRuntimeClient, model: string, level: string | null, config: PiConfig): Promise<Live>;
  open(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult>;
  openOnce(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult>;
  command(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult>;
  commandOnce(cwd: string, sessionId: string, type: string, params: Record<string, unknown>, config: PiConfig): Promise<RuntimeResult>;
  notify(cwd: string, sessionId: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult>;
  notifyAdmitted(cwd: string, sessionId: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult>;
  setGlobalSkillPolicy(policy: RuntimeSkillPolicy): Promise<void>;
  refreshAllSkills(): Promise<void>;
  approvalTransitionPending(cwd: string, sessionId: string): boolean;
  setApprovalMode(cwd: string, sessionId: string, mode: ApprovalMode, revision: number): Promise<RuntimeResult>;
  reloadConfiguration(): Promise<void>;
  stopForReload(item: Live): Promise<void>;
  resume(cwd: string, sessionId: string, config: PiConfig): Promise<RuntimeResult>;
  state(cwd: string, sessionId: string, config: PiConfig): Promise<SessionState | { error: string; code: string }>;
  configure(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult>;
  configureOnce(cwd: string, sessionId: string, model: string, level: string | undefined, config: PiConfig): Promise<RuntimeResult>;
  fork(cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult>;
  forkAdmitted(cwd: string, sessionId: string, entryId: string | undefined, config: PiConfig): Promise<RuntimeResult>;
  stats(cwd: string, sessionId: string): Promise<{ stats: SessionStats } | { error: string; code: string }>;
  delete(cwd: string, sessionId: string): Promise<RuntimeResult>;
  deleteOnce(cwd: string, sessionId: string): Promise<RuntimeResult>;
  withMutation<T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<T>;
  withSessionMutation<T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<T>;
  shutdownAll(): Promise<void>;
  scheduleWatchdog(item: Live): void;
  probe(item: Live): Promise<void>;
  recover(item: Live, force?: boolean): Promise<void>;
}

type MutableState = "beforeStart" | "hooks" | "stopping";
type StateAccess = { [K in MutableState]: { read(): SessionContext[K]; write(value: SessionContext[K]): void } };

/** Keep mutable lifecycle values on the owner while operations share its ports. */
export function createSessionContext(services: Omit<SessionContext, MutableState>, access: StateAccess): SessionContext {
  return {
    ...services,
    get beforeStart() { return access.beforeStart.read(); },
    set beforeStart(value) { access.beforeStart.write(value); },
    get hooks() { return access.hooks.read(); },
    set hooks(value) { access.hooks.write(value); },
    get stopping() { return access.stopping.read(); },
    set stopping(value) { access.stopping.write(value); },
  };
}
