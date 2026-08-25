import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JobOwnership, JobRecord, JobStatus } from "../../../runtime/jobs/job-coordinator.js";
import { metadataRoot } from "../../persistence.js";
import type { SqliteStateStore } from "../state-store.js";
import { WorkspaceRepository } from "./workspace-repository.js";

export class JobRepository {
  private readonly workspaces: WorkspaceRepository;

  constructor(private readonly store: SqliteStateStore, workspaces?: WorkspaceRepository) {
    this.workspaces = workspaces ?? new WorkspaceRepository(store);
  }

  async save(record: JobRecord): Promise<JobRecord> {
    const location = await this.workspaces.rememberWorkspace(record.cwd);
    await this.store.run(upsertSql(), jobParams(record, location.project_id, location.path));
    return (await this.get(record.cwd, record.job_id))!;
  }

  async get(cwd: string, jobId: string): Promise<JobRecord | null> {
    if (!/^job_[A-Za-z0-9]{16}$/.test(jobId)) throw new Error("Invalid job id");
    const location = await this.workspaces.getByPath(cwd);
    if (!location) return null;
    const row = await this.store.get<JobRow>(
      "SELECT * FROM jobs WHERE job_id = ? AND project_id = ? AND workspace_path = ?",
      [jobId, location.project_id, location.path],
    );
    return row ? toRecord(row, location.path) : null;
  }

  async getById(jobId: string): Promise<JobRecord | null> {
    const row = await this.store.get<JobRow>("SELECT * FROM jobs WHERE job_id = ?", [jobId]);
    return row ? toRecord(row) : null;
  }

  async list(cwd: string, limit: number): Promise<JobRecord[]> {
    const location = await this.workspaces.getByPath(cwd);
    if (!location) return [];
    const rows = await this.store.all<JobRow>(
      "SELECT * FROM jobs WHERE project_id = ? AND workspace_path = ? ORDER BY created_at DESC LIMIT ?",
      [location.project_id, location.path, Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(limit)))],
    );
    return rows.map((row) => toRecord(row, location.path));
  }

  async hasActive(cwd: string): Promise<boolean> {
    const location = await this.workspaces.getByPath(cwd);
    if (!location) return false;
    const row = await this.store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND workspace_path = ? AND status IN ('pending', 'running')",
      [location.project_id, location.path],
    );
    return Number(row?.count ?? 0) > 0;
  }

  locked<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    return this.store.serialized(`job:${jobId}`, operation);
  }

  async transitionToRunning(record: JobRecord, startedAt: number): Promise<JobRecord | null> {
    const ownership = record.ownership;
    const result = await this.store.run(
      `UPDATE jobs SET status = 'running', started_at = ?, updated_at = ?
        WHERE job_id = ? AND status = 'pending' AND owner_token IS ? AND owner_generation IS ?`,
      [startedAt, startedAt, record.job_id, ownership?.token ?? null, ownership?.generation ?? null],
    );
    if (Number(result.changes) === 0) return this.getById(record.job_id);
    return this.getById(record.job_id);
  }

  async heartbeat(record: JobRecord, ownership: JobOwnership, now: number): Promise<JobRecord | null> {
    const heartbeatAt = timestamp(ownership.heartbeat_at) ?? now;
    const leaseAt = timestamp(ownership.lease_expires_at) ?? now + 30_000;
    const leaseDuration = Math.max(100, leaseAt - heartbeatAt);
    const nextOwnership = { ...ownership, heartbeat_at: new Date(now).toISOString(), lease_expires_at: new Date(now + leaseDuration).toISOString() };
    const result = await this.store.run(
      `UPDATE jobs SET ownership_json = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('pending', 'running') AND owner_token = ? AND owner_generation = ?`,
      [JSON.stringify(nextOwnership), timestamp(nextOwnership.lease_expires_at), now, record.job_id, ownership.token, ownership.generation],
    );
    if (Number(result.changes) === 0) return this.getById(record.job_id);
    return this.getById(record.job_id);
  }

  async setChild(record: JobRecord, ownership: JobOwnership, now: number): Promise<JobRecord | null> {
    const result = await this.store.run(
      `UPDATE jobs SET ownership_json = ?, owner_token = ?, owner_generation = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('pending', 'running') AND owner_token = ? AND owner_generation = ?`,
      [JSON.stringify(ownership), ownership.token, ownership.generation, timestamp(ownership.lease_expires_at), now, record.job_id, ownership.token, ownership.generation],
    );
    return Number(result.changes) === 0 ? this.getById(record.job_id) : this.getById(record.job_id);
  }

  async cancel(cwd: string, jobId: string, endedAt: number, diagnostic?: string): Promise<JobRecord | null> {
    const location = await this.workspaces.getByPath(cwd);
    if (!location) return null;
    const result = await this.store.run(
      `UPDATE jobs SET status = 'cancelled', ended_at = ?, stderr = CASE WHEN ? IS NULL THEN stderr ELSE ? END, updated_at = ?
        WHERE job_id = ? AND project_id = ? AND workspace_path = ? AND status IN ('pending', 'running')`,
      [endedAt, diagnostic ?? null, diagnostic ?? null, endedAt, jobId, location.project_id, location.path],
    );
    if (Number(result.changes) === 0) return this.get(cwd, jobId);
    return this.get(cwd, jobId);
  }

  async heal(record: JobRecord, endedAt: number, diagnostic: string): Promise<JobRecord | null> {
    const ownerToken = record.ownership?.token ?? null;
    const ownerGeneration = record.ownership?.generation ?? null;
    const result = await this.store.run(
      `UPDATE jobs SET status = 'failed', return_code = NULL, ended_at = ?, stderr = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('pending', 'running') AND owner_token IS ? AND owner_generation IS ?`,
      [endedAt, record.stderr ? `${record.stderr}\n${diagnostic}` : diagnostic, endedAt, record.job_id, ownerToken, ownerGeneration],
    );
    return Number(result.changes) === 0 ? this.getById(record.job_id) : this.getById(record.job_id);
  }

  async saveTerminal(record: JobRecord, now: number): Promise<JobRecord | null> {
    const ownership = record.ownership;
    const result = await this.store.run(
      `UPDATE jobs SET status = ?, return_code = ?, stdout = ?, stderr = ?, stdout_truncated = ?, stderr_truncated = ?, ended_at = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('pending', 'running') AND owner_token = ? AND owner_generation = ?`,
      [record.status, record.return_code ?? null, record.stdout, record.stderr, record.stdout_truncated ? 1 : 0, record.stderr_truncated ? 1 : 0, timestamp(record.ended_at) ?? now, now, record.job_id, ownership?.token ?? null, ownership?.generation ?? null],
    );
    return Number(result.changes) === 0 ? this.getById(record.job_id) : this.getById(record.job_id);
  }

  async updateCancelledDiagnostic(record: JobRecord, now: number): Promise<JobRecord | null> {
    const current = await this.getById(record.job_id);
    if (!current || current.status !== "cancelled") return current;
    const stderr = mergeDiagnosticText(record.stderr, current.stderr);
    await this.store.run("UPDATE jobs SET stderr = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE job_id = ? AND status = 'cancelled'", [stderr, timestamp(record.ended_at) ?? now, now, record.job_id]);
    return this.getById(record.job_id);
  }

  async importLegacy(workspaces: readonly string[]): Promise<{ rows: number; skipped: number; errors: string[] }> {
    let rows = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const workspace of workspaces) {
      const dir = join(metadataRoot(workspace), "jobs");
      let names: string[];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const path = join(dir, name);
        let text: string;
        try { text = await readFile(path, "utf8"); } catch (error) { errors.push(`${path}: ${String(error)}`); continue; }
        const fingerprint = createHash("sha256").update(text).digest("hex");
        const source = `job:${resolve(path)}`;
        if (await importAlreadyApplied(this.store, source, fingerprint)) { skipped += 1; continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { errors.push(`${path}: invalid JSON`); await markImport(this.store, source, fingerprint, 0); continue; }
        const record = normalizeLegacyRecord(parsed, workspace);
        if (!record) { errors.push(`${path}: invalid job record`); await markImport(this.store, source, fingerprint, 0); continue; }
        try { await this.save(record); rows += 1; await markImport(this.store, source, fingerprint, 1); }
        catch (error) { errors.push(`${path}: ${String(error)}`); }
      }
    }
    return { rows, skipped, errors };
  }
}

