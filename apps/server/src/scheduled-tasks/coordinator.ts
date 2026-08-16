import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import {
  scheduledTaskApproveRequestSchema,
  scheduledTaskCreateSchema,
  scheduledTaskPreviewRequestSchema,
  scheduledTaskUpdateSchema,
  type ScheduledTask,
  type ScheduledTaskApproval,
  type ScheduledTaskPreview,
  type ScheduledTaskRun,
  type ScheduledTaskRunTrigger,
} from "@pi-science/contracts";
import { recordEgress } from "../security/egress-audit.js";
import { detectSensitiveTerms, type SensitiveTermResult } from "../security/sensitive-terms.js";
import { resolveWorkspaceFile } from "../security/workspace-security.js";
import { registry, type ExecutorKind, type ScheduledTaskExecutor } from "./executors.js";
import { ScheduledTaskRepository } from "./repository.js";

/** A run failure that must never be retried: sensitive-content block, invalid
 *  schedule, output path escaping the workspace, missing executor, missing
 *  approval. Failed runs carry a "[non-retryable]" error prefix. */
export class ScheduledTaskNonRetryableError extends Error {}

export class ScheduledTaskCoordinator {
  private readonly cwd: string;
  private readonly repository: ScheduledTaskRepository;
  private readonly executors: Partial<Record<ExecutorKind, ScheduledTaskExecutor>>;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly inFlight = new Map<string, Promise<ScheduledTaskRun>>();
  private readonly taskLocks = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private closed = false;
  lastTickAt: number | null = null;

  constructor(options: {
    cwd: string;
    repository: ScheduledTaskRepository;
    executors?: Partial<Record<ExecutorKind, ScheduledTaskExecutor>>;
    now?: () => number;
    tickMs?: number;
  }) {
    this.cwd = options.cwd;
    this.repository = options.repository;
    this.executors = options.executors ?? registry;
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 30_000;
  }

