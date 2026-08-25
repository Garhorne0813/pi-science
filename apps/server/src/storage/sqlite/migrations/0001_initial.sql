CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE project_locations (
  canonical_path TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  is_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_managed IN (0, 1)),
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  last_opened_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  missing_since INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX project_locations_project_idx
  ON project_locations(project_id);

CREATE INDEX project_locations_recent_idx
  ON project_locations(last_opened_at DESC)
  WHERE last_opened_at IS NOT NULL;

CREATE INDEX project_locations_pinned_idx
  ON project_locations(is_pinned, last_opened_at DESC)
  WHERE is_pinned = 1;

CREATE TABLE environment_revisions (
  revision_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('python', 'r')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed', 'archived')),
  prefix TEXT NOT NULL UNIQUE,
  packages_json TEXT NOT NULL CHECK (json_valid(packages_json)),
  platform TEXT NOT NULL,
  supersedes_revision_id TEXT,
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (supersedes_revision_id) REFERENCES environment_revisions(revision_id) ON DELETE SET NULL
) STRICT;

CREATE INDEX environment_revisions_environment_created_idx
  ON environment_revisions(environment_id, created_at DESC);

CREATE INDEX environment_revisions_status_idx
  ON environment_revisions(status, updated_at DESC);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  execution_id TEXT,
  project_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  execution_cwd TEXT,
  surface TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  requirement_json TEXT NOT NULL CHECK (json_valid(requirement_json)),
  environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
  artifact_ids_json TEXT NOT NULL CHECK (json_valid(artifact_ids_json)),
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  stdout_truncated INTEGER NOT NULL DEFAULT 0 CHECK (stdout_truncated IN (0, 1)),
  stderr_truncated INTEGER NOT NULL DEFAULT 0 CHECK (stderr_truncated IN (0, 1)),
  return_code INTEGER,
  ownership_json TEXT CHECK (ownership_json IS NULL OR json_valid(ownership_json)),
  owner_token TEXT,
  owner_generation INTEGER,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX jobs_project_created_idx
  ON jobs(project_id, created_at DESC);

CREATE INDEX jobs_workspace_created_idx
  ON jobs(workspace_path, created_at DESC);

CREATE INDEX jobs_active_lease_idx
  ON jobs(lease_expires_at)
  WHERE status IN ('pending', 'running');

CREATE UNIQUE INDEX jobs_execution_id_idx
  ON jobs(execution_id)
  WHERE execution_id IS NOT NULL;

CREATE TABLE legacy_imports (
  source TEXT PRIMARY KEY,
  source_fingerprint TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  row_count INTEGER NOT NULL
) STRICT;
