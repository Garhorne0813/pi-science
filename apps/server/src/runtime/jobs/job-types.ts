export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface JobRequirement {
  cpu?: number;
  memory_mb?: number;
  gpu?: boolean;
  runtime?: string;
  packages?: string[];
  timeout_seconds?: number;
  [key: string]: unknown;
}

export type JobProcessIdentity = { kind: "linux-proc-start-ticks"; value: string };
export type JobOwnerProcessIdentity = { kind: "linux-proc-start-ticks" | "ps-lstart-utc"; platform: NodeJS.Platform; value: string };

export interface JobChildIdentity {
  pid: number;
  process_identity: JobProcessIdentity | null;
  process_group: boolean;
  platform: NodeJS.Platform;
  ownership_generation: number;
  ownership_token: string;
}

export interface JobOwnership {
  instance_id: string;
  pid: number;
  process_started_at: string;
  process_identity?: JobOwnerProcessIdentity;
  generation: number;
  token: string;
  heartbeat_at: string;
  lease_expires_at: string;
  child?: JobChildIdentity;
}

export interface JobRecord {
  job_id: string;
  execution_id?: string;
  command: string[];
  cwd: string;
  execution_cwd?: string;
  surface: string;
  status: JobStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  return_code?: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  artifact_ids: string[];
  environment: Record<string, unknown>;
  requirement: JobRequirement;
  ownership?: JobOwnership;
}

export type PublicJobRecord = Omit<JobRecord, "ownership">;

/**
 * Job lifecycle transitions are deliberately kept in one module. Persistence
 * adapters may still enforce the same transitions atomically, but callers can
 * validate an in-memory transition without knowing which adapter is active.
 */
export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  pending: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function isTerminal(status: JobStatus): boolean {
  return JOB_STATUS_TRANSITIONS[status].length === 0;
}

export function isNonterminal(status: JobStatus): boolean {
  return !isTerminal(status);
}

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
  return from === to || JOB_STATUS_TRANSITIONS[from].includes(to);
}

export function transitionJobStatus(record: JobRecord, status: JobStatus): JobRecord {
  if (!canTransitionJobStatus(record.status, status)) {
    throw new Error(`invalid job status transition: ${record.status} -> ${status}`);
  }
  return { ...record, status };
}

export function publicJobRecord(record: JobRecord): PublicJobRecord {
  const { ownership: _ownership, ...publicRecord } = record;
  return publicRecord;
}