  async create(input: unknown): Promise<ScheduledTask> {
    const parsed = scheduledTaskCreateSchema.parse(input);
    assertValidSchedule(parsed.schedule.cron, parsed.schedule.timezone);
    const nowIso = new Date(this.now()).toISOString();
    const task: ScheduledTask = {
      task_id: `task-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      schema_version: 1,
      revision: 0,
      name: parsed.name,
      type: parsed.type,
      enabled: parsed.enabled,
      schedule: { cron: parsed.schedule.cron, timezone: parsed.schedule.timezone },
      executor: { kind: "headless_agent", config: parsed.executor.config },
      output: { relative_path: parsed.output.relative_path },
      approval: approvalOf(sensitiveDetection(parsed.executor.config), contentHashOf(parsed.schedule.cron, parsed.executor.config, parsed.output.relative_path), 0, nowIso),
      retry: { max_attempts: parsed.retry.max_attempts },
      next_run_at: null,
      last_run_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (task.enabled && task.approval.status !== "pending") task.next_run_at = nextRunAtOf(task.schedule, this.now());
    await this.repository.saveTask(task);
    return task;
  }

  async update(taskId: string, input: unknown): Promise<ScheduledTask> {
    const task = await this.requireTask(taskId);
    const parsed = scheduledTaskUpdateSchema.parse(input);
    const merged: Pick<ScheduledTask, "name" | "type" | "enabled" | "schedule" | "executor" | "output" | "retry"> = {
      name: parsed.name ?? task.name,
      type: parsed.type ?? task.type,
      enabled: parsed.enabled ?? task.enabled,
      schedule: { cron: parsed.schedule?.cron ?? task.schedule.cron, timezone: parsed.schedule?.timezone ?? task.schedule.timezone },
      executor: { kind: "headless_agent", config: parsed.executor?.config ?? task.executor.config },
      output: { relative_path: parsed.output?.relative_path ?? task.output.relative_path },
      retry: { max_attempts: parsed.retry?.max_attempts ?? task.retry.max_attempts },
    };
    assertValidSchedule(merged.schedule.cron, merged.schedule.timezone);
    const nowIso = new Date(this.now()).toISOString();
    const revision = task.revision + 1;
    const contentHash = contentHashOf(merged.schedule.cron, merged.executor.config, merged.output.relative_path);
    // Approval binds to revision + content hash: content changed → invalidated
    // (re-derived from the fresh sensitive-term check), otherwise untouched.
    const approval = contentHash === task.approval.content_hash
      ? task.approval
      : approvalOf(sensitiveDetection(merged.executor.config), contentHash, revision, nowIso);
    const updated: ScheduledTask = {
      ...task,
      revision,
      name: merged.name,
      type: merged.type,
      enabled: merged.enabled,
      schedule: merged.schedule,
      executor: merged.executor,
      output: merged.output,
      retry: { max_attempts: merged.retry.max_attempts },
      approval,
      next_run_at: null,
      updated_at: nowIso,
    };
    if (updated.enabled && updated.approval.status !== "pending") updated.next_run_at = nextRunAtOf(updated.schedule, this.now());
    await this.repository.saveTask(updated);
    return updated;
  }

  async approve(taskId: string, input: unknown): Promise<ScheduledTask> {
    const task = await this.requireTask(taskId);
    if (task.approval.status !== "pending") throw new Error(`task approval is not pending: ${taskId}`);
    const parsed = scheduledTaskApproveRequestSchema.parse(input);
    const detection = sensitiveDetection(task.executor.config);
    const expected = [...detection.categories].sort();
    const provided = [...parsed.categories].sort();
    if (expected.length !== provided.length || expected.some((category, index) => category !== provided[index])) {
      throw new Error(`approval categories mismatch: expected [${expected.join(", ")}]`);
    }
    const nowIso = new Date(this.now()).toISOString();
    const updated: ScheduledTask = {
      ...task,
      approval: { ...task.approval, status: "approved", revision: task.revision, updated_at: nowIso },
      next_run_at: null,
      updated_at: nowIso,
    };
    if (updated.enabled) updated.next_run_at = nextRunAtOf(updated.schedule, this.now());
    await this.repository.saveTask(updated);
    await recordEgress({
      connector_type: "scheduled-task",
      connector_id: taskId,
      target_domain: "scheduled-task.approval",
      approved: true,
      note: `revision ${task.revision} categories ${detection.categories.join(",")}`,
    });
    return updated;
  }

  list(): Promise<ScheduledTask[]> { return this.repository.listTasks(); }

  get(taskId: string): Promise<ScheduledTask | null> { return this.repository.getTask(taskId); }

  /** Authoritative schedule preview for the task form: validates timezone and
   *  cron exactly like create/update, then returns the next 5 trigger instants
   *  from the same computation the scheduler uses (cron-parser, task timezone). */
  preview(input: unknown): ScheduledTaskPreview {
    const parsed = scheduledTaskPreviewRequestSchema.parse(input);
    if (!isValidTimezone(parsed.timezone)) return { valid: false, error: `无效时区: ${parsed.timezone}`, timezone: parsed.timezone, next_runs: [] };
    try {
      assertValidCron(parsed.cron);
      const expression = CronExpressionParser.parse(parsed.cron, { tz: parsed.timezone, currentDate: new Date(this.now()) });
      const nextRuns: string[] = [];
      for (let index = 0; index < 5; index += 1) nextRuns.push(expression.next().toDate().toISOString());
      return { valid: true, error: null, timezone: parsed.timezone, next_runs: nextRuns };
    } catch (error) {
      return { valid: false, error: `无效 cron 表达式: ${error instanceof Error ? error.message : String(error)}`, timezone: parsed.timezone, next_runs: [] };
    }
  }

  async delete(taskId: string): Promise<void> {
    await this.requireTask(taskId);
    await this.repository.deleteTask(taskId);
  }

  /** Unified manual/cron/reconcile entry point. Overlapping execution of the
   *  same task is forbidden: a trigger while another run is in flight records
   *  a `skipped` run. A pending approval records `needs_attention` and never
   *  reaches an executor. */
  async run(taskId: string, trigger: ScheduledTaskRunTrigger): Promise<ScheduledTaskRun> {
    const run = await this.withTaskLock(taskId, () => this.setupRun(taskId, trigger));
    if (run.status !== "pending") return run;
    return this.inFlight.get(taskId) ?? run;
  }

  private async setupRun(taskId: string, trigger: ScheduledTaskRunTrigger): Promise<ScheduledTaskRun> {
    const task = await this.requireTask(taskId);
    if (this.closed) throw new Error("scheduled task coordinator is shut down");
    const nowIso = new Date(this.now()).toISOString();
    const scheduledFor = trigger === "manual" ? nowIso : (task.next_run_at ?? nowIso);
    const idempotencyKey = `${taskId}:${scheduledFor}`;
    if (this.inFlight.has(taskId)) return this.finishSetup(task, this.newRun(task, trigger, scheduledFor, idempotencyKey, "skipped", nowIso, "a run for this task is already in progress"));
    const runs = await this.repository.listRuns(taskId, 50);
    const running = runs.find((run) => run.status === "running");
    if (running) return this.finishSetup(task, this.newRun(task, trigger, scheduledFor, idempotencyKey, "skipped", nowIso, `run ${running.run_id} is still recorded as running`));
    const already = runs.find((run) => run.idempotency_key === idempotencyKey && (run.status === "pending" || run.status === "running"));
    if (already) return this.finishSetup(task, this.newRun(task, trigger, scheduledFor, idempotencyKey, "skipped", nowIso, `run ${already.run_id} already covers ${scheduledFor}`));
    if (task.approval.status === "pending") {
      return this.finishSetup(task, this.newRun(task, trigger, scheduledFor, idempotencyKey, "needs_attention", nowIso, "approval pending; run not executed"));
    }
    const run = this.newRun(task, trigger, scheduledFor, idempotencyKey, "pending", nowIso, null);
    await this.repository.saveRun(run);
    const execution = this.executeRun(task, run).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, execution);
    return run;
  }

  private async finishSetup(task: ScheduledTask, run: ScheduledTaskRun): Promise<ScheduledTaskRun> {
    await this.repository.saveRun(run);
    await this.settleTask(task.task_id, run);
    return run;
  }

  private newRun(task: ScheduledTask, trigger: ScheduledTaskRunTrigger, scheduledFor: string, idempotencyKey: string, status: ScheduledTaskRun["status"], nowIso: string, error: string | null): ScheduledTaskRun {
    return {
      run_id: `run-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      task_id: task.task_id,
      scheduled_for: scheduledFor,
      trigger,
      idempotency_key: idempotencyKey,
      status,
      attempt: 0,
      execution_id: null,
      started_at: null,
      ended_at: status === "skipped" ? nowIso : null,
      output_paths: [],
      error,
      usage: { model_tokens: 0, cost_usd: 0 },
    };
  }

