import type { PiConfig } from "@pi-science/contracts";
import type { ConversationEventHub } from "../../events/conversation-event-hub.js";
import type { AgentRuntimeManager } from "../agent-runtime-manager.js";
import type { AgentSessionRepository } from "../agent-session-repository.js";
import type { AgentCoreRuntimeClient } from "../agent-runtime-client.js";
import type { RuntimeResult } from "../agent-runtime-types.js";
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
  workerEnvironment(cwd: string): Promise<Record<string, string>>;
  composerCommands(
    cwd: string,
    config: PiConfig,
  ): Promise<{
    commands: Array<{ name: string; description: string; source: string; group: string }>;
    revision: string;
  }>;
  credentialEnvNames(cwd: string): Promise<string[]>;
  owns(cwd: string, sessionId: string): Promise<boolean>;
  attach(
    key: string,
    runtime: AgentCoreRuntimeClient,
    model: string,
    level: string | null,
    config: PiConfig,
  ): Promise<Live>;

  open(cwd: string, sessionId: string, config: PiConfig): Promise<Live | RuntimeResult>;
  command(
    cwd: string,
    sessionId: string,
    type: string,
    params: Record<string, unknown>,
    config: PiConfig,
  ): Promise<RuntimeResult>;
  stopForReload(item: Live): Promise<void>;
  withMutation<T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<T>;
  scheduleWatchdog(item: Live): void;
  probe(item: Live): Promise<void>;
  recover(item: Live, force?: boolean): Promise<void>;
}

type MutableState = "beforeStart" | "hooks" | "stopping";
type StateAccess = {
  [K in MutableState]: { read(): SessionContext[K]; write(value: SessionContext[K]): void };
};

/** Keep mutable lifecycle values on the owner while operations share its ports. */
export function createSessionContext(
  services: Omit<SessionContext, MutableState>,
  access: StateAccess,
): SessionContext {
  return {
    ...services,
    get beforeStart() {
      return access.beforeStart.read();
    },
    set beforeStart(value) {
      access.beforeStart.write(value);
    },
    get hooks() {
      return access.hooks.read();
    },
    set hooks(value) {
      access.hooks.write(value);
    },
    get stopping() {
      return access.stopping.read();
    },
    set stopping(value) {
      access.stopping.write(value);
    },
  };
}