interface JobRow {
  job_id: string;
  execution_id: string | null;
  project_id: string;
  workspace_path: string;
  execution_cwd: string | null;
  surface: string;
  command_json: string;
  status: JobStatus;
  requirement_json: string;
  environment_json: string;
  artifact_ids_json: string;
  stdout: string;
  stderr: string;
  stdout_truncated: number;
  stderr_truncated: number;
  return_code: number | null;
  ownership_json: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

function upsertSql(): string {
  return `INSERT INTO jobs
    (job_id, execution_id, project_id, workspace_path, execution_cwd, surface, command_json, status, requirement_json, environment_json, artifact_ids_json, stdout, stderr, stdout_truncated, stderr_truncated, return_code, ownership_json, owner_token, owner_generation, lease_expires_at, created_at, started_at, ended_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      execution_id = excluded.execution_id,
      project_id = excluded.project_id,
      workspace_path = excluded.workspace_path,
      execution_cwd = excluded.execution_cwd,
      surface = excluded.surface,
      command_json = excluded.command_json,
      status = excluded.status,
      requirement_json = excluded.requirement_json,
      environment_json = excluded.environment_json,
      artifact_ids_json = excluded.artifact_ids_json,
      stdout = excluded.stdout,
      stderr = excluded.stderr,
      stdout_truncated = excluded.stdout_truncated,
      stderr_truncated = excluded.stderr_truncated,
      return_code = excluded.return_code,
      ownership_json = excluded.ownership_json,
      owner_token = excluded.owner_token,
      owner_generation = excluded.owner_generation,
      lease_expires_at = excluded.lease_expires_at,
      created_at = excluded.created_at,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      updated_at = excluded.updated_at`;
}

function jobParams(record: JobRecord, projectId: string, workspacePath: string): Array<string | number | null> {
  const ownership = record.ownership;
  return [
    record.job_id,
    record.execution_id ?? null,
    projectId,
    workspacePath,
    record.execution_cwd ? resolve(record.execution_cwd) : null,
    record.surface,
    JSON.stringify(record.command),
    record.status,
    JSON.stringify(record.requirement),
    JSON.stringify(record.environment),
    JSON.stringify(record.artifact_ids),
    record.stdout,
    record.stderr,
    record.stdout_truncated ? 1 : 0,
    record.stderr_truncated ? 1 : 0,
    record.return_code ?? null,
    ownership ? JSON.stringify(ownership) : null,
    ownership?.token ?? null,
    ownership?.generation ?? null,
    ownership ? timestamp(ownership.lease_expires_at) : null,
    timestamp(record.created_at) ?? Date.now(),
    timestamp(record.started_at),
    timestamp(record.ended_at),
    Date.now(),
  ];
}

function toRecord(row: JobRow, workspacePath = row.workspace_path): JobRecord {
  const command = parseJson<unknown>(row.command_json, []);
  const requirement = parseJson<Record<string, unknown>>(row.requirement_json, {});
  const environment = parseJson<Record<string, unknown>>(row.environment_json, {});
  const artifactIds = parseJson<unknown>(row.artifact_ids_json, []);
  const ownership = parseJson<JobOwnership | null>(row.ownership_json, null);
  return {
    job_id: row.job_id,
    ...(row.execution_id ? { execution_id: row.execution_id } : {}),
    command: Array.isArray(command) ? command.map(String) : [],
    cwd: workspacePath,
    ...(row.execution_cwd ? { execution_cwd: row.execution_cwd } : {}),
    surface: row.surface,
    status: row.status,
    created_at: new Date(Number(row.created_at)).toISOString(),
    ...(row.started_at === null ? {} : { started_at: new Date(Number(row.started_at)).toISOString() }),
    ...(row.ended_at === null ? {} : { ended_at: new Date(Number(row.ended_at)).toISOString() }),
    return_code: row.return_code,
    stdout: row.stdout,
    stderr: row.stderr,
    stdout_truncated: row.stdout_truncated === 1,
    stderr_truncated: row.stderr_truncated === 1,
    artifact_ids: Array.isArray(artifactIds) ? artifactIds.map(String) : [],
    environment,
    requirement,
    ...(ownership ? { ownership } : {}),
  };
}

function normalizeLegacyRecord(value: unknown, workspace: string): JobRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.job_id !== "string" || !/^job_[A-Za-z0-9]{16}$/.test(row.job_id)) return null;
  const status = row.status;
  if (!["pending", "running", "succeeded", "failed", "cancelled", "timed_out"].includes(String(status))) return null;
  return {
    job_id: row.job_id,
    ...(typeof row.execution_id === "string" ? { execution_id: row.execution_id } : {}),
    command: Array.isArray(row.command) ? row.command.map(String) : [],
    cwd: resolve(workspace),
    ...(typeof row.execution_cwd === "string" ? { execution_cwd: resolve(row.execution_cwd) } : {}),
    surface: typeof row.surface === "string" ? row.surface : "local",
    status: status as JobStatus,
    created_at: typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
    ...(typeof row.started_at === "string" ? { started_at: row.started_at } : {}),
    ...(typeof row.ended_at === "string" ? { ended_at: row.ended_at } : {}),
    return_code: typeof row.return_code === "number" ? row.return_code : null,
    stdout: typeof row.stdout === "string" ? row.stdout : "",
    stderr: typeof row.stderr === "string" ? row.stderr : "",
    stdout_truncated: row.stdout_truncated === true,
    stderr_truncated: row.stderr_truncated === true,
    artifact_ids: Array.isArray(row.artifact_ids) ? row.artifact_ids.map(String) : [],
    environment: row.environment && typeof row.environment === "object" ? row.environment as Record<string, unknown> : {},
    requirement: row.requirement && typeof row.requirement === "object" ? row.requirement as JobRecord["requirement"] : {},
    ...(row.ownership && typeof row.ownership === "object" ? { ownership: row.ownership as JobOwnership } : {}),
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function timestamp(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function importAlreadyApplied(store: SqliteStateStore, source: string, fingerprint: string): Promise<boolean> {
  const row = await store.get<{ source_fingerprint: string }>("SELECT source_fingerprint FROM legacy_imports WHERE source = ?", [source]);
  return row?.source_fingerprint === fingerprint;
}

async function markImport(store: SqliteStateStore, source: string, fingerprint: string, rowCount: number): Promise<void> {
  await store.run(
    `INSERT INTO legacy_imports (source, source_fingerprint, imported_at, row_count) VALUES (?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET source_fingerprint = excluded.source_fingerprint, imported_at = excluded.imported_at, row_count = excluded.row_count`,
    [source, fingerprint, Date.now(), rowCount],
  );
}

function mergeDiagnosticText(runner: string, durable: string): string {
  if (!runner) return durable;
  if (!durable || runner === durable || runner.includes(durable)) return runner;
  if (durable.includes(runner)) return durable;
  return `${runner}\n${durable}`;
}
