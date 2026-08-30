// Scheduled Tasks client (docs/定时任务统一详细实现方案.md §12/§13). All HTTP
// shapes mirror the wire schemas that Phase 6 put into @pi-science/contracts
// plus the server DTOs in apps/server/src/scheduled-tasks/types.ts — frontend
// cannot import that workspace package yet, so these type-level mirrors must be
// kept in sync with it. The server stays authoritative: no local validation,
// preview or scheduling logic lives here.
import { apiRequest, ApiError } from "../client/api";
import { queryClient } from "../client/query-client";
import type { ExecutionRecord } from "../../types/thread";

// ── Wire DTO mirrors (@pi-science/contracts scheduled schemas) ──────────────

export type ScheduledLifecycleStatus = "active" | "paused" | "completed";
export type ScheduledRunStatus = "pending" | "skipped" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
export type ScheduledAttemptStatus = "pending" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
export type LiteratureProvider = "pubmed" | "genbank" | "arxiv" | "pubchem" | "uniprot";
export type MisfirePolicy = "coalesce_latest" | "skip";
export type DeliveryPolicy = "always" | "only_when_relevant" | "only_on_change" | "only_on_failure";
export type RunOutcome = "new_information" | "no_change" | "threshold_triggered" | "completed" | "needs_attention";
export interface TaskDisplay { title?: string; schedule_text?: string; action_summary?: string }
export interface TaskOrigin { session_id?: string; message_id?: string }
export interface RunSummary { title?: string; text?: string; item_count?: number }
export interface RunDelivery { policy: DeliveryPolicy; delivered: boolean; suppressed_reason?: string }

export const LITERATURE_PROVIDERS: LiteratureProvider[] = ["pubmed", "genbank", "arxiv", "pubchem", "uniprot"];

export interface ScheduledOnceSchedule { type: "once"; at: string; timezone: string }
export interface ScheduledIntervalSchedule { type: "interval"; every_seconds: number; anchor_at: string; timezone: string }
export interface ScheduledCronSchedule { type: "cron"; expression: string; timezone: string }
export type ScheduledSchedule = ScheduledOnceSchedule | ScheduledIntervalSchedule | ScheduledCronSchedule;

export interface LiteratureDigestConfig {
  query: string;
  providers: LiteratureProvider[];
  instructions?: string;
  max_results: number;
  language: "zh-CN" | "en";
}
export type ScheduledExecutor = { kind: "literature_digest"; config: LiteratureDigestConfig };
export interface RetryPolicy { max_attempts: number; initial_backoff_seconds: number; multiplier: number; max_backoff_seconds: number }
export type ScheduledBudget = { max_wall_time_seconds: number };

export interface ApprovalView {
  status: "none" | "pending" | "approved";
  scope_hash: string;
  approved_revision: number | null;
  categories: string[];
  terms: string[];
  approved_at: string | null;
}

