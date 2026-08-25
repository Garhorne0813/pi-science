// ScheduledTaskService (docs §4.4 state ownership, §5.9 manual run, §5.10 retry,
// §9.3 recurring approval, §15.5 hard limits). Sole writer of task definitions,
// approvals and manual runs through repository CAS; never executes SQL directly.
// Every mutating/query method returns a typed outcome so HTTP routes (Phase 6)
// map codes to status without try/catch.
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";
import {
  retryPolicySchema,
  scheduledTaskBudgetSchema,
  scheduledTaskExecutorSchema,
  type ConcurrencyPolicy,
  type MisfirePolicy,
  type RetryPolicy,
  type ScheduledTaskBudget,
  type ScheduledTaskExecutor,
  type ScheduledTaskSchedule,
} from "@pi-science/contracts";
import { cronPreview, MIN_INTERVAL_SECONDS, validateSchedule } from "./schedule.js";
import { jitteredBackoffMs } from "./retry.js";
import { detectSensitiveTerms } from "../security/sensitive-terms.js";
import { ensureProject } from "../project/project-registry.js";
import { executionIdFor } from "../runtime/executions/execution-repository.js";
import { newId, ScheduledTaskRepository, type ListTasksOptions, type Page, type PatchScheduledTaskInput, type SetTaskStatusAction, type TaskListSummary } from "../storage/sqlite/repositories/scheduled-task-repository.js";
import type { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunAttempt,
  ScheduledTaskSnapshot,
} from "./types.js";
import {
  outputRootForbidden,
  policyViolation,
  runNotFound,
  runRetryNotAllowed,
  scheduledTasksDisabled,
  ScheduledTaskError,
  taskNotFound,
  workspaceForbidden,
  type ScheduledTaskErrorCode,
} from "./errors.js";

/** docs §15.5 feature flag: PI_SCIENCE_SCHEDULED_TASKS=1 enables everything. */
export function isScheduledTasksEnabled(): boolean {
  return process.env.PI_SCIENCE_SCHEDULED_TASKS === "1";
}

// ---------------------------------------------------------------------------
// Typed outcome envelope (docs §12.7 code → HTTP mapping lives in Phase 6)
// ---------------------------------------------------------------------------

export interface ScheduledTaskServiceFailure {
  code: ScheduledTaskErrorCode;
  http_status: number;
  message: string;
  details: Record<string, unknown>;
}

export type ScheduledTaskServiceOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: ScheduledTaskServiceFailure };

const HTTP_STATUS_BY_CODE: Record<ScheduledTaskErrorCode, number> = {
  INVALID_SCHEDULE: 400,
  INVALID_TIMEZONE: 400,
  INVALID_EXECUTOR_CONFIG: 400,
  INVALID_CURSOR: 400,
  WORKSPACE_FORBIDDEN: 403,
  SCHEDULED_TASK_NOT_FOUND: 404,
  SCHEDULED_TASK_RUN_NOT_FOUND: 404,
  SCHEDULED_TASK_REVISION_CONFLICT: 409,
  SCHEDULED_TASK_APPROVAL_REQUIRED: 409,
  SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED: 409,
  TASK_HAS_ACTIVE_RUN: 409,
  RUN_RETRY_NOT_ALLOWED: 409,
  SCHEDULED_TASK_POLICY_VIOLATION: 422,
  OUTPUT_ROOT_FORBIDDEN: 400,
  EXECUTOR_UNAVAILABLE: 500,
  SCHEDULED_TASKS_DISABLED: 503,
};

export function serviceFailure(error: unknown): ScheduledTaskServiceFailure {
  if (error instanceof ScheduledTaskError) {
    return { code: error.code, http_status: HTTP_STATUS_BY_CODE[error.code] ?? 500, message: error.message, details: error.details };
  }
  return { code: "SCHEDULED_TASK_POLICY_VIOLATION", http_status: 500, message: error instanceof Error ? error.message : String(error), details: {} };
}

function ok<T>(value: T): ScheduledTaskServiceOutcome<T> {
  return { ok: true, value };
}

function fail(error: unknown): ScheduledTaskServiceOutcome<never> {
  return { ok: false, error: serviceFailure(error) };
}

// ---------------------------------------------------------------------------
// Snapshot canonicalization (docs §7.5) — shared with the scheduler
// ---------------------------------------------------------------------------

