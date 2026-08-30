// Error codes for scheduled tasks, subset of the docs §12.7 table needed by
// Phase 2 (schedule validation, parser, approval), Phase 3 (repository CAS,
// pagination, lifecycle transitions) and Phase 4 (service, scheduler,
// dispatcher). Later phases extend the union — never reuse a code for a
// different scenario.
export type ScheduledTaskErrorCode =
  | "INVALID_SCHEDULE"
  | "INVALID_TIMEZONE"
  | "INVALID_EXECUTOR_CONFIG"
  | "SCHEDULED_TASK_POLICY_VIOLATION"
  | "INVALID_CURSOR"
  | "SCHEDULED_TASK_NOT_FOUND"
  | "SCHEDULED_TASK_RUN_NOT_FOUND"
  | "SCHEDULED_TASK_REVISION_CONFLICT"
  | "SCHEDULED_TASK_APPROVAL_REQUIRED"
  | "SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED"
  | "TASK_HAS_ACTIVE_RUN"
  | "RUN_RETRY_NOT_ALLOWED"
  | "WORKSPACE_FORBIDDEN"
  | "OUTPUT_ROOT_FORBIDDEN"
  | "EXECUTOR_UNAVAILABLE"
  | "SCHEDULED_TASKS_DISABLED";

export class ScheduledTaskError extends Error {
  readonly code: ScheduledTaskErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ScheduledTaskErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ScheduledTaskError";
    this.code = code;
    this.details = details;
  }
}

export const invalidSchedule = (message: string, details: Record<string, unknown> = {}) =>
  new ScheduledTaskError("INVALID_SCHEDULE", message, details);

export const invalidTimezone = (timezone: string) =>
  new ScheduledTaskError("INVALID_TIMEZONE", `Invalid IANA timezone: ${timezone}`, { timezone });

export const invalidExecutorConfig = (message: string, details: Record<string, unknown> = {}) =>
  new ScheduledTaskError("INVALID_EXECUTOR_CONFIG", message, details);

export const policyViolation = (message: string, details: Record<string, unknown> = {}) =>
  new ScheduledTaskError("SCHEDULED_TASK_POLICY_VIOLATION", message, details);

export const invalidCursor = (message: string, details: Record<string, unknown> = {}) =>
  new ScheduledTaskError("INVALID_CURSOR", message, details);

export const taskNotFound = (taskId: string) =>
  new ScheduledTaskError("SCHEDULED_TASK_NOT_FOUND", `Scheduled task not found: ${taskId}`, { task_id: taskId });

export const revisionConflict = (taskId: string, expectedRevision: number, actualRevision: number) =>
  new ScheduledTaskError("SCHEDULED_TASK_REVISION_CONFLICT", "Scheduled task revision changed", { task_id: taskId, expected_revision: expectedRevision, actual_revision: actualRevision });

export const approvalRequired = (taskId: string) =>
  new ScheduledTaskError("SCHEDULED_TASK_APPROVAL_REQUIRED", "Scheduled task requires approval before resume", { task_id: taskId });

export const approvalScopeChanged = (taskId: string, scopeHash: string) =>
  new ScheduledTaskError("SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED", "Approval scope hash does not match the current task scope", { task_id: taskId, scope_hash: scopeHash });

export const taskHasActiveRun = (taskId: string) =>
  new ScheduledTaskError("TASK_HAS_ACTIVE_RUN", "Scheduled task still has an active run", { task_id: taskId });

export const runNotFound = (runId: string) =>
  new ScheduledTaskError("SCHEDULED_TASK_RUN_NOT_FOUND", `Scheduled task run not found: ${runId}`, { run_id: runId });

export const runRetryNotAllowed = (runId: string, reason: string) =>
  new ScheduledTaskError("RUN_RETRY_NOT_ALLOWED", `Run cannot be retried: ${reason}`, { run_id: runId });

export const workspaceForbidden = (workspacePath: string) =>
  new ScheduledTaskError("WORKSPACE_FORBIDDEN", `Path is not a registered workspace: ${workspacePath}`, { workspace_path: workspacePath });

export const outputRootForbidden = (relativeRoot: string, reason: string) =>
  new ScheduledTaskError("OUTPUT_ROOT_FORBIDDEN", `Output root is not allowed: ${reason}`, { relative_root: relativeRoot });

export const scheduledTasksDisabled = () =>
  new ScheduledTaskError("SCHEDULED_TASKS_DISABLED", "Scheduled tasks feature is disabled (PI_SCIENCE_SCHEDULED_TASKS != 1)", {});
