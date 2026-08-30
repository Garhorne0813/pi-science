// Durable storage for scheduled tasks (docs §7, §8). Every write goes through
// stateStore.batch so `expectChanges` assertions roll back inside the SQLite
// worker transaction; reads use get/all. Times are Unix milliseconds inside
// this module and ISO 8601 strings in every exported DTO.
import { createHash, randomUUID } from "node:crypto";
import type {
  ConcurrencyPolicy,
  MisfirePolicy,
  RetryPolicy,
  ScheduledTaskBudget,
  ScheduledTaskDeliveryPolicy,
  ScheduledTaskDisplay,
  ScheduledTaskExecutor,
  ScheduledTaskOrigin,
  ScheduledTaskRunOutcome,
  ScheduledTaskRunSummary,
  ScheduledTaskSchedule,
} from "@pi-science/contracts";
import {
  approvalRequired,
  approvalScopeChanged,
  invalidCursor,
  policyViolation,
  revisionConflict,
  taskHasActiveRun,
  taskNotFound,
  ScheduledTaskError,
} from "../../../scheduled-tasks/errors.js";
import { businessDateFor, firstOccurrence, validateSchedule } from "../../../scheduled-tasks/schedule.js";
import { computeApprovalScopeHash } from "../../../scheduled-tasks/approval.js";
import { executionIdFor } from "../../../runtime/executions/execution-repository.js";
import type {
  ScheduledTask,
  ScheduledTaskAttemptStatus,
  ScheduledTaskLifecycleStatus,
  ScheduledTaskRun,
  ScheduledTaskRunAttempt,
  ScheduledTaskRunStatus,
  ScheduledTaskSnapshot,
} from "../../../scheduled-tasks/types.js";
import type { SqliteStateStore } from "../state-store.js";
import type { SqlStatement, SqlValue } from "../protocol.js";
import { SqliteStateError } from "../errors.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Input / result shapes
// ---------------------------------------------------------------------------

export interface InsertScheduledTaskInput {
  project_id: string;
  workspace_path: string;
  name: string;
  display?: ScheduledTaskDisplay;
  origin?: ScheduledTaskOrigin;
  delivery_policy?: ScheduledTaskDeliveryPolicy;
  /** Raw schedule value; validated + normalized via validateSchedule before persisting. */
  schedule: unknown;
  executor: ScheduledTaskExecutor;
  output: { relative_root: string };
  retry: RetryPolicy;
  budget: ScheduledTaskBudget;
  misfire_policy?: MisfirePolicy;
  concurrency_policy?: ConcurrencyPolicy;
  now: number;
}

/** docs §5.11 edit rules: any successful PATCH bumps revision; sensitive-scope
 * changes reset approval; schedule changes recompute the future next_run_at. */
export interface PatchScheduledTaskInput {
  name?: string;
  display?: ScheduledTaskDisplay;
  origin?: ScheduledTaskOrigin;
  delivery_policy?: ScheduledTaskDeliveryPolicy;
  schedule?: unknown;
  executor?: ScheduledTaskExecutor;
  output?: { relative_root: string };
  retry?: RetryPolicy;
  budget?: ScheduledTaskBudget;
  misfire_policy?: MisfirePolicy;
}

export type SetTaskStatusAction = "pause" | "resume" | "delete";

/** docs §8.2 — caller supplies ids, occurrence key, snapshot and the advanced
 * next_run_at; the transaction supplies atomicity. */
export interface ClaimOccurrenceInput {
  task_id: string;
  expected_revision: number;
  expected_next_run_at: number;
  run_id: string;
  attempt_id: string;
  execution_id: string;
  occurrence_key: string;
  scheduled_for: number;
  business_date: string;
  trigger_source: "automatic" | "reconcile";
  next_run_at: number | null;
  completes_once: boolean;
  snapshot_json: string;
  snapshot_sha256: string;
  context_json?: string;
  now: number;
}

export type ClaimOccurrenceResult =
  | { status: "claimed"; task: ScheduledTask }
  | { status: "already_claimed"; run_id: string }
  | { status: "conflict"; reason: "task_missing" | "revision_conflict" | "not_due" | "approval_pending" | "active_run_exists" | "lost_race" };

/** docs §8.3 overlap-forbid branch: insert a terminal skipped Run guarded on an
 * active Run existing, then advance the task. */
export interface SkipOccurrenceInput {
  task_id: string;
  expected_revision: number;
  expected_next_run_at: number;
  run_id: string;
  occurrence_key: string;
  scheduled_for: number;
  business_date: string;
  trigger_source: "automatic" | "reconcile";
  next_run_at: number | null;
  completes_once: boolean;
  snapshot_json: string;
  snapshot_sha256: string;
  context_json?: string;
  error_code?: string;
  error_message?: string;
  /** Overlap-forbid branch (default): guarded on an active Run existing.
   * Misfire-skip branch (false): no active Run required (docs §5.7 skip). */
  requires_active_run?: boolean;
  now: number;
}

export interface ManualRunResult {
  status: "created" | "skipped";
  run: ScheduledTaskRun;
  attempt: ScheduledTaskRunAttempt | null;
}

export interface AttemptLease {
  attempt_id: string;
  run_id: string;
  owner_instance_id: string;
  owner_token: string;
  owner_generation: number;
  lease_expires_at: number;
}

export interface FinishAttemptTerminal {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  error_code?: string | null;
  error_message?: string | null;
  output_paths?: string[];
  usage?: Record<string, unknown>;
  retryable?: boolean | null;
  outcome?: ScheduledTaskRunOutcome;
  summary?: ScheduledTaskRunSummary;
  recommend_notify?: boolean;
}

export interface RetryAttemptPlan {
  execution_id: string;
  available_at: number;
  /** Optional caller-supplied attempt id so the deterministic execution_id can
   * be derived from it before insert; defaults to an internally generated id. */
  attempt_id?: string;
}

export interface RetryDecision {
  execution_id: string;
  available_at: number;
}

export interface ExpiredAttemptView {
  attempt_id: string;
  run_id: string;
  task_id: string;
  project_id: string;
  workspace_path: string;
  execution_id: string;
  attempt_no: number;
  cancel_requested: boolean;
  retry: RetryPolicy;
}

export type LeaseRecoveryOutcome = {
  outcome: "cancelled" | "interrupted" | "retried";
  attempt_id: string;
  new_attempt_id: string | null;
  run_id: string;
  task_id: string;
  execution_id: string;
  workspace_path: string;
};

export interface ListTasksOptions {
  projectId?: string;
  workspacePath?: string;
  limit?: number;
  cursor?: string | null;
}