/** Canonical JSON: object keys sorted, undefined dropped, array order kept.
 * One spelling of "snapshot bytes" for snapshot_sha256 across service and scheduler. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export interface SnapshotPayload {
  snapshot: ScheduledTaskSnapshot;
  /** Canonical JSON persisted as snapshot_json. */
  json: string;
  /** sha256 over the canonical JSON. */
  sha256: string;
}

/** Claim-time copy of the task (docs §7.5): approval collapses pending→none
 * because pending tasks are never scheduled; no secrets. */
export function buildSnapshot(task: ScheduledTask, claimedAtMs: number): SnapshotPayload {
  const snapshot: ScheduledTaskSnapshot = {
    schema_version: 1,
    task_id: task.task_id,
    project_id: task.project_id,
    workspace_path_at_claim: task.workspace_path,
    revision: task.revision,
    name: task.name,
    schedule: task.schedule,
    executor: task.executor,
    output: task.output,
    approval: {
      status: task.approval.status === "approved" ? "approved" : "none",
      scope_hash: task.approval.scope_hash,
      approved_revision: task.approval.approved_revision,
      categories: task.approval.categories,
    },
    retry: task.retry,
    budget: task.budget,
    misfire_policy: task.misfire_policy,
    concurrency_policy: task.concurrency_policy,
    claimed_at: new Date(claimedAtMs).toISOString(),
  };
  const json = stableStringify(snapshot);
  return { snapshot, json, sha256: createHash("sha256").update(json).digest("hex") };
}

// ---------------------------------------------------------------------------
// Output-root safety (docs §14.2 Security row / §15.5 hard limits)
// ---------------------------------------------------------------------------

/** Output roots must be plain relative workspace paths: no absolute form, no
 * `..` escape anywhere, and the reserved `.pi-science` metadata directory is
 * forbidden as any path segment (case-insensitive). */
export function assertSafeOutputRoot(relativeRoot: string): void {
  if (!relativeRoot || relativeRoot.trim().length === 0) throw outputRootForbidden(relativeRoot, "must be a non-empty relative path");
  if (isAbsolute(relativeRoot) || /^[a-zA-Z]:/.test(relativeRoot) || relativeRoot.startsWith("\\\\")) {
    throw outputRootForbidden(relativeRoot, "absolute paths are not allowed");
  }
  for (const segment of relativeRoot.replaceAll("\\", "/").split("/")) {
    if (segment === "..") throw outputRootForbidden(relativeRoot, "`..` segments are not allowed");
    if (segment.toLowerCase() === ".pi-science") throw outputRootForbidden(relativeRoot, ".pi-science is reserved metadata");
  }
}

// ---------------------------------------------------------------------------
// Diagnostics slot (docs §11.7) — real values injected by Phase 6 wiring
// ---------------------------------------------------------------------------

export interface ScheduledTasksDiagnostics {
  status: "disabled" | "starting" | "running" | "degraded" | "stopping" | "stopped";
  feature_enabled: boolean;
  last_tick_at: string | null;
  next_deadline_at: string | null;
  pending_attempts: number;
  active_attempts: number;
  expired_leases: number;
  dispatcher_active: number;
  dispatcher_limit: number;
  last_error: string | null;
}

export type RuntimeDiagnosticsInput = Omit<ScheduledTasksDiagnostics, "feature_enabled">;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CreateScheduledTaskRequest {
  name: string;
  schedule: unknown;
  executor: ScheduledTaskExecutor;
  output: { relative_root: string };
  retry?: Partial<RetryPolicy>;
  budget?: Partial<ScheduledTaskBudget>;
  misfire_policy?: MisfirePolicy;
  concurrency_policy?: ConcurrencyPolicy;
}

export interface ScheduledTaskServiceConfig {
  /** docs §15.5: max active tasks per workspace. */
  max_active_tasks_per_workspace: number;
  /** docs §15.5: minimum interval / cron frequency. */
  min_frequency_ms: number;
}

export interface ManualRunOutcome {
  status: "created" | "skipped";
  run: ScheduledTaskRun;
}

export interface CancelRunOutcome {
  status: "cancelled" | "requested";
  run: ScheduledTaskRun;
}