/** Full task entity returned by GET/POST/PATCH/approve/pause/resume. */
export interface ScheduledTaskView {
  task_id: string;
  project_id: string;
  workspace_path: string;
  schema_version: 1;
  revision: number;
  name: string;
  display: TaskDisplay;
  origin: TaskOrigin;
  delivery_policy: DeliveryPolicy;
  lifecycle_status: ScheduledLifecycleStatus;
  schedule: ScheduledSchedule;
  executor: ScheduledExecutor;
  output: { relative_root: string };
  approval: ApprovalView;
  retry: RetryPolicy;
  budget: ScheduledBudget;
  misfire_policy: MisfirePolicy;
  concurrency_policy: "forbid";
  next_run_at: string | null;
  last_scheduled_at: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** docs §12.5 list summary — one SQL query per page, latest status included so
 * the initial render never needs a per-task request (§13.4 no N+1). */
export interface TaskListSummary {
  task_id: string;
  revision: number;
  name: string;
  display: TaskDisplay;
  delivery_policy: DeliveryPolicy;
  lifecycle_status: ScheduledLifecycleStatus;
  schedule: ScheduledSchedule;
  approval_status: "none" | "pending" | "approved";
  next_run_at: string | null;
  latest_run: null | {
    run_id: string;
    status: ScheduledRunStatus;
    outcome: RunOutcome | null;
    summary: RunSummary;
    delivery: RunDelivery | null;
    scheduled_for: string;
    ended_at: string | null;
    latest_attempt_id: string | null;
    execution_id: string | null;
  };
}

export interface ScheduledTaskRun {
  run_id: string;
  task_id: string;
  task_revision: number;
  trigger_source: "automatic" | "manual" | "reconcile";
  scheduled_for: string;
  business_date: string;
  occurrence_key: string;
  status: ScheduledRunStatus;
  outcome: RunOutcome | null;
  summary: RunSummary;
  delivery: RunDelivery | null;
  snapshot: { name: string; [key: string]: unknown };
  snapshot_sha256: string;
  latest_attempt_id: string | null;
  attempt_count: number;
  output_paths: string[];
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface ScheduledTaskAttempt {
  attempt_id: string;
  run_id: string;
  attempt_no: number;
  status: ScheduledAttemptStatus;
  available_at: string;
  execution_id: string;
  output_paths: string[];
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** docs §12.4 manual-run slice — the only run shape a 202 returns. */
export interface ManualRunView {
  run_id: string;
  task_id: string;
  status: ScheduledRunStatus;
  trigger_source: "manual";
  latest_attempt: null | { attempt_id: string; attempt_no: number; status: ScheduledAttemptStatus; execution_id: string };
}

export interface Page<T> { items: T[]; next_cursor: string | null }
export interface PreviewItem { utc: string; local: string }

/** GET /status — §11.7 diagnostics folded with sqlite_ready; never workspace data. */
export interface ScheduledTasksStatus {
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
  sqlite_ready?: boolean;
}

/** Narrow projection both full runs and manual-run 202 views map onto, so the
 * history table renders one shape. */
export interface RunRowView {
  run_id: string;
  status: ScheduledRunStatus;
  trigger_source: string;
  scheduled_for: string;
  business_date: string;
  attempt_count: number;
  error_code: string | null;
  output_paths: string[];
  outcome: RunOutcome | null;
  summary: RunSummary;
  delivery: RunDelivery | null;
}

export function toRunRow(run: ScheduledTaskRun): RunRowView {
  return { run_id: run.run_id, status: run.status, trigger_source: run.trigger_source, scheduled_for: run.scheduled_for, business_date: run.business_date, attempt_count: run.attempt_count, error_code: run.error_code, output_paths: run.output_paths, outcome: run.outcome, summary: run.summary, delivery: run.delivery };
}

/** Optimistic row for a 202 manual run — pending until the next poll confirms. */
export function manualRunToRow(view: ManualRunView): RunRowView {
  return { run_id: view.run_id, status: view.status, trigger_source: view.trigger_source, scheduled_for: new Date().toISOString(), business_date: new Date().toISOString().slice(0, 10), attempt_count: view.latest_attempt ? 1 : 0, error_code: null, output_paths: [], outcome: null, summary: {}, delivery: null };
}

// ── Client ───────────────────────────────────────────────────────────────────

const BASE = "/api/scheduled-tasks";

// Query string always goes last — path segments are appended to BASE first.
function qs(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
}

function collectionUrl(cwd: string, options: { limit?: number; cursor?: string | null } = {}): string {
  const params: Record<string, string | number> = { cwd };
  if (options.limit !== undefined) params.limit = options.limit;
  if (options.cursor) params.cursor = options.cursor;
  return `${BASE}?${qs(params)}`;
}

const taskPath = (taskId: string) => `${BASE}/${encodeURIComponent(taskId)}`;
const runPath = (taskId: string, runId: string) => `${taskPath(taskId)}/runs/${encodeURIComponent(runId)}`;

/** Uniform access to the §12.7 error code on a failed response. */
export function scheduledErrorCode(error: unknown): string | null {
  if (error instanceof ApiError && error.detail && typeof error.detail === "object" && "code" in error.detail) {
    return String((error.detail as { code: unknown }).code);
  }
  return null;
}

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export async function listScheduledTasks(cwd: string, options: { limit?: number; cursor?: string | null } = {}): Promise<Page<TaskListSummary>> {
  return apiRequest<Page<TaskListSummary>>(collectionUrl(cwd, options));
}

export async function getScheduledTask(taskId: string, cwd: string): Promise<ScheduledTaskView> {
  return apiRequest<ScheduledTaskView>(`${taskPath(taskId)}?${qs({ cwd })}`);
}

export interface CreateTaskBody {
  name: string;
  display?: TaskDisplay;
  origin?: TaskOrigin;
  delivery_policy?: DeliveryPolicy;
  schedule: ScheduledSchedule;
  executor: ScheduledExecutor;
  output: { relative_root: string };
  retry: RetryPolicy;
  budget: ScheduledBudget;
  misfire_policy: MisfirePolicy;
}

export async function createScheduledTask(cwd: string, body: CreateTaskBody): Promise<ScheduledTaskView> {
  return apiRequest<ScheduledTaskView>(`${BASE}?${qs({ cwd })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** PATCH carries { expected_revision, patch }; stale revisions answer 409. */
export async function patchScheduledTask(taskId: string, cwd: string, expectedRevision: number, patch: Partial<CreateTaskBody>): Promise<ScheduledTaskView> {
  return apiRequest<ScheduledTaskView>(`${taskPath(taskId)}?${qs({ cwd })}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: expectedRevision, patch }) });
}

