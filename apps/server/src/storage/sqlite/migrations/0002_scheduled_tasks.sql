CREATE TABLE scheduled_tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,

  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),

  name TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL
    CHECK (lifecycle_status IN ('active', 'paused', 'completed')),
  deleted_at INTEGER,

  schedule_json TEXT NOT NULL
    CHECK (
      json_valid(schedule_json)
      AND json_extract(schedule_json, '$.type') IN ('once', 'interval', 'cron')
    ),

  executor_kind TEXT NOT NULL
    CHECK (executor_kind IN ('literature_digest')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  output_json TEXT NOT NULL CHECK (json_valid(output_json)),

  approval_status TEXT NOT NULL
    CHECK (approval_status IN ('none', 'pending', 'approved')),
  approval_scope_hash TEXT NOT NULL,
  approval_revision INTEGER,
  approval_categories_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(approval_categories_json)),
  approval_terms_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(approval_terms_json)),
  approval_updated_at INTEGER,

  retry_json TEXT NOT NULL CHECK (json_valid(retry_json)),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),

  misfire_policy TEXT NOT NULL DEFAULT 'coalesce_latest'
    CHECK (misfire_policy IN ('coalesce_latest', 'skip')),
  concurrency_policy TEXT NOT NULL DEFAULT 'forbid'
    CHECK (concurrency_policy IN ('forbid')),

  next_run_at INTEGER,
  last_scheduled_at INTEGER,
  last_run_id TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK (deleted_at IS NULL OR next_run_at IS NULL),
  CHECK (lifecycle_status = 'active' OR next_run_at IS NULL),
  CHECK (approval_status != 'pending' OR next_run_at IS NULL),

  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX scheduled_tasks_due_idx
  ON scheduled_tasks(next_run_at, task_id)
  WHERE deleted_at IS NULL
    AND lifecycle_status = 'active'
    AND approval_status != 'pending'
    AND next_run_at IS NOT NULL;

CREATE INDEX scheduled_tasks_project_idx
  ON scheduled_tasks(project_id, created_at DESC, task_id)
  WHERE deleted_at IS NULL;

CREATE INDEX scheduled_tasks_workspace_idx
  ON scheduled_tasks(workspace_path, created_at DESC, task_id)
  WHERE deleted_at IS NULL;

CREATE TABLE scheduled_task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,

  trigger_source TEXT NOT NULL
    CHECK (trigger_source IN ('automatic', 'manual', 'reconcile')),
  scheduled_for INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  occurrence_key TEXT NOT NULL UNIQUE,

  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'running',
    'succeeded',
    'failed',
    'timed_out',
    'cancelled',
    'interrupted',
    'skipped'
  )),

  active_slot INTEGER CHECK (active_slot IS NULL OR active_slot = 1),

  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(context_json)),

  latest_attempt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  output_paths_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(output_paths_json)),

  error_code TEXT,
  error_message TEXT,

  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL,

  CHECK (
    (status IN ('pending', 'running') AND active_slot = 1)
    OR
    (status NOT IN ('pending', 'running') AND active_slot IS NULL)
  ),

  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(task_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX scheduled_task_runs_active_task_idx
  ON scheduled_task_runs(task_id, active_slot)
  WHERE active_slot = 1;

CREATE INDEX scheduled_task_runs_task_history_idx
  ON scheduled_task_runs(task_id, scheduled_for DESC, run_id DESC);

CREATE INDEX scheduled_task_runs_status_idx
  ON scheduled_task_runs(status, updated_at DESC);

CREATE TABLE scheduled_task_run_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),

  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'running',
    'succeeded',
    'failed',
    'timed_out',
    'cancelled',
    'interrupted'
  )),
  active_slot INTEGER CHECK (active_slot IS NULL OR active_slot = 1),
  available_at INTEGER NOT NULL,

  execution_id TEXT NOT NULL UNIQUE,
  execution_started_at INTEGER,
  execution_finished_at INTEGER,

  owner_instance_id TEXT,
  owner_token TEXT,
  owner_generation INTEGER NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),
  heartbeat_at INTEGER,
  lease_expires_at INTEGER,
  cancel_requested_at INTEGER,

  recovery_of_attempt_id TEXT,

  output_paths_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(output_paths_json)),
  usage_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(usage_json)),

  error_code TEXT,
  error_message TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),

  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL,

  UNIQUE (run_id, attempt_no),
  CHECK (
    (status IN ('pending', 'running') AND active_slot = 1)
    OR
    (status NOT IN ('pending', 'running') AND active_slot IS NULL)
  ),

  FOREIGN KEY (run_id) REFERENCES scheduled_task_runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (recovery_of_attempt_id)
    REFERENCES scheduled_task_run_attempts(attempt_id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX scheduled_task_attempts_active_run_idx
  ON scheduled_task_run_attempts(run_id, active_slot)
  WHERE active_slot = 1;

CREATE INDEX scheduled_task_attempts_outbox_idx
  ON scheduled_task_run_attempts(available_at, attempt_id)
  WHERE status = 'pending';

CREATE INDEX scheduled_task_attempts_lease_idx
  ON scheduled_task_run_attempts(lease_expires_at, attempt_id)
  WHERE status = 'running';

CREATE INDEX scheduled_task_attempts_run_history_idx
  ON scheduled_task_run_attempts(run_id, attempt_no DESC);