export interface ScheduledTaskServiceDeps {
  repository: ScheduledTaskRepository;
  workspaces?: WorkspaceRepository;
  now?: () => number;
  /** Deterministic random source for ±10% backoff jitter (docs §5.10). */
  rng?: () => number;
  config?: Partial<ScheduledTaskServiceConfig>;
  runtimeDiagnostics?: () => RuntimeDiagnosticsInput | Promise<RuntimeDiagnosticsInput>;
}

const DEFAULT_CONFIG: ScheduledTaskServiceConfig = {
  max_active_tasks_per_workspace: 20,
  min_frequency_ms: MIN_INTERVAL_SECONDS * 1000,
};

export class ScheduledTaskService {
  private readonly config: ScheduledTaskServiceConfig;
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(private readonly deps: ScheduledTaskServiceDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.now = deps.now ?? (() => Date.now());
    this.rng = deps.rng ?? Math.random;
  }

  private get repository(): ScheduledTaskRepository {
    return this.deps.repository;
  }

  // --- lifecycle -------------------------------------------------------------

  async createTask(workspacePath: string, request: CreateScheduledTaskRequest): Promise<ScheduledTaskServiceOutcome<ScheduledTask>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      const executor = scheduledTaskExecutorSchema.parse(request.executor);
      const schedule: ScheduledTaskSchedule = validateSchedule(request.schedule);
      assertSafeOutputRoot(request.output.relative_root);
      const retry = this.parseWith(retryPolicySchema, request.retry ?? {});
      const budget = this.parseWith(scheduledTaskBudgetSchema, request.budget ?? {});
      const projectId = await this.resolveProjectId(workspacePath);

      const activeCount = await this.repository.countActiveTasksByWorkspace(resolve(workspacePath));
      if (activeCount >= this.config.max_active_tasks_per_workspace) {
        throw policyViolation(`workspace already has ${activeCount} active scheduled tasks (limit ${this.config.max_active_tasks_per_workspace})`, {
          workspace_path: resolve(workspacePath),
          active_tasks: activeCount,
          limit: this.config.max_active_tasks_per_workspace,
        });
      }
      this.assertMinFrequency(schedule);