  private async executeRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<ScheduledTaskRun> {
    const ctx = { cwd: this.cwd, log: (line: string) => this.repository.appendLog(run.run_id, line) };
    let attempt = run.attempt;
    for (;;) {
      attempt += 1;
      const running: ScheduledTaskRun = { ...run, status: "running", attempt, started_at: new Date(this.now()).toISOString(), ended_at: null, error: null };
      try {
        await this.repository.saveRun(running);
        const executor = this.executors[task.executor.kind];
        if (!executor) throw new ScheduledTaskNonRetryableError(`no executor registered for executor kind "${task.executor.kind}"`);
        await this.assertOutputPath(task);
        const result = await executor.run(task, run.run_id, ctx);
        const succeeded: ScheduledTaskRun = {
          ...running,
          status: "succeeded",
          ended_at: new Date(this.now()).toISOString(),
          output_paths: result.output_paths,
          usage: { model_tokens: result.usage.model_tokens, cost_usd: result.usage.cost_usd },
        };
        await this.repository.saveRun(succeeded);
        await this.settleTask(task.task_id, succeeded);
        return succeeded;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof ScheduledTaskNonRetryableError) && attempt < task.retry.max_attempts) continue;
        const failed: ScheduledTaskRun = {
          ...running,
          status: "failed",
          ended_at: new Date(this.now()).toISOString(),
          error: `${error instanceof ScheduledTaskNonRetryableError ? "[non-retryable] " : ""}${message}`,
        };
        await this.repository.saveRun(failed);
        await this.settleTask(task.task_id, failed);
        return failed;
      }
    }
  }

  private async assertOutputPath(task: ScheduledTask): Promise<void> {
    try {
      await resolveWorkspaceFile(this.cwd, task.output.relative_path);
    } catch (error) {
      throw new ScheduledTaskNonRetryableError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Advances the task after a run outcome: last_run_at for executed runs,
   *  next_run_at recomputed past a consumed (or missed) trigger point. Reloads
   *  the task so an edit or delete during the run is never clobbered. */
  private async settleTask(taskId: string, run: ScheduledTaskRun): Promise<void> {
    const current = await this.repository.getTask(taskId);
    if (!current) return;
    const now = this.now();
    const schedulable = current.enabled && current.approval.status !== "pending";
    let nextRunAt = current.next_run_at;
    if (!schedulable) nextRunAt = null;
    else if (current.next_run_at === null || now >= Date.parse(current.next_run_at)) nextRunAt = nextRunAtOf(current.schedule, now);
    await this.repository.saveTask({
      ...current,
      ...(run.status === "succeeded" || run.status === "failed" ? { last_run_at: run.scheduled_for } : {}),
      next_run_at: nextRunAt,
      updated_at: new Date(now).toISOString(),
    });
  }

  /** Startup catch-up: each enabled task whose next_run_at is already due
   *  produces exactly one `reconcile` run for the missed point, then advances. */
  async reconcile(): Promise<void> {
    for (const task of await this.repository.listTasks()) {
      if (!task.enabled || task.approval.status === "pending" || !task.next_run_at) continue;
      if (this.now() >= Date.parse(task.next_run_at)) await this.run(task.task_id, "reconcile");
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const task of await this.repository.listTasks()) {
        if (!task.enabled || task.approval.status === "pending" || !task.next_run_at) continue;
        if (this.now() >= Date.parse(task.next_run_at)) await this.run(task.task_id, "cron");
      }
      // Crash recovery / retry of runs left pending or running by a dead process.
      for (const task of await this.repository.listTasks()) {
        await this.withTaskLock(task.task_id, async () => {
          if (this.inFlight.has(task.task_id)) return;
          const stale = (await this.repository.listRuns(task.task_id, 50)).find((run) => run.status === "pending" || run.status === "running");
          if (!stale) return;
          const execution = this.executeRun(task, stale).finally(() => this.inFlight.delete(task.task_id));
          this.inFlight.set(task.task_id, execution);
          await execution.catch(() => undefined);
        });
      }
      this.lastTickAt = this.now();
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (this.timer || this.closed) return;
    const timer = setInterval(() => {
      void this.tick().catch((error) => console.warn(`[scheduled-tasks] tick failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.tickMs);
    timer.unref();
    this.timer = timer;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async requireTask(taskId: string): Promise<ScheduledTask> {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new Error(`scheduled task not found: ${taskId}`);
    return task;
  }

  /** Serializes run setup per task: the in-flight check and the pending-run
   *  creation cannot interleave, so a concurrent trigger for the same task
   *  reliably sees the in-flight run and records `skipped`. */
  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    const gate = previous.then(operation, operation);
    this.taskLocks.set(taskId, gate.catch(() => undefined));
    await previous.catch(() => undefined);
    return gate;
  }
}

function sensitiveDetection(config: Record<string, unknown>): SensitiveTermResult {
  return detectSensitiveTerms(configStrings(config).join("\n"));
}

function approvalOf(detection: SensitiveTermResult, contentHash: string, revision: number, nowIso: string): ScheduledTaskApproval {
  return detection.matched
    ? { status: "pending", content_hash: contentHash, revision, categories: detection.categories, terms: detection.terms, updated_at: nowIso }
    : { status: "none", content_hash: contentHash, revision, categories: [], terms: [], updated_at: nowIso };
}

function configStrings(config: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value !== null && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };
  visit(config);
  return parts;
}

/** Content hash = sha256 over the stable JSON of {cron, executor config,
 *  output path}: approval binds to exactly what the executor will do. */
function contentHashOf(cron: string, config: Record<string, unknown>, relativePath: string): string {
  return createHash("sha256").update(stableStringify({ cron, config, relative_path: relativePath })).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Next occurrence strictly after `fromMs`; throws on a malformed schedule so
 *  create/update surface a 400 rather than failing at trigger time. */
function nextRunAtOf(schedule: { cron: string; timezone: string }, fromMs: number): string {
  assertValidSchedule(schedule.cron, schedule.timezone);
  return CronExpressionParser.parse(schedule.cron, { tz: schedule.timezone, currentDate: new Date(fromMs) }).next().toDate().toISOString();
}

function assertValidSchedule(cron: string, timezone: string): void {
  assertValidCron(cron);
  if (!isValidTimezone(timezone)) throw new Error(`invalid timezone: ${timezone}`);
}

/** cron-parser v5 silently accepts a 6-field seconds schedule and silently
 *  falls back to the local zone for an unknown tz, so both are checked
 *  explicitly before handing the expression to the parser. */
function assertValidCron(cron: string): void {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error(`invalid cron expression: expected 5 fields, got "${cron}"`);
  try { CronExpressionParser.parse(cron, { tz: "UTC" }); } catch (error) { throw new Error(`invalid cron expression: ${error instanceof Error ? error.message : String(error)}`); }
}

function isValidTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}
