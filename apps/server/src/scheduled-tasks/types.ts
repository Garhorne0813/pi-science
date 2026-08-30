// Server-internal entity interfaces for scheduled tasks (docs §3.4, §4.2, §4.3,
// §7.5, §9.3). Wire-level schemas live in @pi-science/contracts; these types are
// never sent verbatim over HTTP. All time fields are UTC ISO 8601 strings.
import type {
  ConcurrencyPolicy,
  LiteratureProvider,
  MisfirePolicy,
  RetryPolicy,
  ScheduledTaskBudget,
  ScheduledTaskDeliveryPolicy,
  ScheduledTaskDisplay,
  ScheduledTaskExecutor,
  ScheduledTaskOrigin,
  ScheduledTaskRunDelivery,
  ScheduledTaskRunOutcome,
  ScheduledTaskRunSummary,
  ScheduledTaskSchedule,
} from "@pi-science/contracts";

export type ScheduledTaskLifecycleStatus = "active" | "paused" | "completed";

/** docs §4.2 — Run is a materialized summary owned by the repository. */
export type ScheduledTaskRunStatus =
  | "pending"
  | "skipped"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";

/** docs §4.3 — Attempts are never rewound to pending; retry inserts a new Attempt. */
export type ScheduledTaskAttemptStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";

export interface ScheduledTaskApprovalView {
  status: "none" | "pending" | "approved";
  scope_hash: string;
  approved_revision: number | null;
  categories: string[];
  terms: string[];
  approved_at: string | null;
}

/** docs §3.4 */
export interface ScheduledTask {
  task_id: string;
  project_id: string;
  /** Current canonical location; updated in-place on workspace move. */
  workspace_path: string;
  schema_version: 1;
  /** User-defined revision; scheduler advancement of next_run_at must not bump it. */
  revision: number;
  name: string;
  display: ScheduledTaskDisplay;
  origin: ScheduledTaskOrigin;
  delivery_policy: ScheduledTaskDeliveryPolicy;
  lifecycle_status: ScheduledTaskLifecycleStatus;
  schedule: ScheduledTaskSchedule;
  executor: ScheduledTaskExecutor;
  output: { relative_root: string };
  approval: ScheduledTaskApprovalView;
  retry: RetryPolicy;
  budget: ScheduledTaskBudget;
  misfire_policy: MisfirePolicy;
  concurrency_policy: ConcurrencyPolicy;
  next_run_at: string | null;
  last_scheduled_at: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Immutable claim-time copy persisted on every Run (docs §7.5). No secrets. */
export interface ScheduledTaskSnapshot {
  schema_version: 1;
  task_id: string;
  project_id: string;
  workspace_path_at_claim: string;
  revision: number;
  name: string;
  display: ScheduledTaskDisplay;
  origin: ScheduledTaskOrigin;
  delivery_policy: ScheduledTaskDeliveryPolicy;
  schedule: ScheduledTaskSchedule;
  executor: ScheduledTaskExecutor;
  output: { relative_root: string };
  approval: {
    status: "none" | "approved";
    scope_hash: string;
    approved_revision: number | null;
    categories: string[];
  };
  retry: RetryPolicy;
  budget: ScheduledTaskBudget;
  misfire_policy: MisfirePolicy;
  concurrency_policy: ConcurrencyPolicy;
  claimed_at: string;
}

/** docs §3.4 — one logical occurrence; immutable container for attempts. */
export interface ScheduledTaskRun {
  run_id: string;
  task_id: string;
  task_revision: number;
  trigger_source: "automatic" | "manual" | "reconcile";
  scheduled_for: string;
  /** YYYY-MM-DD in the task timezone at claim time (docs §5.6); frozen for retries. */
  business_date: string;
  occurrence_key: string;
  status: ScheduledTaskRunStatus;
  outcome: ScheduledTaskRunOutcome | null;
  summary: ScheduledTaskRunSummary;
  delivery: ScheduledTaskRunDelivery | null;
  snapshot: ScheduledTaskSnapshot;
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

/** docs §3.4 — one actual execution attempt against a Run's snapshot. */
export interface ScheduledTaskRunAttempt {
  attempt_id: string;
  run_id: string;
  attempt_no: number;
  status: ScheduledTaskAttemptStatus;
  available_at: string;
  execution_id: string;
  owner_instance_id: string | null;
  owner_token: string | null;
  owner_generation: number;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  recovery_of_attempt_id: string | null;
  output_paths: string[];
  usage: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

/** docs §9.3 — approval/egress correlation extension for scheduled literature runs. */
export interface LiteratureCorrelation {
  source: "scheduled_task";
  task_id: string;
  run_id: string;
  attempt_id: string;
  execution_id: string;
}

export type { LiteratureProvider, MisfirePolicy, RetryPolicy, ScheduledTaskExecutor, ScheduledTaskSchedule };