/** docs §12.5 task list summary — produced by one SQL query, no N+1. */
export interface TaskListSummary {
  task_id: string;
  revision: number;
  name: string;
  display: ScheduledTaskDisplay;
  delivery_policy: ScheduledTaskDeliveryPolicy;
  lifecycle_status: ScheduledTaskLifecycleStatus;
  schedule: ScheduledTaskSchedule;
  approval_status: "none" | "pending" | "approved";
  next_run_at: string | null;
  latest_run: null | {
    run_id: string;
    status: ScheduledTaskRunStatus;
    outcome: ScheduledTaskRunOutcome | null;
    summary: ScheduledTaskRunSummary;
    delivery: ScheduledTaskRun["delivery"];
    scheduled_for: string;
    ended_at: string | null;
    latest_attempt_id: string | null;
    execution_id: string | null;
  };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Delta-baseline pointer for docs §9.8; consumed by the production
 * loadPreviousStableKeys wiring in server-modules. */
export interface PreviousSuccessfulAttemptInfo {
  task_id: string;
  run_id: string;
  attempt_id: string;
  /** Canonical workspace path of the task row. */
  workspace_path: string;
  /** Attempt output directory relative to the workspace, forward slashes. */
  output_dir_relative: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class ScheduledTaskRepository {
  constructor(private readonly store: SqliteStateStore) {}

  // --- task definition -----------------------------------------------------

  async insertTask(input: InsertScheduledTaskInput): Promise<ScheduledTask> {
    const schedule = validateSchedule(input.schedule);
    const taskId = newId("stask");
    const scopeHash = computeApprovalScopeHash(input.executor, input.output.relative_root);
    // docs §4.1: next_run_at may only be non-null while active and not approval-pending;
    // a freshly inserted task is active + none, so the first occurrence arms it.
    const nextRunAt = firstOccurrence(schedule, input.now);
    const misfire = input.misfire_policy ?? "coalesce_latest";
    const concurrency = input.concurrency_policy ?? "forbid";
    const display = input.display ?? {};
    const origin = input.origin ?? {};
    const deliveryPolicy = input.delivery_policy ?? "only_when_relevant";
    await this.store.batch([
      {
        sql: `INSERT INTO scheduled_tasks
              (task_id, project_id, workspace_path, schema_version, revision, name, lifecycle_status, deleted_at,
               schedule_json, executor_kind, config_json, output_json,
               approval_status, approval_scope_hash, approval_revision, approval_categories_json, approval_terms_json, approval_updated_at,
               retry_json, budget_json, misfire_policy, concurrency_policy,
               next_run_at, last_scheduled_at, last_run_id, created_at, updated_at,
               display_json, origin_json, delivery_policy)
              VALUES (?, ?, ?, 1, 1, ?, 'active', NULL, ?, ?, ?, ?, 'none', ?, NULL, '[]', '[]', NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        params: [
          taskId, input.project_id, input.workspace_path, input.name,
          JSON.stringify(schedule), input.executor.kind, JSON.stringify(input.executor.config), JSON.stringify(input.output),
          scopeHash, JSON.stringify(input.retry), JSON.stringify(input.budget), misfire, concurrency,
          nextRunAt, input.now, input.now, JSON.stringify(display), JSON.stringify(origin), deliveryPolicy,
        ],
        expectChanges: 1,
      },
    ]);
    return (await this.getTask(taskId))!;
  }

  async getTask(taskId: string): Promise<ScheduledTask | null> {
    const row = await this.taskRow(taskId);
    return row ? toTaskDto(row) : null;
  }

  async listTasks(options: ListTasksOptions = {}): Promise<Page<TaskListSummary>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeTaskCursor(options.cursor);
    const projectId = options.projectId ?? "";
    const workspacePath = options.workspacePath ?? "";
    const params: SqlValue[] = [projectId, projectId, workspacePath, workspacePath];
    let cursorPredicate = "";
    if (cursor) {
      cursorPredicate = "AND (st.created_at < ? OR (st.created_at = ? AND st.task_id < ?))";
      params.push(cursor.c, cursor.c, cursor.t);
    }
    params.push(limit + 1);
    const rows = await this.store.all<ListTasksRow>(
      `WITH ranked AS (
         SELECT r.task_id, r.run_id, r.status, r.outcome, r.summary_json, r.delivery_json,
                r.scheduled_for, r.ended_at, r.latest_attempt_id,
                ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.created_at DESC, r.run_id DESC) AS rn
           FROM scheduled_task_runs r
       )
       SELECT st.task_id, st.revision, st.name, st.display_json, st.delivery_policy, st.lifecycle_status, st.schedule_json,
              st.approval_status, st.next_run_at, st.created_at,
              rr.run_id AS lr_run_id, rr.status AS lr_status, rr.outcome AS lr_outcome,
              rr.summary_json AS lr_summary_json, rr.delivery_json AS lr_delivery_json,
              rr.scheduled_for AS lr_scheduled_for, rr.ended_at AS lr_ended_at, rr.latest_attempt_id AS lr_latest_attempt_id,
              ea.execution_id AS lr_execution_id
         FROM scheduled_tasks st
         LEFT JOIN ranked rr ON rr.task_id = st.task_id AND rr.rn = 1
         LEFT JOIN scheduled_task_run_attempts ea ON ea.attempt_id = rr.latest_attempt_id
        WHERE st.deleted_at IS NULL
          AND (? = '' OR st.project_id = ?)
          AND (? = '' OR st.workspace_path = ?)
          ${cursorPredicate}
        ORDER BY st.created_at DESC, st.task_id DESC
        LIMIT ?`,
      params,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toTaskListSummary);
    return {
      items,
      next_cursor: hasMore && items.length > 0
        ? encodeCursor({ c: rows[limit - 1]!.created_at, t: rows[limit - 1]!.task_id })
        : null,
    };
  }

  async patchTask(taskId: string, expectedRevision: number, patch: PatchScheduledTaskInput, nowMs: number): Promise<ScheduledTask> {
    const current = await this.requireLiveTaskRow(taskId, expectedRevision);
    const name = patch.name ?? current.name;
    const display = patch.display ?? parseJson<ScheduledTaskDisplay>(current.display_json, {});
    const origin = patch.origin ?? parseJson<ScheduledTaskOrigin>(current.origin_json, {});
    const deliveryPolicy = patch.delivery_policy ?? current.delivery_policy as ScheduledTaskDeliveryPolicy;
    const scheduleChanged = patch.schedule !== undefined;
    const schedule = scheduleChanged ? validateSchedule(patch.schedule) : parseJson<ScheduledTaskSchedule>(current.schedule_json, undefined as never);
    const executor: ScheduledTaskExecutor = patch.executor
      ? { kind: patch.executor.kind, config: patch.executor.config }
      : { kind: castExecutorKind(current.executor_kind), config: parseJson(current.config_json, undefined as never) };
    const output = patch.output ?? parseJson<{ relative_root: string }>(current.output_json, undefined as never);
    const retry = patch.retry ?? parseJson<RetryPolicy>(current.retry_json, undefined as never);
    const budget = patch.budget ?? parseJson<ScheduledTaskBudget>(current.budget_json, undefined as never);
    const scopeHash = computeApprovalScopeHash(executor, output.relative_root);
    // docs §5.11: sensitive-scope change (query/providers/instructions/output root)
    // resets approval to none; name-only edits leave approval untouched.
    const scopeChanged = scopeHash !== current.approval_scope_hash;
    let nextRunAt: number | null = current.next_run_at === null ? null : Number(current.next_run_at);
    if (scheduleChanged) {
      const armed = current.lifecycle_status === "active" && current.approval_status !== "pending";
      nextRunAt = armed ? firstOccurrence(schedule, nowMs) : null;
    }
    const statements: SqlStatement[] = [{
      sql: `UPDATE scheduled_tasks
              SET name = ?, schedule_json = ?, executor_kind = ?, config_json = ?, output_json = ?,
                  approval_status = ?, approval_scope_hash = ?, approval_revision = ?,
                  approval_categories_json = ?, approval_terms_json = ?, approval_updated_at = ?,
                  retry_json = ?, budget_json = ?, misfire_policy = ?, next_run_at = ?,
                  display_json = ?, origin_json = ?, delivery_policy = ?,
                  revision = revision + 1, updated_at = ?
            WHERE task_id = ? AND revision = ?`,
      params: [
        name, JSON.stringify(schedule), executor.kind, JSON.stringify(executor.config), JSON.stringify(output),
        scopeChanged ? "none" : current.approval_status, scopeHash, scopeChanged ? null : current.approval_revision,
        scopeChanged ? "[]" : current.approval_categories_json, scopeChanged ? "[]" : current.approval_terms_json, scopeChanged ? nowMs : current.approval_updated_at,
        JSON.stringify(retry), JSON.stringify(budget), patch.misfire_policy ?? current.misfire_policy, nextRunAt,
        JSON.stringify(display), JSON.stringify(origin), deliveryPolicy,
        nowMs, taskId, expectedRevision,
      ],
      expectChanges: 1,
    }];
    try {
      await this.store.batch(statements);
    } catch (error) {
      if (isExpectChangesFailure(error)) throw await this.classifyCasFailure(taskId, expectedRevision);
      throw error;
    }
    return (await this.getTask(taskId))!;
  }

  /** docs §5.11 pause/resume/delete; every successful transition bumps revision. */
  async setTaskStatus(taskId: string, expectedRevision: number, action: SetTaskStatusAction, nowMs: number): Promise<ScheduledTask> {
    const current = await this.requireLiveTaskRow(taskId, expectedRevision);
    if (action === "pause") {
      await this.store.batch([{
        sql: `UPDATE scheduled_tasks SET lifecycle_status = 'paused', next_run_at = NULL, revision = revision + 1, updated_at = ?
               WHERE task_id = ? AND revision = ? AND deleted_at IS NULL`,
        params: [nowMs, taskId, expectedRevision],
        expectChanges: 1,
      }]);
    } else if (action === "resume") {
      if (current.approval_status === "pending") throw approvalRequired(taskId);
      if (current.lifecycle_status === "completed") throw policyViolation("completed once tasks cannot be resumed", { task_id: taskId });
      const schedule = parseJson<ScheduledTaskSchedule>(current.schedule_json, undefined as never);
      const nextRunAt = firstOccurrence(schedule, nowMs);
      await this.store.batch([{
        sql: `UPDATE scheduled_tasks SET lifecycle_status = 'active', next_run_at = ?, revision = revision + 1, updated_at = ?
               WHERE task_id = ? AND revision = ? AND lifecycle_status IN ('active', 'paused') AND deleted_at IS NULL`,
        params: [nextRunAt, nowMs, taskId, expectedRevision],
        expectChanges: 1,
      }]);
    } else {
      // Delete asserts "no active run" and CAS-deletes in one statement: an
      // active run makes the UPDATE match zero rows, which the expectChanges
      // assertion turns into a rollback instead of a partial delete.
      try {
        await this.store.batch([{
          sql: `UPDATE scheduled_tasks SET deleted_at = ?, next_run_at = NULL, revision = revision + 1, updated_at = ?
                 WHERE task_id = ? AND revision = ? AND deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM scheduled_task_runs WHERE task_id = scheduled_tasks.task_id AND active_slot = 1)`,
          params: [nowMs, nowMs, taskId, expectedRevision],
          expectChanges: 1,
        }]);
      } catch (error) {
        if (!isExpectChangesFailure(error)) throw error;
        const active = await this.store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ? AND active_slot = 1",
          [taskId],
        );
        if (Number(active?.count ?? 0) > 0) throw taskHasActiveRun(taskId);
        throw await this.classifyCasFailure(taskId, expectedRevision);
      }
    }
    return (await this.getTask(taskId))!;
  }

  /** docs §5.11 approve: CAS on revision AND scope hash together; never bumps
   * revision; repeating an identical approve returns the current row. */
  async approveTask(taskId: string, expectedRevision: number, scopeHash: string, categories: string[], terms: string[], nowMs: number): Promise<ScheduledTask> {
    const current = await this.requireLiveTaskRow(taskId, expectedRevision);
    if (current.approval_status === "approved" && current.approval_scope_hash === scopeHash) return toTaskDto(current);
    try {
      await this.store.batch([{
        sql: `UPDATE scheduled_tasks
                SET approval_status = 'approved', approval_revision = revision,
                    approval_categories_json = ?, approval_terms_json = ?, approval_updated_at = ?
              WHERE task_id = ? AND revision = ? AND approval_scope_hash = ? AND deleted_at IS NULL`,
        params: [JSON.stringify(categories), JSON.stringify(terms), nowMs, taskId, expectedRevision, scopeHash],
        expectChanges: 1,
      }]);
    } catch (error) {
      if (!isExpectChangesFailure(error)) throw error;
      const fresh = await this.taskRow(taskId);
      if (!fresh || fresh.deleted_at !== null) throw taskNotFound(taskId);
      if (fresh.approval_scope_hash !== scopeHash) throw approvalScopeChanged(taskId, scopeHash);
      throw revisionConflict(taskId, expectedRevision, Number(fresh.revision));
    }
    return (await this.getTask(taskId))!;
  }

  // --- occurrence claiming (docs §8.2–§8.4) ---------------------------------

  async claimOccurrence(input: ClaimOccurrenceInput): Promise<ClaimOccurrenceResult> {
    // Pre-reads only classify failures; the batch below re-asserts every
    // condition inside BEGIN IMMEDIATE, so races degrade to typed conflicts.
    const task = await this.taskRow(input.task_id);
    if (!task || task.deleted_at !== null) return { status: "conflict", reason: "task_missing" };
    if (Number(task.revision) !== input.expected_revision) return { status: "conflict", reason: "revision_conflict" };
    if (task.approval_status === "pending") return { status: "conflict", reason: "approval_pending" };
    if (task.next_run_at === null || Number(task.next_run_at) !== input.expected_next_run_at) return { status: "conflict", reason: "not_due" };
    const existing = await this.store.get<{ run_id: string }>("SELECT run_id FROM scheduled_task_runs WHERE occurrence_key = ?", [input.occurrence_key]);
    if (existing) return { status: "already_claimed", run_id: existing.run_id };
    const now = input.now;
    try {
      await this.store.batch([
        {
          sql: `INSERT INTO scheduled_task_runs
                (run_id, task_id, task_revision, trigger_source, scheduled_for, business_date, occurrence_key,
                 status, active_slot, snapshot_json, snapshot_sha256, context_json, created_at, updated_at)
                SELECT ?, t.task_id, t.revision, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?
                  FROM scheduled_tasks t
                 WHERE t.task_id = ?
                   AND t.revision = ?
                   AND t.lifecycle_status = 'active'
                   AND t.deleted_at IS NULL
                   AND t.approval_status != 'pending'
                   AND t.next_run_at = ?
                   AND t.next_run_at <= ?
                   AND NOT EXISTS (
                     SELECT 1 FROM scheduled_task_runs active
                      WHERE active.task_id = t.task_id AND active.active_slot = 1
                   )`,
          params: [
            input.run_id, input.trigger_source, input.scheduled_for, input.business_date, input.occurrence_key,
            input.snapshot_json, input.snapshot_sha256, input.context_json ?? "{}", now, now,
            input.task_id, input.expected_revision, input.expected_next_run_at, now,
          ],
          expectChanges: 1,
        },
        {
          sql: `INSERT INTO scheduled_task_run_attempts
                (attempt_id, run_id, attempt_no, status, active_slot, available_at, execution_id, created_at, updated_at)
                SELECT ?, r.run_id, 1, 'pending', 1, ?, ?, ?, ?
                  FROM scheduled_task_runs r
                 WHERE r.run_id = ? AND r.status = 'pending'`,
          params: [input.attempt_id, now, input.execution_id, now, now, input.run_id],
          expectChanges: 1,
        },
        {
          sql: "UPDATE scheduled_task_runs SET latest_attempt_id = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE run_id = ? AND status = 'pending'",
          params: [input.attempt_id, now, input.run_id],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_tasks
                  SET next_run_at = ?, last_scheduled_at = ?, last_run_id = ?,
                      lifecycle_status = CASE WHEN ? = 1 THEN 'completed' ELSE lifecycle_status END,
                      updated_at = ?
                WHERE task_id = ? AND revision = ? AND lifecycle_status = 'active' AND deleted_at IS NULL AND next_run_at = ?`,
          params: [
            input.next_run_at, input.scheduled_for, input.run_id,
            input.completes_once ? 1 : 0, now,
            input.task_id, input.expected_revision, input.expected_next_run_at,
          ],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (!isExpectChangesFailure(error)) throw error;
      const active = await this.store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ? AND active_slot = 1",
        [input.task_id],
      );
      return Number(active?.count ?? 0) > 0
        ? { status: "conflict", reason: "active_run_exists" }
        : { status: "conflict", reason: "lost_race" };
    }
    return { status: "claimed", task: (await this.getTask(input.task_id))! };
  }

