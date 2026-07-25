import { ConversationEventHub } from "./conversation-event-hub.js";
import { NodeSessionService } from "./node-session-service.js";
import { PiManager } from "./pi-manager.js";
import { SessionRepository } from "./session-repository.js";
import { SettingsStore } from "./settings-store.js";
import { JobCoordinator } from "./job-coordinator.js";
import type { ServerConfig } from "./config.js";
import {
  ScientificRuntimeManager,
  type ScientificRuntimeController,
} from "./scientific-runtime-manager.js";
import { WorkspaceEnvironmentService } from "./workspace-environment.js";

export interface ServerModules {
  readonly sessions: NodeSessionService;
  readonly events: ConversationEventHub;
  readonly sessionRepository: SessionRepository;
  readonly piManager: PiManager;
  readonly settings: SettingsStore;
  readonly jobs: JobCoordinator;
  readonly scientificRuntime: ScientificRuntimeController;
  readonly environments: WorkspaceEnvironmentService;
}

/** Creates an app-owned module graph. No mutable runtime state is shared across apps. */
export function createServerModules(config?: ServerConfig): ServerModules {
  const events = new ConversationEventHub();
  const sessionRepository = new SessionRepository();
  const piManager = new PiManager();
  const environments = new WorkspaceEnvironmentService(config?.pythonExecutable);
  const sessions = new NodeSessionService(events, piManager, sessionRepository, environments);
  const settings = new SettingsStore();
  const jobs = new JobCoordinator(environments);
  const scientificRuntime = new ScientificRuntimeManager({
    origin: config?.pythonOrigin ?? "http://127.0.0.1:8788",
    managed: config?.manageScientificRuntime,
    pythonExecutable: config?.pythonExecutable,
    pythonCwd: config?.pythonCwd,
    internalToken: config?.internalToken,
    idleTimeoutMs: config?.scientificIdleMs,
    startupTimeoutMs: config?.scientificStartupMs,
  });
  return { sessions, events, sessionRepository, piManager, settings, jobs, scientificRuntime, environments };
}
