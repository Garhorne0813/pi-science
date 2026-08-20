import { ConversationEventHub } from "../runtime/events/conversation-event-hub.js";
import { NodeSessionService } from "../runtime/node/node-session-service.js";
import { PiManager } from "../runtime/pi/pi-manager.js";
import { SessionRepository } from "../runtime/node/session-repository.js";
import { SettingsStore } from "../storage/settings-store.js";
import { JobCoordinator } from "../runtime/jobs/job-coordinator.js";
import type { ServerConfig } from "../config/config.js";
import { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { NodeKernelManager } from "../runtime/kernel/node-kernel-manager.js";
import { NotebookService } from "../runtime/notebooks/notebook-service.js";
import { ResearchLoopCoordinator } from "../research-loop/coordinator.js";
import { PiResearchSubagentRunner } from "../research-loop/subagent-runner.js";
import { ProjectReviewService } from "../project-review/service.js";
import { PiReviewSubagentRunner } from "../project-review/subagent-runner.js";

export interface ServerModules {
  readonly sessions: NodeSessionService;
  readonly events: ConversationEventHub;
  readonly sessionRepository: SessionRepository;
  readonly piManager: PiManager;
  readonly settings: SettingsStore;
  readonly jobs: JobCoordinator;
  readonly environments: WorkspaceEnvironmentService;
  readonly kernels: NodeKernelManager;
  readonly notebooks: NotebookService;
  readonly research: ResearchLoopCoordinator;
  readonly projectReview: ProjectReviewService;
}

/** Creates an app-owned module graph. No mutable runtime state is shared across apps. */
export function createServerModules(config?: ServerConfig): ServerModules {
  const events = new ConversationEventHub();
  const sessionRepository = new SessionRepository();
  const piManager = new PiManager();
  const environments = new WorkspaceEnvironmentService(config?.pythonExecutable, config?.micromambaExecutable);
  const kernels = new NodeKernelManager();
  const notebooks = new NotebookService({ micromambaExecutable: config?.micromambaExecutable });
  const projectReview = new ProjectReviewService(new PiReviewSubagentRunner(environments, piManager), sessionRepository);
  const sessions = new NodeSessionService(events, piManager, sessionRepository, environments, projectReview);
  const settings = new SettingsStore();
  const jobs = new JobCoordinator(environments);
  const research = new ResearchLoopCoordinator(jobs, new PiResearchSubagentRunner(environments, piManager));
  return { sessions, events, sessionRepository, piManager, settings, jobs, research, projectReview, environments, kernels, notebooks };
}