      const detection = detectSensitiveTerms(executor.config.query);
      let task = await this.repository.insertTask({
        project_id: projectId,
        workspace_path: resolve(workspacePath),
        name: request.name,
        schedule,
        executor,
        output: request.output,
        retry,
        budget,
        misfire_policy: request.misfire_policy,
        concurrency_policy: request.concurrency_policy,
        now: this.now(),
      });
      if (detection.matched && task.approval.status === "none") {
        // docs §9.3: sensitive query → durable 'pending' gate; next_run_at must be NULL.
        await this.repository.touchTaskApprovalPending(task.task_id, task.revision, task.approval.scope_hash, {
          categories: detection.categories,
          terms: detection.terms,
          now: this.now(),
        });
        task = (await this.repository.getTask(task.task_id))!;
      }
      return ok(task);
    } catch (error) {
      return fail(error);
    }
  }

  async patchTask(
    taskId: string,
    workspacePath: string,
    expectedRevision: number,
    patch: PatchScheduledTaskInput,
  ): Promise<ScheduledTaskServiceOutcome<ScheduledTask>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      await this.requireTaskInWorkspace(taskId, workspacePath);
      return ok(await this.repository.patchTask(taskId, expectedRevision, patch, this.now()));
    } catch (error) {
      return fail(error);
    }
  }

  async setTaskStatus(
    taskId: string,
    workspacePath: string,
    expectedRevision: number,
    action: SetTaskStatusAction,
  ): Promise<ScheduledTaskServiceOutcome<ScheduledTask>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      await this.requireTaskInWorkspace(taskId, workspacePath);
      return ok(await this.repository.setTaskStatus(taskId, expectedRevision, action, this.now()));
    } catch (error) {
      return fail(error);
    }
  }

  async approveTask(
    taskId: string,
    workspacePath: string,
    expectedRevision: number,
    scopeHash: string,
    categories: string[],
  ): Promise<ScheduledTaskServiceOutcome<ScheduledTask>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      const task = await this.requireTaskInWorkspace(taskId, workspacePath);
      // Keep the terms recorded at detection time; the approver confirms categories.
      return ok(await this.repository.approveTask(taskId, expectedRevision, scopeHash, categories, task.approval.terms, this.now()));
    } catch (error) {
      return fail(error);
    }
  }

  // --- runs ------------------------------------------------------------------

  /** docs §5.9: 202 semantics — never waits for execution; pending approval → 409. */
  async runNow(taskId: string, workspacePath: string): Promise<ScheduledTaskServiceOutcome<ManualRunOutcome>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      const task = await this.requireTaskInWorkspace(taskId, workspacePath);
      if (task.approval.status === "pending") throw new ScheduledTaskError("SCHEDULED_TASK_APPROVAL_REQUIRED", "Scheduled task requires approval before run", { task_id: taskId });
      const created = await this.repository.createManualRun(taskId, this.now());
      return ok({ status: created.status, run: created.run });
    } catch (error) {
      return fail(error);
    }
  }

  async cancelRun(runId: string, workspacePath: string): Promise<ScheduledTaskServiceOutcome<CancelRunOutcome>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      await this.requireRunInWorkspace(runId, workspacePath);
      const requested = await this.repository.requestCancel(runId, this.now());
      if (!requested) throw runNotFound(runId);
      const run = await this.repository.getRun(runId);
      if (!run) throw runNotFound(runId);
      return ok({ status: requested, run });
    } catch (error) {
      return fail(error);
    }
  }

  /** docs §5.10: only failed|timed_out|interrupted runs with attempts left may
   * retry; the fresh pending attempt joins the same run with the original
   * snapshot and a jittered exponential available_at. */
  async retryRun(taskId: string, runId: string, workspacePath: string): Promise<ScheduledTaskServiceOutcome<ScheduledTaskRunAttempt>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      await this.requireTaskInWorkspace(taskId, workspacePath);
      const run = await this.repository.getRun(runId);
      if (!run || run.task_id !== taskId) throw runNotFound(runId);
      if (run.status !== "failed" && run.status !== "timed_out" && run.status !== "interrupted") {
        throw runRetryNotAllowed(runId, `run status ${run.status} is not retryable`);
      }
      const maxAttempts = run.snapshot.retry.max_attempts;
      if (run.attempt_count >= maxAttempts) {
        throw runRetryNotAllowed(runId, `attempt_count ${run.attempt_count} reached max_attempts ${maxAttempts}`);
      }
      const previous = run.latest_attempt_id ? await this.repository.getAttempt(run.latest_attempt_id) : null;
      const failedAttemptNo = previous?.attempt_no ?? run.attempt_count;
      const availableAt = this.now() + jitteredBackoffMs(run.snapshot.retry, failedAttemptNo, this.rng);
      const attemptId = newId("satt");
      const created = await this.repository.insertRetryAttempt(runId, run.latest_attempt_id!, {
        attempt_id: attemptId,
        execution_id: executionIdFor("scheduled-task-attempt", attemptId),
        available_at: availableAt,
      }, this.now());
      return ok(created);
    } catch (error) {
      return fail(error);
    }
  }

  // --- reads -----------------------------------------------------------------

  async getTask(taskId: string, workspacePath: string): Promise<ScheduledTaskServiceOutcome<ScheduledTask | null>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      const task = await this.repository.getTask(taskId);
      // Deleted tasks read as missing (docs §12.8: cross-workspace/deleted → 404 semantics).
      if (!task || task.deleted_at !== null || task.workspace_path !== resolve(workspacePath)) return ok(null);
      return ok(task);
    } catch (error) {
      return fail(error);
    }
  }

  async listTasks(workspacePath: string, options: ListTasksOptions = {}): Promise<ScheduledTaskServiceOutcome<Page<TaskListSummary>>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      return ok(await this.repository.listTasks({ ...options, workspacePath: resolve(workspacePath) }));
    } catch (error) {
      return fail(error);
    }
  }

  async getRun(runId: string, workspacePath: string): Promise<ScheduledTaskServiceOutcome<ScheduledTaskRun | null>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      return ok(await this.findRunInWorkspace(runId, workspacePath));
    } catch (error) {
      return fail(error);
    }
  }

  async listRuns(
    taskId: string,
    workspacePath: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<ScheduledTaskServiceOutcome<Page<ScheduledTaskRun>>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      await this.requireTaskInWorkspace(taskId, workspacePath);
      return ok(await this.repository.listRuns(taskId, options));
    } catch (error) {
      return fail(error);
    }
  }

  async listAttempts(
    taskId: string,
    runId: string,
    workspacePath: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<ScheduledTaskServiceOutcome<Page<ScheduledTaskRunAttempt>>> {
    if (!isScheduledTasksEnabled()) return fail(scheduledTasksDisabled());
    try {
      await this.requireRunInWorkspace(runId, workspacePath);
      return ok(await this.repository.listAttempts(runId, options));
    } catch (error) {
      return fail(error);
    }
  }

  // --- diagnostics -----------------------------------------------------------

  /** Aggregates the §11.7 diagnostics block. Scheduler/dispatcher values arrive
   * through the injected runtimeDiagnostics provider; without wiring the block
   * reports neutral zeros so `/internal/diagnostics` stays shape-stable. */
  async diagnostics(): Promise<ScheduledTasksDiagnostics> {
    const featureEnabled = isScheduledTasksEnabled();
    const runtime = this.deps.runtimeDiagnostics ? await this.deps.runtimeDiagnostics() : undefined;
    return {
      // A disabled feature never reports a live runtime regardless of wiring.
      status: !featureEnabled ? "disabled" : runtime?.status ?? "running",
      feature_enabled: featureEnabled,
      last_tick_at: runtime?.last_tick_at ?? null,
      next_deadline_at: runtime?.next_deadline_at ?? null,
      pending_attempts: runtime?.pending_attempts ?? 0,
      active_attempts: runtime?.active_attempts ?? 0,
      expired_leases: runtime?.expired_leases ?? 0,
      dispatcher_active: runtime?.dispatcher_active ?? 0,
      dispatcher_limit: runtime?.dispatcher_limit ?? 2,
      last_error: runtime?.last_error ?? null,
    };
  }

  // --- internals ---------------------------------------------------------------

  private parseWith<T>(schema: { parse(input: unknown): T }, input: unknown): T {
    try {
      return schema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        throw policyViolation(`policy field validation failed: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`, {});
      }
      throw error;
    }
  }

  private assertMinFrequency(schedule: ScheduledTaskSchedule): void {
    if (schedule.type === "interval") {
      if (schedule.every_seconds * 1000 < this.config.min_frequency_ms) {
        throw policyViolation(`interval must be at least ${this.config.min_frequency_ms}ms`, { every_seconds: schedule.every_seconds });
      }
      return;
    }
    if (schedule.type === "cron") {
      const occurrences = cronPreview(schedule, 2, this.now());
      if (occurrences.length < 2 || occurrences[1]!.timestamp_ms - occurrences[0]!.timestamp_ms < this.config.min_frequency_ms) {
        throw policyViolation(`cron expression fires more often than every ${this.config.min_frequency_ms}ms`, { expression: schedule.expression });
      }
    }
  }

  /** Resolve project ownership: registered workspaces win (getByProject/listKnown
   * data), otherwise fall back to ensureProject(cwd) manifest creation. */
  private async resolveProjectId(workspacePath: string): Promise<string> {
    if (this.deps.workspaces) {
      const target = resolve(workspacePath);
      const known = await this.deps.workspaces.listKnown();
      const match = known.find((location) => samePath(location.canonical_path, target));
      if (!match) throw workspaceForbidden(workspacePath);
      return match.project_id;
    }
    const manifest = await ensureProject(workspacePath);
    // The manifest lives on the filesystem; mirror the project row so the
    // scheduled_tasks FK holds (docs §7.3 projects(project_id) RESTRICT).
    await this.repository.ensureProjectRow(manifest.id, manifest.name, this.now());
    return manifest.id;
  }

  private async requireTaskInWorkspace(taskId: string, workspacePath: string): Promise<ScheduledTask> {
    const task = await this.repository.getTask(taskId);
    if (!task || task.deleted_at !== null || task.workspace_path !== resolve(workspacePath)) throw taskNotFound(taskId);
    return task;
  }

  private async requireRunInWorkspace(runId: string, workspacePath: string): Promise<void> {
    const found = await this.findRunInWorkspace(runId, workspacePath);
    if (!found) throw runNotFound(runId);
  }

  private async findRunInWorkspace(runId: string, workspacePath: string): Promise<ScheduledTaskRun | null> {
    const run = await this.repository.getRun(runId);
    if (!run) return null;
    const task = await this.repository.getTask(run.task_id);
    if (!task || task.workspace_path !== resolve(workspacePath)) return null;
    return run;
  }
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