  async claimOccurrenceSkipped(input: SkipOccurrenceInput): Promise<{ status: "skipped"; run: ScheduledTaskRun } | null> {
    const now = input.now;
    try {
      await this.store.batch([
        {
          sql: `INSERT INTO scheduled_task_runs
                (run_id, task_id, task_revision, trigger_source, scheduled_for, business_date, occurrence_key,
                 status, active_slot, snapshot_json, snapshot_sha256, context_json, error_code, error_message, created_at, updated_at)
                SELECT ?, t.task_id, t.revision, ?, ?, ?, ?, 'skipped', NULL, ?, ?, ?, ?, ?, ?, ?
                  FROM scheduled_tasks t
                 WHERE t.task_id = ?
                   AND t.revision = ?
                   AND t.lifecycle_status = 'active'
                   AND t.deleted_at IS NULL
                   AND t.approval_status != 'pending'
                   AND t.next_run_at = ?
                   ${input.requires_active_run === false ? "" : `AND EXISTS (
                     SELECT 1 FROM scheduled_task_runs active
                      WHERE active.task_id = t.task_id AND active.active_slot = 1
                   )`}`,
          params: [
            input.run_id, input.trigger_source, input.scheduled_for, input.business_date, input.occurrence_key,
            input.snapshot_json, input.snapshot_sha256, input.context_json ?? "{}",
            input.error_code ?? "OVERLAP_FORBIDDEN", input.error_message ?? "concurrency policy forbids parallel runs",
            now, now,
            input.task_id, input.expected_revision, input.expected_next_run_at,
          ],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_tasks
                  SET next_run_at = ?, last_scheduled_at = ?, last_run_id = ?,
                      lifecycle_status = CASE WHEN ? = 1 THEN 'completed' ELSE lifecycle_status END,
                      updated_at = ?
                WHERE task_id = ? AND revision = ? AND lifecycle_status = 'active' AND deleted_at IS NULL AND next_run_at = ?`,
          params: [
            input.next_run_at, input.scheduled_for, input.run_id,
            input.completes_once ? 1 : 0, now,
            input.task_id, input.expected_revision, input.expected_next_run_at,
          ],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return null;
      throw error;
    }
    return { status: "skipped", run: (await this.getRun(input.run_id))! };
  }

  /** docs §8.4 — manual runs never touch the automatic next_run_at. */
  async createManualRun(taskId: string, nowMs: number, options: { context_json?: string } = {}): Promise<ManualRunResult> {
    const task = await this.requireLiveTaskRow(taskId);
    const runId = newId("srun");
    const attemptId = newId("satt");
    // docs §9.11: every Attempt gets its deterministic Execution id at creation,
    // manual runs included, so evidence reconciliation stays uniform.
    const executionId = executionIdFor("scheduled-task-attempt", attemptId);
    const snapshot = buildSnapshotFromTask(toTaskDto(task), nowMs);
    const snapshotJson = JSON.stringify(snapshot);
    const contextJson = options.context_json ?? "{}";
    const businessDate = businessDateFor(nowMs, snapshot.schedule.timezone);
    const occurrenceKey = `${taskId}:manual:${attemptId}`;
    try {
      await this.store.batch([
        manualRunInsert(taskId, runId, occurrenceKey, businessDate, snapshotJson, sha256(snapshotJson), contextJson, nowMs),
        {
          sql: `INSERT INTO scheduled_task_run_attempts
                (attempt_id, run_id, attempt_no, status, active_slot, available_at, execution_id, created_at, updated_at)
                SELECT ?, r.run_id, 1, 'pending', 1, ?, ?, ?, ?
                  FROM scheduled_task_runs r
                 WHERE r.run_id = ? AND r.status = 'pending'`,
          params: [attemptId, nowMs, executionId, nowMs, nowMs, runId],
          expectChanges: 1,
        },
        {
          sql: "UPDATE scheduled_task_runs SET latest_attempt_id = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE run_id = ? AND status = 'pending'",
          params: [attemptId, nowMs, runId],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      // Active run exists → terminal skipped Run with the same 202 semantics.
      if (!isExpectChangesFailure(error)) throw error;
      const skippedRunId = newId("srun");
      await this.store.batch([{
        sql: `INSERT INTO scheduled_task_runs
              (run_id, task_id, task_revision, trigger_source, scheduled_for, business_date, occurrence_key,
               status, active_slot, snapshot_json, snapshot_sha256, context_json, error_code, error_message, created_at, updated_at)
              SELECT ?, t.task_id, t.revision, 'manual', ?, ?, ?, 'skipped', NULL, ?, ?, ?, 'OVERLAP_FORBIDDEN', 'an active run exists', ?, ?
                FROM scheduled_tasks t
               WHERE t.task_id = ? AND t.deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM scheduled_task_runs active WHERE active.task_id = t.task_id AND active.active_slot = 1)`,
        params: [skippedRunId, nowMs, businessDate, `${taskId}:manual:${skippedRunId}`, snapshotJson, sha256(snapshotJson), contextJson, nowMs, nowMs, taskId],
        expectChanges: 1,
      }]);
      return { status: "skipped", run: (await this.getRun(skippedRunId))!, attempt: null };
    }
    return {
      status: "created",
      run: (await this.getRun(runId))!,
      attempt: (await this.getAttempt(attemptId))!,
    };
  }

  // --- attempt leasing (docs §8.5–§8.6) --------------------------------------

  async claimAttempt(attemptId: string, ownerInstanceId: string, nowMs: number, leaseMs: number): Promise<AttemptLease | null> {
    const ownerToken = newToken();
    const leaseExpiresAt = nowMs + Math.max(1, Math.floor(leaseMs));
    try {
      await this.store.batch([
        {
          sql: `UPDATE scheduled_task_run_attempts
                  SET status = 'running', owner_instance_id = ?, owner_token = ?, owner_generation = owner_generation + 1,
                      heartbeat_at = ?, lease_expires_at = ?,
                      started_at = COALESCE(started_at, ?), execution_started_at = COALESCE(execution_started_at, ?), updated_at = ?
                WHERE attempt_id = ? AND status = 'pending' AND available_at <= ?`,
          params: [ownerInstanceId, ownerToken, nowMs, leaseExpiresAt, nowMs, nowMs, nowMs, attemptId, nowMs],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_task_runs
                  SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
                WHERE run_id = (SELECT run_id FROM scheduled_task_run_attempts WHERE attempt_id = ?)
                  AND status = 'pending' AND active_slot = 1`,
          params: [nowMs, nowMs, attemptId],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return null;
      throw error;
    }
    const row = await this.attemptRow(attemptId);
    if (!row) return null;
    return { attempt_id: attemptId, run_id: row.run_id, owner_instance_id: ownerInstanceId, owner_token: ownerToken, owner_generation: Number(row.owner_generation), lease_expires_at: leaseExpiresAt };
  }

  /** Owner-fenced lease extension; returns false when the owner lost the lease. */
  async heartbeatAttempt(attemptId: string, ownerToken: string, ownerGeneration: number, nowMs: number, leaseMs: number): Promise<boolean> {
    try {
      await this.store.batch([{
        sql: `UPDATE scheduled_task_run_attempts
                SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
              WHERE attempt_id = ? AND status = 'running' AND owner_token = ? AND owner_generation = ?`,
        params: [nowMs, nowMs + Math.max(1, Math.floor(leaseMs)), nowMs, attemptId, ownerToken, ownerGeneration],
        expectChanges: 1,
      }]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return false;
      throw error;
    }
    return true;
  }

  /** Owner-fenced terminal write for the attempt plus its run summary in one
   * transaction; returns null (stale owner) when either assertion misses. */
  async finishAttempt(attemptId: string, ownerToken: string, ownerGeneration: number, terminal: FinishAttemptTerminal, nowMs: number): Promise<ScheduledTaskRunAttempt | null> {
    const outputPathsJson = JSON.stringify(terminal.output_paths ?? []);
    const usageJson = JSON.stringify(terminal.usage ?? {});
    const runRow = await this.store.get<Pick<RunRow, "snapshot_json">>(
      "SELECT r.snapshot_json FROM scheduled_task_runs r JOIN scheduled_task_run_attempts a ON a.run_id = r.run_id WHERE a.attempt_id = ?",
      [attemptId],
    );
    const snapshot = runRow ? parseJson<ScheduledTaskSnapshot>(runRow.snapshot_json, undefined as never) : null;
    const outcome = terminal.outcome ?? (terminal.status === "succeeded" ? "completed" : "needs_attention");
    const summary = terminal.summary ?? {};
    const delivery = snapshot ? deliveryFor(snapshot.delivery_policy, terminal.status, outcome, terminal.recommend_notify) : null;
    try {
      await this.store.batch([
        {
          sql: `UPDATE scheduled_task_run_attempts
                  SET status = ?, active_slot = NULL, ended_at = ?, execution_finished_at = ?, output_paths_json = ?, usage_json = ?,
                      error_code = ?, error_message = ?, retryable = ?, updated_at = ?
                WHERE attempt_id = ? AND status = 'running' AND owner_token = ? AND owner_generation = ?`,
          params: [
            terminal.status, nowMs, nowMs, outputPathsJson, usageJson,
            terminal.error_code ?? null, terminal.error_message ?? null, boolParam(terminal.retryable), nowMs,
            attemptId, ownerToken, ownerGeneration,
          ],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_task_runs
                  SET status = ?, outcome = ?, summary_json = ?, delivery_json = ?, output_paths_json = ?, error_code = ?, error_message = ?,
                      ended_at = ?, active_slot = NULL, updated_at = ?
                WHERE run_id = (SELECT run_id FROM scheduled_task_run_attempts WHERE attempt_id = ?)
                  AND status IN ('pending', 'running') AND active_slot = 1`,
          params: [terminal.status, outcome, JSON.stringify(summary), JSON.stringify(delivery ?? {}), outputPathsJson, terminal.error_code ?? null, terminal.error_message ?? null, nowMs, nowMs, attemptId],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return null;
      throw error;
    }
    return this.getAttempt(attemptId);
  }

  /** Cancel a pending attempt outright, or record cancel_requested_at on a
   * running one; the dispatcher performs the fenced terminal write later. */
  async requestCancel(runId: string, nowMs: number): Promise<"cancelled" | "requested" | null> {
    const attempt = await this.store.get<AttemptRow>(
      "SELECT * FROM scheduled_task_run_attempts WHERE run_id = ? AND active_slot = 1",
      [runId],
    );
    if (!attempt) return null;
    if (attempt.status === "pending") {
      await this.store.batch([
        {
          sql: `UPDATE scheduled_task_run_attempts
                  SET status = 'cancelled', active_slot = NULL, ended_at = ?, error_code = COALESCE(error_code, 'CANCELLED'), updated_at = ?
                WHERE attempt_id = ? AND status = 'pending' AND active_slot = 1`,
          params: [nowMs, nowMs, attempt.attempt_id],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_task_runs
                  SET status = 'cancelled', active_slot = NULL, ended_at = ?, error_code = COALESCE(error_code, 'CANCELLED'), updated_at = ?
                WHERE run_id = ? AND status = 'pending' AND active_slot = 1`,
          params: [nowMs, nowMs, runId],
          expectChanges: 1,
        },
      ]);
      return "cancelled";
    }
    const result = await this.store.batch([
      {
        sql: `UPDATE scheduled_task_run_attempts
                SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
              WHERE attempt_id = ? AND status = 'running' AND active_slot = 1`,
        params: [nowMs, nowMs, attempt.attempt_id],
      },
    ]);
    return Number(result[0]?.changes ?? 0) === 1 ? "requested" : null;
  }

  /** docs §4.3/§8.8 retry: the old attempt must already be terminal; a fresh
   * pending attempt joins the same run and the run returns to pending.
   * UNIQUE(run_id, attempt_no) is the final guard against double retries. */
  async insertRetryAttempt(runId: string, oldAttemptId: string, plan: RetryAttemptPlan, nowMs: number): Promise<ScheduledTaskRunAttempt> {
    const newAttemptId = plan.attempt_id ?? newId("satt");
    await this.store.batch([
      {
        sql: `INSERT INTO scheduled_task_run_attempts
              (attempt_id, run_id, attempt_no, status, active_slot, available_at, execution_id, recovery_of_attempt_id, created_at, updated_at)
              SELECT ?, old.run_id, old.attempt_no + 1, 'pending', 1, ?, ?, old.attempt_id, ?, ?
                FROM scheduled_task_run_attempts old
               WHERE old.attempt_id = ? AND old.run_id = ? AND old.status NOT IN ('pending', 'running')`,
        params: [newAttemptId, plan.available_at, plan.execution_id, nowMs, nowMs, oldAttemptId, runId],
        expectChanges: 1,
      },
      {
        sql: `UPDATE scheduled_task_runs
                SET status = 'pending', outcome = NULL, summary_json = '{}', delivery_json = '{}',
                    active_slot = 1, latest_attempt_id = ?, attempt_count = attempt_count + 1, ended_at = NULL, updated_at = ?
              WHERE run_id = ? AND active_slot IS NULL AND status NOT IN ('pending', 'running')
                AND NOT EXISTS (
                  SELECT 1 FROM scheduled_task_runs other
                   WHERE other.task_id = scheduled_task_runs.task_id
                     AND other.run_id != scheduled_task_runs.run_id
                     AND other.active_slot = 1
                )`,
        params: [newAttemptId, nowMs, runId],
        expectChanges: 1,
      },
    ]);
    return (await this.getAttempt(newAttemptId))!;
  }

  // --- lease expiry recovery (docs §8.8) --------------------------------------

  /** Recovers every running attempt whose lease expired at or before nowMs.
   * `planRetry` decides per attempt whether a fresh pending attempt is
   * inserted; returning null (or omitting the callback) ends the run
   * `interrupted`. Attempts with cancel_requested_at always end `cancelled`. */
  async recoverExpiredLeases(
    nowMs: number,
    planRetry?: (expired: ExpiredAttemptView) => RetryDecision | null | Promise<RetryDecision | null>,
  ): Promise<LeaseRecoveryOutcome[]> {
    const rows = await this.store.all<ExpiredLeaseRow>(
      `SELECT a.attempt_id, a.run_id, a.attempt_no, a.cancel_requested_at, a.execution_id,
              r.task_id, t.project_id, t.workspace_path, t.retry_json
         FROM scheduled_task_run_attempts a
         JOIN scheduled_task_runs r ON r.run_id = a.run_id
         JOIN scheduled_tasks t ON t.task_id = r.task_id
        WHERE a.status = 'running' AND a.active_slot = 1 AND a.lease_expires_at IS NOT NULL AND a.lease_expires_at <= ?
        ORDER BY a.lease_expires_at, a.attempt_id`,
      [nowMs],
    );
    const outcomes: LeaseRecoveryOutcome[] = [];
    for (const row of rows) {
      const base = {
        attempt_id: row.attempt_id,
        new_attempt_id: null,
        run_id: row.run_id,
        task_id: row.task_id,
        execution_id: row.execution_id,
        workspace_path: row.workspace_path,
      };
      if (row.cancel_requested_at !== null) {
        if (!await this.recoverCancelled(row.attempt_id, row.run_id, nowMs)) continue;
        outcomes.push({ ...base, outcome: "cancelled" });
        continue;
      }
      const retry = parseJson<RetryPolicy>(row.retry_json, undefined as never);
      const decision = planRetry ? await Promise.resolve(planRetry({
        attempt_id: row.attempt_id,
        run_id: row.run_id,
        task_id: row.task_id,
        project_id: row.project_id,
        workspace_path: row.workspace_path,
        execution_id: row.execution_id,
        attempt_no: Number(row.attempt_no),
        cancel_requested: false,
        retry,
      })) : null;
      const canRetry = decision !== null && decision !== undefined && Number(row.attempt_no) < (retry.max_attempts ?? 1);
      if (canRetry) {
        const newAttemptId = newId("satt");
        if (!await this.recoverWithRetry(row.attempt_id, row.run_id, newAttemptId, decision!, nowMs)) continue;
        outcomes.push({ ...base, outcome: "retried", new_attempt_id: newAttemptId });
        continue;
      }
      if (!await this.recoverInterrupted(row.attempt_id, row.run_id, nowMs)) continue;
      outcomes.push({ ...base, outcome: "interrupted" });
    }
    return outcomes;
  }

  private async recoverCancelled(attemptId: string, runId: string, nowMs: number): Promise<boolean> {
    try {
      await this.store.batch([
        {
          sql: `UPDATE scheduled_task_run_attempts
                  SET status = 'cancelled', active_slot = NULL, ended_at = ?, execution_finished_at = COALESCE(execution_finished_at, ?),
                      error_code = COALESCE(error_code, 'CANCELLED'), updated_at = ?
                WHERE attempt_id = ? AND status = 'running'`,
          params: [nowMs, nowMs, nowMs, attemptId],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_task_runs
                  SET status = 'cancelled', active_slot = NULL, ended_at = COALESCE(ended_at, ?), error_code = COALESCE(error_code, 'CANCELLED'), updated_at = ?
                WHERE run_id = ? AND status = 'running' AND active_slot = 1`,
          params: [nowMs, nowMs, runId],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return false;
      throw error;
    }
    return true;
  }

  private async recoverInterrupted(attemptId: string, runId: string, nowMs: number): Promise<boolean> {
    try {
      await this.store.batch([
        {
          // Interrupted attempts keep their owner token/generation/lease as evidence.
          sql: "UPDATE scheduled_task_run_attempts SET status = 'interrupted', active_slot = NULL, updated_at = ? WHERE attempt_id = ? AND status = 'running'",
          params: [nowMs, attemptId],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_task_runs
                  SET status = 'interrupted', outcome = 'needs_attention',
                      summary_json = '{"title":"This task needs your attention","text":"The run was interrupted after its worker lease expired."}',
                      delivery_json = json_object('policy', COALESCE(json_extract(snapshot_json, '$.delivery_policy'), 'only_when_relevant'), 'delivered', json('true')),
                      active_slot = NULL, ended_at = COALESCE(ended_at, ?), updated_at = ?
                WHERE run_id = ? AND status = 'running' AND active_slot = 1`,
          params: [nowMs, nowMs, runId],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return false;
      throw error;
    }
    return true;
  }

  private async recoverWithRetry(attemptId: string, runId: string, newAttemptId: string, decision: RetryDecision, nowMs: number): Promise<boolean> {
    try {
      await this.store.batch([
        {
          sql: "UPDATE scheduled_task_run_attempts SET status = 'interrupted', active_slot = NULL, updated_at = ? WHERE attempt_id = ? AND status = 'running'",
          params: [nowMs, attemptId],
          expectChanges: 1,
        },
        {
          sql: `INSERT INTO scheduled_task_run_attempts
                (attempt_id, run_id, attempt_no, status, active_slot, available_at, execution_id, recovery_of_attempt_id, created_at, updated_at)
                SELECT ?, a.run_id, a.attempt_no + 1, 'pending', 1, ?, ?, a.attempt_id, ?, ?
                  FROM scheduled_task_run_attempts a
                 WHERE a.attempt_id = ?`,
          params: [newAttemptId, decision.available_at, decision.execution_id, nowMs, nowMs, attemptId],
          expectChanges: 1,
        },
        {
          sql: `UPDATE scheduled_task_runs
                  SET status = 'pending', outcome = NULL, summary_json = '{}', delivery_json = '{}',
                      active_slot = 1, latest_attempt_id = ?, attempt_count = attempt_count + 1, ended_at = NULL, updated_at = ?
                WHERE run_id = ? AND status = 'running' AND active_slot = 1`,
          params: [newAttemptId, nowMs, runId],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return false;
      throw error;
    }
    return true;
  }

  // --- scheduler / dispatcher queries (docs §11.3, §7.6) ---------------------

  /** Due tasks for the occurrence claim batch: active, not approval-pending,
   * not deleted, next_run_at <= nowMs. Ordered by due time then id for stable
   * claim order across processes. */
  async listDueTasks(nowMs: number, limit = 50): Promise<ScheduledTask[]> {
    const rows = await this.store.all<TaskRow>(
      `SELECT * FROM scheduled_tasks
        WHERE deleted_at IS NULL AND lifecycle_status = 'active'
          AND approval_status != 'pending' AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at, task_id
        LIMIT ?`,
      [nowMs, Math.max(1, Math.floor(limit))],
    );
    return rows.map(toTaskDto);
  }

  /** Durable pending-attempt outbox (docs §7.6): status='pending' AND
   * available_at <= availableAt, oldest first, bounded by limit. */
  async listPendingAttempts(availableAtMs: number, limit = 50): Promise<ScheduledTaskRunAttempt[]> {
    const rows = await this.store.all<AttemptRow>(
      `SELECT * FROM scheduled_task_run_attempts
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY available_at, attempt_id
        LIMIT ?`,
      [availableAtMs, Math.max(1, Math.floor(limit))],
    );
    return rows.map(toAttemptDto);
  }

  /** Currently running attempts (lease diagnostics / shutdown settle checks). */
  async listActiveAttempts(limit = 100): Promise<ScheduledTaskRunAttempt[]> {
    const rows = await this.store.all<AttemptRow>(
      "SELECT * FROM scheduled_task_run_attempts WHERE status = 'running' ORDER BY started_at, attempt_id LIMIT ?",
      [Math.max(1, Math.floor(limit))],
    );
    return rows.map(toAttemptDto);
  }

  /** docs §9.3 initial approval gate: only flips a matching revision + scope
   * hash task to 'pending' and clears next_run_at (a pending task must never
   * be armed). Returns false when any assertion missed. */
  async touchTaskApprovalPending(
    taskId: string,
    expectedRevision: number,
    expectedScopeHash: string,
    options: { categories?: string[]; terms?: string[]; now?: number } = {},
  ): Promise<boolean> {
    try {
      await this.store.batch([{
        sql: `UPDATE scheduled_tasks
                SET approval_status = 'pending', approval_categories_json = ?, approval_terms_json = ?,
                    approval_updated_at = ?, next_run_at = NULL, updated_at = ?
              WHERE task_id = ? AND revision = ? AND approval_scope_hash = ?
                AND deleted_at IS NULL AND lifecycle_status = 'active' AND approval_status = 'none'`,
        params: [
          JSON.stringify(options.categories ?? []), JSON.stringify(options.terms ?? []),
          options.now ?? Date.now(), options.now ?? Date.now(),
          taskId, expectedRevision, expectedScopeHash,
        ],
        expectChanges: 1,
      }]);
    } catch (error) {
      if (isExpectChangesFailure(error)) return false;
      throw error;
    }
    return true;
  }

  // --- deadlines and histories -----------------------------------------------

  /** Earliest of: due task next_run_at, pending attempt available_at, running
   * attempt lease_expires_at (docs §11.3 timer input). */
  async nearestDeadline(): Promise<number | null> {
    const row = await this.store.get<{ deadline: number | null }>(
      `SELECT MIN(deadline) AS deadline FROM (
         SELECT next_run_at AS deadline FROM scheduled_tasks
          WHERE deleted_at IS NULL AND lifecycle_status = 'active' AND approval_status != 'pending' AND next_run_at IS NOT NULL
         UNION ALL
         SELECT available_at AS deadline FROM scheduled_task_run_attempts WHERE status = 'pending'
         UNION ALL
         SELECT lease_expires_at AS deadline FROM scheduled_task_run_attempts WHERE status = 'running' AND lease_expires_at IS NOT NULL
       )`,
    );
    return row?.deadline === null || row?.deadline === undefined ? null : Number(row.deadline);
  }

  async getRun(runId: string): Promise<ScheduledTaskRun | null> {
    const row = await this.store.get<RunRow>("SELECT * FROM scheduled_task_runs WHERE run_id = ?", [runId]);
    return row ? toRunDto(row) : null;
  }

  async listRuns(taskId: string, options: { limit?: number; cursor?: string | null } = {}): Promise<Page<ScheduledTaskRun>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeRunCursor(options.cursor);
    const params: SqlValue[] = [taskId];
    let cursorPredicate = "";
    if (cursor) {
      cursorPredicate = "AND (scheduled_for < ? OR (scheduled_for = ? AND run_id < ?))";
      params.push(cursor.s, cursor.s, cursor.r);
    }
    params.push(limit + 1);
    const rows = await this.store.all<RunRow>(
      `SELECT * FROM scheduled_task_runs WHERE task_id = ? ${cursorPredicate}
       ORDER BY scheduled_for DESC, run_id DESC LIMIT ?`,
      params,
    );
    return page(rows, limit, (last) => encodeCursor({ s: last.scheduled_for, r: last.run_id }), toRunDto);
  }

  async getAttempt(attemptId: string): Promise<ScheduledTaskRunAttempt | null> {
    const row = await this.attemptRow(attemptId);
    return row ? toAttemptDto(row) : null;
  }

  async listAttempts(runId: string, options: { limit?: number; cursor?: string | null } = {}): Promise<Page<ScheduledTaskRunAttempt>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeAttemptCursor(options.cursor);
    const params: SqlValue[] = [runId];
    let cursorPredicate = "";
    if (cursor) {
      cursorPredicate = "AND attempt_no < ?";
      params.push(cursor.n);
    }
    params.push(limit + 1);
    const rows = await this.store.all<AttemptRow>(
      `SELECT * FROM scheduled_task_run_attempts WHERE run_id = ? ${cursorPredicate}
       ORDER BY attempt_no DESC LIMIT ?`,
      params,
    );
    return page(rows, limit, (last) => encodeCursor({ n: Number(last.attempt_no) }), toAttemptDto);
  }

  /** Most recent succeeded Run with a succeeded Attempt — the delta baseline
   * source for the literature digest executor (docs §9.8). beforeRunId excludes
   * one Run (typically the just-finished current Run) so an attempt never
   * becomes its own baseline. The directory layout matches the executor's
   * [relative_root, task_id, business_date, run_id, attempt_id] scheme; file
   * reads and hash verification stay outside SQL in the production loader. */
  async getPreviousSuccessfulAttempt(taskId: string, beforeRunId?: string): Promise<PreviousSuccessfulAttemptInfo | null> {
    const row = await this.store.get<PreviousSuccessfulAttemptRow>(
      `SELECT r.run_id, a.attempt_id, r.business_date, r.snapshot_json, t.workspace_path
         FROM scheduled_task_runs r
         JOIN scheduled_task_run_attempts a ON a.run_id = r.run_id AND a.status = 'succeeded'
         JOIN scheduled_tasks t ON t.task_id = r.task_id
        WHERE r.task_id = ? AND r.status = 'succeeded' ${beforeRunId ? "AND r.run_id != ?" : ""}
        ORDER BY r.created_at DESC, r.run_id DESC, a.attempt_no DESC
        LIMIT 1`,
      beforeRunId ? [taskId, beforeRunId] : [taskId],
    );
    if (!row) return null;
    const snapshot = parseJson<ScheduledTaskSnapshot>(row.snapshot_json, undefined as never);
    return {
      task_id: taskId,
      run_id: row.run_id,
      attempt_id: row.attempt_id,
      workspace_path: row.workspace_path,
      output_dir_relative: [snapshot.output.relative_root, snapshot.task_id, row.business_date, row.run_id, row.attempt_id].join("/"),
    };
  }

  /** Keeps the scheduled_tasks FK satisfied for project ids created outside
   * SQLite (ensureProject manifest fallback path in the service). */
  async ensureProjectRow(projectId: string, name: string, now: number): Promise<void> {
    await this.store.batch([
      { sql: `INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING`, params: [projectId, name, now, now, now] },
    ]);
  }

  /** Policy-limit counter: live (non-completed, non-deleted) tasks bound to a workspace. */
  async countActiveTasksByWorkspace(workspacePath: string): Promise<number> {    const row = await this.store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scheduled_tasks WHERE workspace_path = ? AND deleted_at IS NULL AND lifecycle_status != 'completed'",
      [workspacePath],
    );
    return Number(row?.count ?? 0);
  }

  // --- internals --------------------------------------------------------------

  private async taskRow(taskId: string): Promise<TaskRow | null> {
    return this.store.get<TaskRow>("SELECT * FROM scheduled_tasks WHERE task_id = ?", [taskId]);
  }

  private async attemptRow(attemptId: string): Promise<AttemptRow | null> {
    return this.store.get<AttemptRow>("SELECT * FROM scheduled_task_run_attempts WHERE attempt_id = ?", [attemptId]);
  }

  private async requireLiveTaskRow(taskId: string, expectedRevision?: number): Promise<TaskRow> {
    const row = await this.taskRow(taskId);
    if (!row || row.deleted_at !== null) throw taskNotFound(taskId);
    if (expectedRevision !== undefined && Number(row.revision) !== expectedRevision) {
      throw revisionConflict(taskId, expectedRevision, Number(row.revision));
    }
    return row;
  }

  private async classifyCasFailure(taskId: string, expectedRevision: number): Promise<never> {
    const fresh = await this.taskRow(taskId);
    if (!fresh || fresh.deleted_at !== null) throw taskNotFound(taskId);
    throw revisionConflict(taskId, expectedRevision, Number(fresh.revision));
  }
}

// ---------------------------------------------------------------------------
// Row shapes and conversions
// ---------------------------------------------------------------------------

interface TaskRow {
  task_id: string;
  project_id: string;
  workspace_path: string;
  schema_version: number;
  revision: number;
  name: string;
  display_json: string;
  origin_json: string;
  delivery_policy: string;
  lifecycle_status: string;
  deleted_at: number | null;
  schedule_json: string;
  executor_kind: string;
  config_json: string;
  output_json: string;
  approval_status: string;
  approval_scope_hash: string;
  approval_revision: number | null;
  approval_categories_json: string;
  approval_terms_json: string;
  approval_updated_at: number | null;
  retry_json: string;
  budget_json: string;
  misfire_policy: string;
  concurrency_policy: string;
  next_run_at: number | null;
  last_scheduled_at: number | null;
  last_run_id: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  run_id: string;
  task_id: string;
  task_revision: number;
  trigger_source: string;
  scheduled_for: number;
  business_date: string;
  occurrence_key: string;
  status: string;
  outcome: string | null;
  summary_json: string;
  delivery_json: string;
  active_slot: number | null;
  snapshot_json: string;
  snapshot_sha256: string;
  latest_attempt_id: string | null;
  attempt_count: number;
  output_paths_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface AttemptRow {
  attempt_id: string;
  run_id: string;
  attempt_no: number;
  status: string;
  active_slot: number | null;
  available_at: number;
  execution_id: string;
  execution_started_at: number | null;
  execution_finished_at: number | null;
  owner_instance_id: string | null;
  owner_token: string | null;
  owner_generation: number;
  heartbeat_at: number | null;
  lease_expires_at: number | null;
  cancel_requested_at: number | null;
  recovery_of_attempt_id: string | null;
  output_paths_json: string;
  usage_json: string;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
}

interface ListTasksRow extends Pick<TaskRow, "task_id" | "revision" | "name" | "display_json" | "delivery_policy" | "lifecycle_status" | "schedule_json" | "approval_status" | "next_run_at" | "created_at"> {
  lr_run_id: string | null;
  lr_status: string | null;
  lr_outcome: string | null;
  lr_summary_json: string | null;
  lr_delivery_json: string | null;
  lr_scheduled_for: number | null;
  lr_ended_at: number | null;
  lr_latest_attempt_id: string | null;
  lr_execution_id: string | null;
}

interface ExpiredLeaseRow {
  attempt_id: string;
  run_id: string;
  attempt_no: number;
  cancel_requested_at: number | null;
  execution_id: string;
  task_id: string;
  project_id: string;
  workspace_path: string;
  retry_json: string;
}

interface PreviousSuccessfulAttemptRow {
  run_id: string;
  attempt_id: string;
  business_date: string;
  snapshot_json: string;
  workspace_path: string;
}

type ExecutorKind = ScheduledTaskExecutor["kind"];

function castExecutorKind(kind: string): ExecutorKind {
  return kind === "literature_digest" ? kind : "literature_digest";
}

function toTaskDto(row: TaskRow): ScheduledTask {
  const executor: ScheduledTaskExecutor = { kind: castExecutorKind(row.executor_kind), config: parseJson(row.config_json, undefined as never) };
  return {
    task_id: row.task_id,
    project_id: row.project_id,
    workspace_path: row.workspace_path,
    schema_version: 1,
    revision: Number(row.revision),
    name: row.name,
    display: parseJson<ScheduledTaskDisplay>(row.display_json, {}),
    origin: parseJson<ScheduledTaskOrigin>(row.origin_json, {}),
    delivery_policy: row.delivery_policy as ScheduledTaskDeliveryPolicy,
    lifecycle_status: row.lifecycle_status as ScheduledTaskLifecycleStatus,
    schedule: parseJson<ScheduledTaskSchedule>(row.schedule_json, undefined as never),
    executor,
    output: parseJson<{ relative_root: string }>(row.output_json, undefined as never),
    approval: {
      status: row.approval_status as ScheduledTask["approval"]["status"],
      scope_hash: row.approval_scope_hash,
      approved_revision: row.approval_revision === null ? null : Number(row.approval_revision),
      categories: parseJson<string[]>(row.approval_categories_json, []),
      terms: parseJson<string[]>(row.approval_terms_json, []),
      approved_at: iso(row.approval_updated_at),
    },
    retry: parseJson<RetryPolicy>(row.retry_json, undefined as never),
    budget: parseJson<ScheduledTaskBudget>(row.budget_json, undefined as never),
    misfire_policy: row.misfire_policy as MisfirePolicy,
    concurrency_policy: row.concurrency_policy as ConcurrencyPolicy,
    next_run_at: iso(row.next_run_at),
    last_scheduled_at: iso(row.last_scheduled_at),
    last_run_id: row.last_run_id,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    deleted_at: iso(row.deleted_at),
  };
}

function toTaskListSummary(row: ListTasksRow): TaskListSummary {
  return {
    task_id: row.task_id,
    revision: Number(row.revision),
    name: row.name,
    display: parseJson<ScheduledTaskDisplay>(row.display_json, {}),
    delivery_policy: row.delivery_policy as ScheduledTaskDeliveryPolicy,
    lifecycle_status: row.lifecycle_status as ScheduledTaskLifecycleStatus,
    schedule: parseJson<ScheduledTaskSchedule>(row.schedule_json, undefined as never),
    approval_status: row.approval_status as TaskListSummary["approval_status"],
    next_run_at: iso(row.next_run_at),
    latest_run: row.lr_run_id === null ? null : {
      run_id: row.lr_run_id,
      status: String(row.lr_status) as ScheduledTaskRunStatus,
      outcome: row.lr_outcome as ScheduledTaskRunOutcome | null,
      summary: parseJson<ScheduledTaskRunSummary>(row.lr_summary_json ?? "{}", {}),
      delivery: parseDelivery(row.lr_delivery_json),
      scheduled_for: iso(row.lr_scheduled_for)!,
      ended_at: iso(row.lr_ended_at),
      latest_attempt_id: row.lr_latest_attempt_id,
      execution_id: row.lr_execution_id,
    },
  };
}

function toRunDto(row: RunRow): ScheduledTaskRun {
  return {
    run_id: row.run_id,
    task_id: row.task_id,
    task_revision: Number(row.task_revision),
    trigger_source: row.trigger_source as ScheduledTaskRun["trigger_source"],
    scheduled_for: iso(row.scheduled_for)!,
    business_date: row.business_date,
    occurrence_key: row.occurrence_key,
    status: row.status as ScheduledTaskRunStatus,
    outcome: row.outcome as ScheduledTaskRunOutcome | null,
    summary: parseJson<ScheduledTaskRunSummary>(row.summary_json, {}),
    delivery: parseDelivery(row.delivery_json),
    snapshot: parseJson<ScheduledTaskSnapshot>(row.snapshot_json, undefined as never),
    snapshot_sha256: row.snapshot_sha256,
    latest_attempt_id: row.latest_attempt_id,
    attempt_count: Number(row.attempt_count),
    output_paths: parseJson<string[]>(row.output_paths_json, []),
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: iso(row.created_at)!,
    started_at: iso(row.started_at),
    ended_at: iso(row.ended_at),
  };
}

function toAttemptDto(row: AttemptRow): ScheduledTaskRunAttempt {
  return {
    attempt_id: row.attempt_id,
    run_id: row.run_id,
    attempt_no: Number(row.attempt_no),
    status: row.status as ScheduledTaskAttemptStatus,
    available_at: iso(row.available_at)!,
    execution_id: row.execution_id,
    owner_instance_id: row.owner_instance_id,
    owner_token: row.owner_token,
    owner_generation: Number(row.owner_generation),
    heartbeat_at: iso(row.heartbeat_at),
    lease_expires_at: iso(row.lease_expires_at),
    cancel_requested_at: iso(row.cancel_requested_at),
    recovery_of_attempt_id: row.recovery_of_attempt_id,
    output_paths: parseJson<string[]>(row.output_paths_json, []),
    usage: parseJson<Record<string, unknown>>(row.usage_json, {}),
    error_code: row.error_code,
    error_message: row.error_message,
    started_at: iso(row.started_at),
    ended_at: iso(row.ended_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

/** Claim-time copy of the current task row (docs §7.5) used for manual runs;
 * automatic occurrences receive their snapshot from the scheduler. */
function buildSnapshotFromTask(task: ScheduledTask, nowMs: number): ScheduledTaskSnapshot {
  return {
    schema_version: 1,
    task_id: task.task_id,
    project_id: task.project_id,
    workspace_path_at_claim: task.workspace_path,
    revision: task.revision,
    name: task.name,
    display: task.display,
    origin: task.origin,
    delivery_policy: task.delivery_policy,
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
    claimed_at: new Date(nowMs).toISOString(),
  };
}

function manualRunInsert(
  taskId: string,
  runId: string,
  occurrenceKey: string,
  businessDate: string,
  snapshotJson: string,
  snapshotSha256: string,
  contextJson: string,
  nowMs: number,
): SqlStatement {
  return {
    sql: `INSERT INTO scheduled_task_runs
          (run_id, task_id, task_revision, trigger_source, scheduled_for, business_date, occurrence_key,
           status, active_slot, snapshot_json, snapshot_sha256, context_json, created_at, updated_at)
          SELECT ?, t.task_id, t.revision, 'manual', ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?
            FROM scheduled_tasks t
           WHERE t.task_id = ? AND t.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_task_runs active
                WHERE active.task_id = t.task_id AND active.active_slot = 1
             )`,
    params: [runId, nowMs, businessDate, occurrenceKey, snapshotJson, snapshotSha256, contextJson, nowMs, nowMs, taskId],
    expectChanges: 1,
  };
}

// ---------------------------------------------------------------------------
// Cursor, id and small helpers
// ---------------------------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function newToken(): string {
  return randomUUID().replaceAll("-", "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursorPayload(cursor: string | null | undefined): Record<string, unknown> | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor("pagination cursor is not decodable", {});
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidCursor("pagination cursor payload is not an object", {});
  return parsed as Record<string, unknown>;
}

function decodeTaskCursor(cursor: string | null | undefined): { c: number; t: string } | null {
  const payload = decodeCursorPayload(cursor);
  if (!payload) return null;
  const createdAt = payload.c;
  const taskIdValue = payload.t;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || typeof taskIdValue !== "string" || !taskIdValue) {
    throw invalidCursor("task cursor must encode {c: created_at, t: task_id}", {});
  }
  return { c: createdAt, t: taskIdValue };
}

function decodeRunCursor(cursor: string | null | undefined): { s: number; r: string } | null {
  const payload = decodeCursorPayload(cursor);
  if (!payload) return null;
  const scheduledFor = payload.s;
  const runIdValue = payload.r;
  if (typeof scheduledFor !== "number" || !Number.isSafeInteger(scheduledFor) || typeof runIdValue !== "string" || !runIdValue) {
    throw invalidCursor("run cursor must encode {s: scheduled_for, r: run_id}", {});
  }
  return { s: scheduledFor, r: runIdValue };
}

function decodeAttemptCursor(cursor: string | null | undefined): { n: number } | null {
  const payload = decodeCursorPayload(cursor);
  if (!payload) return null;
  const attemptNo = payload.n;
  if (typeof attemptNo !== "number" || !Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    throw invalidCursor("attempt cursor must encode {n: attempt_no}", {});
  }
  return { n: attemptNo };
}

function clampLimit(limit: number | undefined): number {
  const value = Math.floor(limit ?? DEFAULT_LIST_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, value));
}

function page<Row, Dto>(rows: Row[], limit: number, encode: (last: Row) => string, convert: (row: Row) => Dto): Page<Dto> {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(convert);
  return {
    items,
    next_cursor: hasMore && rows.length > 0 ? encode(rows[Math.min(limit, rows.length) - 1]!) : null,
  };
}

function iso(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(Number(value)).toISOString();
}

function deliveryFor(
  policy: ScheduledTaskDeliveryPolicy,
  status: FinishAttemptTerminal["status"],
  outcome: ScheduledTaskRunOutcome,
  recommendNotify?: boolean,
): ScheduledTaskRun["delivery"] {
  const failed = status !== "succeeded";
  const relevant = recommendNotify ?? (outcome === "new_information" || outcome === "threshold_triggered" || outcome === "needs_attention");
  const changed = outcome === "new_information" || outcome === "threshold_triggered";
  const delivered = policy === "always" || (policy === "only_on_failure" ? failed : policy === "only_on_change" ? changed : relevant);
  return {
    policy,
    delivered,
    ...(delivered ? {} : { suppressed_reason: outcome === "no_change" ? "no_meaningful_change" : failed ? "policy_excludes_failure" : "policy_suppressed" }),
  };
}

function boolParam(value: boolean | null | undefined): SqlValue {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

function parseDelivery(value: string | null | undefined): ScheduledTaskRun["delivery"] {
  if (!value) return null;
  const parsed = parseJson<Record<string, unknown>>(value, {});
  return typeof parsed.policy === "string" && typeof parsed.delivered === "boolean"
    ? parsed as unknown as NonNullable<ScheduledTaskRun["delivery"]>
    : null;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isExpectChangesFailure(error: unknown): error is SqliteStateError {
  return error instanceof SqliteStateError && error.code === "SQLITE_EXPECT_CHANGES";
}
