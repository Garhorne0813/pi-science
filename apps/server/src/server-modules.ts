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
import { ResearchLoopCoordinator } from "./research-loop/coordinator.js";
import { PiResearchSubagentRunner } from "./research-loop/subagent-runner.js";
import { ProjectReviewService } from "./project-review/service.js";
import { PiReviewSubagentRunner } from "./project-review/subagent-runner.js";

export interface ServerModules {
  readonly sessions: NodeSessionService;
  readonly events: ConversationEventHub;
  readonly sessionRepository: SessionRepository;
  readonly piManager: PiManager;
  readonly settings: SettingsStore;
  readonly jobs: JobCoordinator;
  readonly scientificRuntime: ScientificRuntimeController;
  readonly environments: WorkspaceEnvironmentService;
  readonly research: ResearchLoopCoordinator;
  readonly projectReview: ProjectReviewService;
}

/** Creates an app-owned module graph. No mutable runtime state is shared across apps. */
export function createServerModules(config?: ServerConfig): ServerModules {
  const events = new ConversationEventHub();
  const sessionRepository = new SessionRepository();
  const piManager = new PiManager();
  const environments = new WorkspaceEnvironmentService(config?.pythonExecutable);
  const projectReview = new ProjectReviewService(new PiReviewSubagentRunner(environments, piManager), sessionRepository);
  const sessions = new NodeSessionService(events, piManager, sessionRepository, environments, projectReview);
  const settings = new SettingsStore();
  const jobs = new JobCoordinator(environments);
  const research = new ResearchLoopCoordinator(jobs, new PiResearchSubagentRunner(environments, piManager));
  const scientificRuntime = new ScientificRuntimeManager({
    origin: config?.pythonOrigin ?? "http://127.0.0.1:8788",
    managed: config?.manageScientificRuntime,
    pythonExecutable: config?.pythonExecutable,
    pythonCwd: config?.pythonCwd,
    internalToken: config?.internalToken,
    idleTimeoutMs: config?.scientificIdleMs,
    startupTimeoutMs: config?.scientificStartupMs,
  });
  return { sessions, events, sessionRepository, piManager, settings, jobs, research, projectReview, scientificRuntime, environments };
}
