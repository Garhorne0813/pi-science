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
import { configPath } from "../storage/persistence.js";
import { EnvironmentRepository } from "../storage/sqlite/repositories/environment-repository.js";
import { JobRepository } from "../storage/sqlite/repositories/job-repository.js";
import { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import { SqliteStateStore } from "../storage/sqlite/state-store.js";

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
  readonly stateStore: SqliteStateStore;
  readonly workspaces: WorkspaceRepository;
  readonly environmentRepository: EnvironmentRepository;
  readonly jobRepository: JobRepository;
  readonly sqliteEnabled: boolean;
}

/** Creates an app-owned module graph. No mutable runtime state is shared across apps. */
export function createServerModules(config?: ServerConfig): ServerModules {
  const sqliteEnabled = process.env.PI_SCIENCE_SQLITE_STATE !== "0";
  const stateStore = new SqliteStateStore({ path: configPath("state.sqlite") });
  const workspaces = new WorkspaceRepository(stateStore);
  const environmentRepository = new EnvironmentRepository(stateStore);
  const jobRepository = new JobRepository(stateStore, workspaces);
  const events = new ConversationEventHub();
  const sessionRepository = new SessionRepository();
  const piManager = new PiManager();
  const environments = new WorkspaceEnvironmentService(undefined, config?.micromambaExecutable, sqliteEnabled ? environmentRepository : undefined);
  const kernels = new NodeKernelManager();
  const notebooks = new NotebookService({ micromambaExecutable: config?.micromambaExecutable, environments });
  const projectReview = new ProjectReviewService(new PiReviewSubagentRunner(environments, piManager), sessionRepository);
  const sessions = new NodeSessionService(events, piManager, sessionRepository, environments, projectReview);
  const settings = new SettingsStore();
  const jobs = new JobCoordinator(environments, {}, undefined, sqliteEnabled ? jobRepository : undefined);
  const research = new ResearchLoopCoordinator(jobs, new PiResearchSubagentRunner(environments, piManager));
  return { sessions, events, sessionRepository, piManager, settings, jobs, research, projectReview, environments, kernels, notebooks, stateStore, workspaces, environmentRepository, jobRepository, sqliteEnabled };
}
