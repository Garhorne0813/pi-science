import { apiRequest } from "./client/api";
import { queryClient } from "./client/query-client";

/* ── Types (local mirror of the control-plane API; no server imports) ── */

export type ScheduledTaskType = "literature_digest";
export type ScheduledTaskTrigger = "cron" | "manual" | "reconcile";
export type ScheduledTaskRunStatus = "pending" | "running" | "succeeded" | "failed" | "needs_attention" | "skipped";
export type ScheduledTaskApprovalStatus = "none" | "pending" | "approved";

export interface ScheduledTask {
  task_id: string;
  schema_version: number;
  revision: number;
  name: string;
  type: ScheduledTaskType;
  enabled: boolean;
  schedule: { cron: string; timezone: string };
  executor: { kind: "headless_agent"; config: { query: string; providers?: string[]; instructions?: string } };
  output: { relative_path: string };
  approval: { status: ScheduledTaskApprovalStatus; content_hash: string | null; revision: number; categories: string[]; terms: string[]; updated_at: string | null };
  retry: { max_attempts: number };
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  run_id: string;
  task_id: string;
  scheduled_for: string;
  trigger: ScheduledTaskTrigger;
  idempotency_key: string;
  status: ScheduledTaskRunStatus;
  attempt: number;
  execution_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  output_paths: string[];
  error: string | null;
  usage: { model_tokens: number; cost_usd: number };
  /** Present on the single-run detail endpoint only. */
  log_tail?: string;
}

export interface ScheduledTaskCreateInput {
  name: string;
  type: ScheduledTaskType;
  schedule: { cron: string; timezone: string };
  executor: { kind: "headless_agent"; config: { query: string; providers?: string[]; instructions?: string } };
  output: { relative_path: string };
}

/** PATCH accepts the POST fields plus `enabled`; all fields are optional. */
export type ScheduledTaskUpdateInput = Partial<ScheduledTaskCreateInput & { enabled: boolean }>;

/** Server-authoritative cron preview (mirror of the contracts schema): the
 *  server validates the expression and computes the next runs in the task
 *  timezone, so the form preview matches the real scheduler. */
export interface ScheduledTaskPreview {
  valid: boolean;
  error: string | null;
  timezone: string;
  next_runs: string[];
}

/* ── Query keys ── */

export const scheduledTasksKey = (cwd: string) => ["scheduled-tasks", cwd];
export const scheduledTaskRunsKey = (cwd: string, taskId: string) => ["scheduled-tasks", cwd, taskId, "runs"];
export const scheduledTaskRunKey = (cwd: string, taskId: string, runId: string) => [...scheduledTaskRunsKey(cwd, taskId), runId];
export const scheduledTaskPreviewKey = (cwd: string) => ["scheduled-tasks", cwd, "preview"];

/** The task list carries no run status, so the "pending" signal is an imminent
 *  next trigger: poll fast while a run is about to fire, otherwise stay quiet. */
const tasksRefreshInterval = (query: { state: { data?: ScheduledTask[] } }) =>
  query.state.data?.some((task) => task.next_run_at && Date.parse(task.next_run_at) - Date.now() < 60_000) ? 5_000 : 30_000;

const runsRefreshInterval = (query: { state: { data?: ScheduledTaskRun[] | ScheduledTaskRun } }) => {
  const runs = Array.isArray(query.state.data) ? query.state.data : query.state.data ? [query.state.data] : [];
  return runs.some((run) => run.status === "pending" || run.status === "running") ? 5_000 : 30_000;
};

/* ── Queries ── */

export const scheduledTasksQuery = (cwd: string) => ({
  queryKey: scheduledTasksKey(cwd),
  queryFn: async () => {
    const data = await apiRequest<{ tasks?: ScheduledTask[] }>(`/api/scheduled-tasks?${new URLSearchParams({ cwd })}`);
    return data.tasks ?? [];
  },
  staleTime: 0,
  refetchInterval: tasksRefreshInterval,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});

export const scheduledTaskRunsQuery = (cwd: string, taskId: string) => ({
  queryKey: scheduledTaskRunsKey(cwd, taskId),
  queryFn: async () => {
    const data = await apiRequest<{ runs?: ScheduledTaskRun[] }>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs?${new URLSearchParams({ cwd })}`);
    return data.runs ?? [];
  },
  staleTime: 0,
  refetchInterval: runsRefreshInterval,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});

export const scheduledTaskRunQuery = (cwd: string, taskId: string, runId: string) => ({
  queryKey: scheduledTaskRunKey(cwd, taskId, runId),
  queryFn: () => apiRequest<ScheduledTaskRun>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}?${new URLSearchParams({ cwd })}`),
  staleTime: 0,
  refetchInterval: runsRefreshInterval,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});

/* ── Mutations (plain async writes; the cache is invalidated by key prefix,
 *     which also drops the per-task runs queries) ── */

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function createScheduledTask(cwd: string, input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
  const task = await apiRequest<ScheduledTask>(`/api/scheduled-tasks?${new URLSearchParams({ cwd })}`, jsonBody("POST", input));
  void queryClient.invalidateQueries({ queryKey: scheduledTasksKey(cwd) });
  return task;
}

export async function updateScheduledTask(cwd: string, taskId: string, patch: ScheduledTaskUpdateInput): Promise<ScheduledTask> {
  const task = await apiRequest<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}?${new URLSearchParams({ cwd })}`, jsonBody("PATCH", patch));
  void queryClient.invalidateQueries({ queryKey: scheduledTasksKey(cwd) });
  return task;
}

export async function deleteScheduledTask(cwd: string, taskId: string): Promise<void> {
  await apiRequest(`/api/scheduled-tasks/${encodeURIComponent(taskId)}?${new URLSearchParams({ cwd })}`, { method: "DELETE" });
  void queryClient.invalidateQueries({ queryKey: scheduledTasksKey(cwd) });
}

export async function runScheduledTask(cwd: string, taskId: string): Promise<ScheduledTaskRun> {
  const run = await apiRequest<ScheduledTaskRun>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/run?${new URLSearchParams({ cwd })}`, { method: "POST" });
  void queryClient.invalidateQueries({ queryKey: scheduledTasksKey(cwd) });
  return run;
}

/** Approve a sensitive-term task. The route requires the exact categories
 *  detected by the server, so callers must pass task.approval.categories.
 *  The default [] is only a convenience for callers without detection info. */
export async function approveScheduledTask(cwd: string, taskId: string, categories: string[] = []): Promise<ScheduledTask> {
  const task = await apiRequest<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(taskId)}/approve?${new URLSearchParams({ cwd })}`, jsonBody("POST", { categories }));
  void queryClient.invalidateQueries({ queryKey: scheduledTasksKey(cwd) });
  return task;
}

/** Server-side cron preview for the task form: the authoritative schedule
 *  computation (cron-parser, task timezone) behind the form's live preview. */
export async function previewCron(cwd: string, cron: string, timezone: string): Promise<ScheduledTaskPreview> {
  return apiRequest<ScheduledTaskPreview>(`/api/scheduled-tasks/preview?${new URLSearchParams({ cwd })}`, jsonBody("POST", { cron, timezone }));
}
