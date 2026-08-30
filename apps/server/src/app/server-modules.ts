import { ConversationEventHub } from "../runtime/events/conversation-event-hub.js";
import { NodeSessionService } from "../runtime/node/node-session-service.js";
import { PiManager } from "../runtime/pi/pi-manager.js";
import { SessionRepository } from "../runtime/node/session-repository.js";
import { SettingsStore } from "../storage/settings-store.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";
import { JobCoordinator } from "../runtime/jobs/job-coordinator.js";
import type { ServerConfig } from "../config/config.js";
import { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { NodeKernelManager } from "../runtime/kernel/node-kernel-manager.js";
import { NotebookService } from "../runtime/notebooks/notebook-service.js";
import { ResearchLoopCoordinator } from "../research-loop/coordinator.js";
import { PiResearchSubagentRunner } from "../research-loop/subagent-runner.js";
import { ProjectReviewService } from "../project-review/service.js";
import { PiReviewSubagentRunner } from "../project-review/subagent-runner.js";
import { LiteratureService } from "../literature/literature-service.js";
import { configPath } from "../storage/persistence.js";
import { EnvironmentRepository } from "../storage/sqlite/repositories/environment-repository.js";
import { JobRepository } from "../storage/sqlite/repositories/job-repository.js";
import { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import {
  ScheduledTaskRepository,
  type LeaseRecoveryOutcome,
} from "../storage/sqlite/repositories/scheduled-task-repository.js";
import { SqliteStateStore } from "../storage/sqlite/state-store.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executionRepository } from "../runtime/executions/execution-repository.js";
import { ProvenanceRepository } from "../runtime/provenance/provenance-repository.js";
import { ExecutorRegistry } from "../scheduled-tasks/executor.js";
import { LiteratureDigestExecutor, type PreviousBaselineContext } from "../scheduled-tasks/literature-digest-executor.js";
import { PiJsonRunner } from "../scheduled-tasks/pi-json-runner.js";
import { ScheduledTaskDispatcher, DEFAULT_MAX_PARALLEL } from "../scheduled-tasks/dispatcher.js";
import { ScheduledTaskScheduler } from "../scheduled-tasks/scheduler.js";
import { ScheduledTaskService, type RuntimeDiagnosticsInput } from "../scheduled-tasks/service.js";

export interface ScheduledTasksModules {
  readonly service: ScheduledTaskService;
  /** Runtime graph exists only over durable SQLite (docs §11.1); when SQLite is
   * disabled these stay null and every route answers 503 before touching them. */
  readonly scheduler: ScheduledTaskScheduler | null;
  readonly dispatcher: ScheduledTaskDispatcher | null;
  readonly registry: ExecutorRegistry | null;
}

export interface ServerModules {
  readonly sessions: NodeSessionService;
  readonly events: ConversationEventHub;
  readonly sessionRepository: SessionRepository;
  readonly piManager: PiManager;
  readonly settings: SettingsStore;
  readonly modelResources: ModelResourceService;
  readonly jobs: JobCoordinator;
  readonly environments: WorkspaceEnvironmentService;
  readonly kernels: NodeKernelManager;
  readonly notebooks: NotebookService;
  readonly research: ResearchLoopCoordinator;
  readonly projectReview: ProjectReviewService;
  readonly literature: LiteratureService;
  readonly stateStore: SqliteStateStore;
  readonly workspaces: WorkspaceRepository;
  readonly environmentRepository: EnvironmentRepository;
  readonly jobRepository: JobRepository;
  readonly sqliteEnabled: boolean;
  readonly scheduled: ScheduledTasksModules;
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
  const environments = new WorkspaceEnvironmentService(undefined, config?.micromambaExecutable, sqliteEnabled ? environmentRepository : undefined);
  const kernels = new NodeKernelManager();
  const notebooks = new NotebookService({
    micromambaExecutable: config?.micromambaExecutable,
    micromambaResolver: () => environments.ensureMicromambaExecutable(),
    environments,
  });
  const settings = new SettingsStore();
  const modelResources = new ModelResourceService({ settings });
  const projectReview = new ProjectReviewService(new PiReviewSubagentRunner(environments, piManager), sessionRepository);
  const sessions = new NodeSessionService(events, piManager, sessionRepository, environments, projectReview, undefined, modelResources);
  const jobs = new JobCoordinator(environments, {}, undefined, sqliteEnabled ? jobRepository : undefined);
  const research = new ResearchLoopCoordinator(jobs, new PiResearchSubagentRunner(environments, piManager));
  const literature = new LiteratureService();
  // docs §11.1 scheduled-task graph: built only over durable SQLite; the
  // placeholder keeps routes answerable (they 503 before touching the nulls).
  const scheduledRepository = new ScheduledTaskRepository(stateStore);
  let scheduler: ScheduledTaskScheduler | null = null;
  let dispatcher: ScheduledTaskDispatcher | null = null;
  let registry: ExecutorRegistry | null = null;
  if (sqliteEnabled) {
    registry = new ExecutorRegistry();
    dispatcher = new ScheduledTaskDispatcher({ repository: scheduledRepository, registry });
    scheduler = new ScheduledTaskScheduler({
      repository: scheduledRepository,
      dispatch: () => { void dispatcher?.wake(); },
      onLeaseRecovered: (outcome) => reconcileLeaseRecoveredExecution(scheduledRepository, outcome),
    });
    // Production executor wiring (docs §9.2/§9.11): shared LiteratureService
    // instance, evidence repositories, and a delta-baseline loader scoped per attempt.
    registry.register(new LiteratureDigestExecutor({
      literature,
      pi: new PiJsonRunner(),
      executions: executionRepository,
      provenance: new ProvenanceRepository(),
      loadPreviousStableKeys: (context) => previousAttemptStableKeys(scheduledRepository, context),
    }));
  }
  const scheduledService = new ScheduledTaskService({
    repository: scheduledRepository,
    workspaces,
    ...(sqliteEnabled ? { runtimeDiagnostics: () => scheduledRuntimeDiagnostics(scheduler, dispatcher, scheduledRepository) } : {}),
  });
  const scheduled: ScheduledTasksModules = { service: scheduledService, scheduler, dispatcher, registry };
  return { sessions, events, sessionRepository, piManager, settings, modelResources, jobs, research, projectReview, literature, environments, kernels, notebooks, stateStore, workspaces, environmentRepository, jobRepository, sqliteEnabled, scheduled };
}

/** docs §9.11: lease recovery backfills start + terminal Execution evidence for
 * an owner that crashed mid-attempt. Idempotent — an already-terminal Execution
 * is left untouched so retries never double-finish. */
async function reconcileLeaseRecoveredExecution(repository: ScheduledTaskRepository, outcome: LeaseRecoveryOutcome): Promise<void> {
  try {
    const producer = "scheduled-task-service";
    const cwd = outcome.workspace_path;
    const existing = await executionRepository.get(cwd, outcome.execution_id);
    if (existing && existing.status !== "running") return;
    const run = existing ? null : await repository.getRun(outcome.run_id);
    if (!existing) {
      await executionRepository.start(cwd, {
        execution_id: outcome.execution_id,
        kind: "scheduled_task",
        surface: "pi",
        producer,
        correlation: {
          scheduled_task_id: outcome.task_id,
          scheduled_task_run_id: outcome.run_id,
          scheduled_task_attempt_id: outcome.attempt_id,
          run_id: outcome.run_id,
        },
        request: { executor_kind: run?.snapshot.executor.kind ?? "literature_digest", scheduled_for: run?.scheduled_for ?? "", business_date: run?.business_date ?? "" },
      });
    }
    await executionRepository.finish(cwd, outcome.execution_id, {
      status: outcome.outcome === "cancelled" ? "cancelled" : "interrupted",
      producer,
      result: { error_code: outcome.outcome === "cancelled" ? "CANCELLED" : "INTERRUPTED", recovery: outcome.outcome },
    });
  } catch {
    // Evidence reconciliation is best-effort; lease recovery must not depend on it.
  }
}

/** docs §9.8 production baseline loader: locate the previous successful
 * Attempt's directory via the repository, verify every run.json outputs hash,
 * then parse the sources.json stable_key list. Any mismatch or absence ⇒ null. */
async function previousAttemptStableKeys(repository: ScheduledTaskRepository, context: PreviousBaselineContext): Promise<string[] | null> {
  try {
    const previous = await repository.getPreviousSuccessfulAttempt(context.task_id, context.run_id);
    if (!previous) return null;
    const dir = join(resolve(context.cwd), ...previous.output_dir_relative.split("/"));
    const manifest = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as { outputs?: Record<string, unknown> };
    const outputs = manifest.outputs ?? {};
    if (typeof outputs["sources.json"] !== "string") return null;
    for (const [name, sha] of Object.entries(outputs)) {
      if (typeof sha !== "string") return null;
      const content = await readFile(join(dir, name), "utf8");
      if (createHash("sha256").update(content).digest("hex") !== sha) return null;
    }
    const sources = JSON.parse(await readFile(join(dir, "sources.json"), "utf8")) as { records?: Array<{ stable_key?: unknown }> };
    return (sources.records ?? []).map((row) => row.stable_key).filter((key): key is string => typeof key === "string");
  } catch {
    return null;
  }
}

/** Aggregated §11.7 runtime slice; repository counters fail soft so a broken
 * store degrades the block instead of failing /internal/diagnostics. */
async function scheduledRuntimeDiagnostics(
  scheduler: ScheduledTaskScheduler | null,
  dispatcher: ScheduledTaskDispatcher | null,
  repository: ScheduledTaskRepository,
): Promise<RuntimeDiagnosticsInput> {
  const schedulerSlice = scheduler?.describe() ?? null;
  const dispatcherSlice = dispatcher?.describe() ?? null;
  let lastError: string | null = schedulerSlice?.last_error ?? dispatcherSlice?.last_error ?? null;
  let pendingAttempts = 0;
  let activeAttempts = 0;
  let expiredLeases = 0;
  try {
    const nowMs = Date.now();
    pendingAttempts = (await repository.listPendingAttempts(nowMs, 1000)).length;
    const running = await repository.listActiveAttempts(1000);
    activeAttempts = running.length;
    expiredLeases = running.filter((attempt) => attempt.lease_expires_at !== null && Date.parse(attempt.lease_expires_at) <= nowMs).length;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  const baseStatus = schedulerSlice?.status ?? "stopped";
  const status: RuntimeDiagnosticsInput["status"] = lastError ? "degraded" : baseStatus === "starting" ? "starting" : baseStatus === "running" ? "running" : "stopped";
  return {
    status,
    last_tick_at: schedulerSlice?.last_tick_at ?? null,
    next_deadline_at: schedulerSlice?.next_deadline_at ?? null,
    pending_attempts: pendingAttempts,
    active_attempts: activeAttempts,
    expired_leases: expiredLeases,
    dispatcher_active: dispatcherSlice?.dispatcher_active ?? 0,
    dispatcher_limit: dispatcherSlice?.dispatcher_limit ?? DEFAULT_MAX_PARALLEL,
    last_error: lastError,
  };
}
