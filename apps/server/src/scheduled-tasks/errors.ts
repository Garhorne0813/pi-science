// Error codes for scheduled tasks, subset of the docs §12.7 table needed by
// Phase 2 (schedule validation, parser, approval). Later phases extend the
// union — never reuse a code for a different scenario.
export type ScheduledTaskErrorCode =
  | "INVALID_SCHEDULE"
  | "INVALID_TIMEZONE"
  | "INVALID_EXECUTOR_CONFIG"
  | "SCHEDULED_TASK_POLICY_VIOLATION";

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
