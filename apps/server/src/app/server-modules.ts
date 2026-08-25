import { ConversationEventHub } from "../runtime/events/conversation-event-hub.js";
import { NodeSessionService } from "../runtime/node/node-session-service.js";
import { PiManager } from "../runtime/pi/pi-manager.js";
import { SessionRepository } from "../runtime/node/session-repository.js";
import { SettingsStore } from "../storage/settings-store.js";
import { JobCoordinator } from "../runtime/jobs/job-coordinator.js";
import type { ServerConfig } from "../config/config.js";
import {
  ScientificRuntimeManager,
  type ScientificRuntimeController,
} from "../runtime/scientific/scientific-runtime-manager.js";
import { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { ResearchLoopCoordinator } from "../research-loop/coordinator.js";
import { PiResearchSubagentRunner } from "../research-loop/subagent-runner.js";
import { ProjectReviewService } from "../project-review/service.js";
import { PiReviewSubagentRunner } from "../project-review/subagent-runner.js";
import { LiteratureService } from "../literature/literature-service.js";
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
  readonly scientificRuntime: ScientificRuntimeController;
  readonly environments: WorkspaceEnvironmentService;
  readonly research: ResearchLoopCoordinator;
  readonly projectReview: ProjectReviewService;
  readonly literature: LiteratureService;
  readonly stateStore: SqliteStateStore;
  readonly workspaces: WorkspaceRepository;
  readonly environmentRepository: EnvironmentRepository;
  readonly jobRepository: JobRepository;
  readonly sqliteEnabled: boolean;
}

export interface ServerModuleOptions {
  sqliteEnabled?: boolean;
  stateStore?: SqliteStateStore;
}

/** Creates an app-owned module graph. No mutable runtime state is shared across apps. */
export function createServerModules(config?: ServerConfig, options: ServerModuleOptions = {}): ServerModules {
  const configuredSqlite = process.env.PI_SCIENCE_SQLITE_STATE;
  const sqliteEnabled = options.sqliteEnabled
    ?? (configuredSqlite === "1" || (configuredSqlite !== "0" && process.env.NODE_ENV !== "test"));
  const stateStore = options.stateStore ?? new SqliteStateStore({ path: sqliteEnabled ? configPath("state.sqlite") : ":memory:" });
  const workspaces = new WorkspaceRepository(stateStore);
  const environmentRepository = new EnvironmentRepository(stateStore);
  const jobRepository = new JobRepository(stateStore, workspaces);
  const events = new ConversationEventHub();
  const sessionRepository = new SessionRepository();
  const piManager = new PiManager();
  const environments = new WorkspaceEnvironmentService(config?.pythonExecutable, config?.micromambaExecutable);
  const projectReview = new ProjectReviewService(new PiReviewSubagentRunner(environments, piManager), sessionRepository);
  const sessions = new NodeSessionService(events, piManager, sessionRepository, environments, projectReview);
  const settings = new SettingsStore();
  const jobs = new JobCoordinator(environments);
  const research = new ResearchLoopCoordinator(jobs, new PiResearchSubagentRunner(environments, piManager));
  const literature = new LiteratureService();
  const scientificRuntime = new ScientificRuntimeManager({
    origin: config?.pythonOrigin ?? "http://127.0.0.1:8788",
    managed: config?.manageScientificRuntime,
    pythonExecutable: config?.pythonExecutable,
    pythonCwd: config?.pythonCwd,
    internalToken: config?.internalToken,
    idleTimeoutMs: config?.scientificIdleMs,
    startupTimeoutMs: config?.scientificStartupMs,
  });
  return { sessions, events, sessionRepository, piManager, settings, jobs, research, projectReview, literature, scientificRuntime, environments, stateStore, workspaces, environmentRepository, jobRepository, sqliteEnabled };
}
