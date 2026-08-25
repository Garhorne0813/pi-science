import type { EnvironmentRevision, EnvironmentStatus, EnvironmentLanguage } from "../../../runtime/workspace/workspace-environment.js";
import type { SqliteStateStore } from "../state-store.js";

export class EnvironmentRepository {
  constructor(private readonly store: SqliteStateStore) {}

  async list(): Promise<EnvironmentRevision[]> {
    const rows = await this.store.all<EnvironmentRow>("SELECT * FROM environment_revisions ORDER BY created_at DESC");
    return rows.map(toRevision);
  }

  async get(revisionId: string): Promise<EnvironmentRevision | null> {
    const row = await this.store.get<EnvironmentRow>("SELECT * FROM environment_revisions WHERE revision_id = ?", [revisionId]);
    return row ? toRevision(row) : null;
  }

  async findReady(revisionId: string): Promise<EnvironmentRevision | null> {
    const row = await this.store.get<EnvironmentRow>("SELECT * FROM environment_revisions WHERE revision_id = ? AND status = 'ready'", [revisionId]);
    return row ? toRevision(row) : null;
  }

  async upsert(revision: EnvironmentRevision): Promise<EnvironmentRevision> {
    const now = Date.now();
    await this.store.run(
      `INSERT INTO environment_revisions
        (revision_id, environment_id, name, display_name, language, status, prefix, packages_json, platform, supersedes_revision_id, failure_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(revision_id) DO UPDATE SET
        environment_id = excluded.environment_id,
        name = excluded.name,
        display_name = excluded.display_name,
        language = excluded.language,
        status = excluded.status,
        prefix = excluded.prefix,
        packages_json = excluded.packages_json,
        platform = excluded.platform,
        supersedes_revision_id = excluded.supersedes_revision_id,
        failure_json = excluded.failure_json,
        updated_at = excluded.updated_at`,
      [
        revision.revision_id,
        revision.environment_id,
        revision.name,
        revision.display_name,
        revision.language,
        revision.status,
        revision.prefix,
        JSON.stringify(revision.packages),
        revision.platform,
        revision.supersedes_revision_id ?? null,
        revision.failure ? JSON.stringify(revision.failure) : null,
        timestamp(revision.created_at) ?? now,
        now,
      ],
    );
    return (await this.get(revision.revision_id))!;
  }

  async updateStatus(revisionId: string, status: EnvironmentStatus, failure?: EnvironmentRevision["failure"]): Promise<EnvironmentRevision | null> {
    const result = await this.store.run("UPDATE environment_revisions SET status = ?, failure_json = ?, updated_at = ? WHERE revision_id = ?", [status, failure ? JSON.stringify(failure) : null, Date.now(), revisionId]);
    if (Number(result.changes) === 0) return null;
    return this.get(revisionId);
  }

  async importLegacy(revisions: EnvironmentRevision[], fingerprint: string): Promise<{ rows: number; skipped: boolean }> {
    if (await importAlreadyApplied(this.store, "environment-registry", fingerprint)) return { rows: 0, skipped: true };
    const sorted = revisions.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    let rows = 0;
    for (const revision of sorted) {
      try { await this.upsert(revision); rows += 1; }
      catch (error) {
        // A malformed legacy chain should not prevent valid revisions from
        // being imported. The caller can diagnose the rejected row from logs.
        if (String(error).toLowerCase().includes("foreign key")) {
          const detached = { ...revision, supersedes_revision_id: undefined };
          await this.upsert(detached);
          rows += 1;
        } else throw error;
      }
    }
    await markImport(this.store, "environment-registry", fingerprint, rows);
    return { rows, skipped: false };
  }
}

interface EnvironmentRow {
  revision_id: string;
  environment_id: string;
  name: string;
  display_name: string;
  language: EnvironmentLanguage;
  status: EnvironmentStatus;
  prefix: string;
  packages_json: string;
  platform: string;
  supersedes_revision_id: string | null;
  failure_json: string | null;
  created_at: number;
}

function toRevision(row: EnvironmentRow): EnvironmentRevision {
  const packages = parseJson<unknown>(row.packages_json, []);
  const failure = parseJson<EnvironmentRevision["failure"] | null>(row.failure_json, null);
  return {
    environment_id: row.environment_id,
    revision_id: row.revision_id,
    name: row.name,
    display_name: row.display_name,
    language: row.language,
    status: row.status,
    prefix: row.prefix,
    packages: Array.isArray(packages) ? packages.filter((item): item is string => typeof item === "string") : [],
    platform: row.platform,
    created_at: new Date(Number(row.created_at)).toISOString(),
    ...(row.supersedes_revision_id ? { supersedes_revision_id: row.supersedes_revision_id } : {}),
    ...(failure ? { failure } : {}),
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function timestamp(value: string): number | null {
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