async function postTaskAction(taskId: string, cwd: string, action: string, expectedRevision: number): Promise<ScheduledTaskView> {
  return apiRequest<ScheduledTaskView>(`${taskPath(taskId)}/${action}?${qs({ cwd })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: expectedRevision }) });
}

export const pauseScheduledTask = (taskId: string, cwd: string, expectedRevision: number) => postTaskAction(taskId, cwd, "pause", expectedRevision);
export const resumeScheduledTask = (taskId: string, cwd: string, expectedRevision: number) => postTaskAction(taskId, cwd, "resume", expectedRevision);

/** DELETE takes expected_revision via query string (docs §12 route table). */
export async function deleteScheduledTask(taskId: string, cwd: string, expectedRevision: number): Promise<unknown> {
  return apiRequest(`${taskPath(taskId)}?${qs({ cwd, expected_revision: expectedRevision })}`, { method: "DELETE" });
}

export async function approveScheduledTask(taskId: string, cwd: string, input: { expected_revision: number; approval_scope_hash: string; categories: string[] }): Promise<ScheduledTaskView> {
  return apiRequest<ScheduledTaskView>(`${taskPath(taskId)}/approve?${qs({ cwd })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

/** Manual run answers 202 Accepted with {run}; it never waits for execution. */
export async function runScheduledTaskNow(taskId: string, cwd: string): Promise<{ run: ManualRunView }> {
  return apiRequest<{ run: ManualRunView }>(`${taskPath(taskId)}/run?${qs({ cwd })}`, { method: "POST" });
}

export async function cancelScheduledRun(taskId: string, runId: string, cwd: string): Promise<{ run: ScheduledTaskRun }> {
  return apiRequest<{ run: ScheduledTaskRun }>(`${runPath(taskId, runId)}/cancel?${qs({ cwd })}`, { method: "POST" });
}

export async function retryScheduledRun(taskId: string, runId: string, cwd: string): Promise<{ attempt: ScheduledTaskAttempt }> {
  return apiRequest<{ attempt: ScheduledTaskAttempt }>(`${runPath(taskId, runId)}/retry?${qs({ cwd })}`, { method: "POST" });
}

export async function listScheduledRuns(taskId: string, cwd: string, options: { limit?: number; cursor?: string | null } = {}): Promise<Page<ScheduledTaskRun>> {
  const params: Record<string, string | number> = { cwd };
  if (options.limit !== undefined) params.limit = options.limit;
  if (options.cursor) params.cursor = options.cursor;
  return apiRequest<Page<ScheduledTaskRun>>(`${taskPath(taskId)}/runs?${qs(params)}`);
}

export async function getScheduledRun(taskId: string, runId: string, cwd: string): Promise<ScheduledTaskRun> {
  return apiRequest<ScheduledTaskRun>(`${runPath(taskId, runId)}?${qs({ cwd })}`);
}

export async function listScheduledAttempts(taskId: string, runId: string, cwd: string, options: { limit?: number; cursor?: string | null } = {}): Promise<Page<ScheduledTaskAttempt>> {
  const params: Record<string, string | number> = { cwd };
  if (options.limit !== undefined) params.limit = options.limit;
  if (options.cursor) params.cursor = options.cursor;
  return apiRequest<Page<ScheduledTaskAttempt>>(`${runPath(taskId, runId)}/attempts?${qs(params)}`);
}

export async function previewScheduledSchedule(cwd: string, schedule: ScheduledSchedule, count = 3): Promise<{ items: PreviewItem[] }> {
  return apiRequest<{ items: PreviewItem[] }>(`${BASE}/preview?${qs({ cwd })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schedule, count }) });
}

export async function scheduledTasksStatus(): Promise<ScheduledTasksStatus> {
  return apiRequest<ScheduledTasksStatus>(`${BASE}/status`);
}

// ── React Query wiring ───────────────────────────────────────────────────────

export const scheduledTasksKey = (...selector: (string | undefined)[]) => ["scheduled-tasks", ...selector];

export const scheduledTasksStatusQuery = () => ({
  queryKey: scheduledTasksKey("status"),
  queryFn: scheduledTasksStatus,
  staleTime: 30_000,
});

export const scheduledTasksQuery = (cwd: string) => ({
  queryKey: scheduledTasksKey(cwd),
  queryFn: () => listScheduledTasks(cwd),
  staleTime: 0,
});

/** Only mounted for an expanded task — this is the request §13.4 forbids before expansion. */
export const taskRunsQuery = (cwd: string, taskId: string) => ({
  queryKey: scheduledTasksKey(cwd, taskId, "runs"),
  queryFn: async () => {
    const page = await listScheduledRuns(taskId, cwd, { limit: 20 });
    return page.items.map(toRunRow);
  },
  enabled: false,
  staleTime: 0,
  refetchInterval: (query: { state: { data?: RunRowView[] } }) =>
    query.state.data?.some((row) => row.status === "pending" || row.status === "running") ? 5_000 : false,
});

export const taskDetailQuery = (cwd: string, taskId: string) => ({
  queryKey: scheduledTasksKey(cwd, taskId, "detail"),
  queryFn: () => getScheduledTask(taskId, cwd),
  enabled: false,
  staleTime: 0,
});

export const runAttemptsQuery = (cwd: string, taskId: string, runId: string | null) => ({
  queryKey: scheduledTasksKey(cwd, taskId, "runs", runId ?? "-", "attempts"),
  queryFn: async () => {
    if (!runId) return [];
    const page = await listScheduledAttempts(taskId, runId, cwd);
    return page.items;
  },
  enabled: Boolean(runId),
  staleTime: 0,
});

export function invalidateScheduledTasks(cwd: string, taskId?: string): void {
  void queryClient.invalidateQueries({ queryKey: scheduledTasksKey(cwd) });
  if (taskId) void queryClient.invalidateQueries({ queryKey: scheduledTasksKey(cwd, taskId) });
}

/** Deep link target shared with RunsPage: the execution ledger filtered to one execution. */
export function executionDeepLink(cwd: string, executionId: string): string {
  return `/workspace/${encodeURIComponent(cwd)}/runs?execution=${encodeURIComponent(executionId)}`;
}

/** True when a ledger record belongs to a scheduled task attempt. */
export function isScheduledExecution(run: Pick<ExecutionRecord, "kind">): boolean {
  return run.kind === "scheduled_task";
}

// ── Timezone picker (docs §13.2) ─────────────────────────────────────────────

/** Older engines lack Intl.supportedValuesOf — fall back to a builtin IANA list. */
export function timezoneOptions(): string[] {
  try {
    const supported = Intl.supportedValuesOf("timeZone");
    if (Array.isArray(supported) && supported.length > 0) return [...supported];
  } catch {
    // ignore and use the fallback below
  }
  return FALLBACK_TIMEZONES;
}

const FALLBACK_TIMEZONES = [
  "UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul", "Asia/Kolkata",
  "Asia/Dubai", "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Zurich", "Europe/Moscow",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
  "Australia/Sydney", "Pacific/Auckland",
];
