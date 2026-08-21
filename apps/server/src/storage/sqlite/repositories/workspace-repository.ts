import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ProjectManifest } from "../../../project/project-registry.js";
import { ensureProject } from "../../../project/project-registry.js";
import type { SqliteStateStore } from "../state-store.js";

export interface WorkspaceLocationInput {
  project_id: string;
  name: string;
  manifest_version?: number;
  created_at?: string;
  updated_at?: string;
  canonical_path?: string;
  path?: string;
  preserve_path?: boolean;
  is_managed?: boolean;
  is_pinned?: boolean;
  last_opened_at?: string;
  touch?: boolean;
}

export interface WorkspaceLocation {
  project_id: string;
  name: string;
  manifest_version: number;
  canonical_path: string;
  path: string;
  is_managed: boolean;
  is_pinned: boolean;
  last_opened_at: string | null;
  last_seen_at: string;
  missing_since: string | null;
}

export interface LegacyWorkspaceSources {
  registered_paths: string[];
  pinned_paths: string[];
  managed_paths: string[];
  registered_fingerprint?: string;
  pinned_fingerprint?: string;
  managed_fingerprint?: string;
}

export class WorkspaceRepository {
  constructor(private readonly store: SqliteStateStore) {}

  async remember(input: WorkspaceLocationInput): Promise<WorkspaceLocation> {
    const rawPath = input.canonical_path ?? input.path ?? "";
    const path = input.preserve_path ? resolve(rawPath) : await canonicalPath(rawPath);
    if (!path) throw new Error("Workspace path is required");
    const now = Date.now();
    const createdAt = timestamp(input.created_at) ?? now;
    const updatedAt = timestamp(input.updated_at) ?? now;
    const lastOpenedAt = input.touch === false ? null : timestamp(input.last_opened_at) ?? now;
    await this.store.batch([
      {
        sql: `INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(project_id) DO UPDATE SET
                name = excluded.name,
                manifest_version = excluded.manifest_version,
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at`,
        params: [input.project_id, input.name || basename(path), input.manifest_version ?? 1, createdAt, updatedAt, now],
      },
      {
        sql: `INSERT INTO project_locations (canonical_path, project_id, is_managed, is_pinned, last_opened_at, last_seen_at, missing_since)
              VALUES (?, ?, ?, ?, ?, ?, NULL)
              ON CONFLICT(canonical_path) DO UPDATE SET
                project_id = excluded.project_id,
                is_managed = excluded.is_managed,
                is_pinned = CASE WHEN excluded.is_pinned = 1 THEN 1 ELSE project_locations.is_pinned END,
                last_opened_at = excluded.last_opened_at,
                last_seen_at = excluded.last_seen_at,
                missing_since = NULL`,
        params: [path, input.project_id, input.is_managed ? 1 : 0, input.is_pinned ? 1 : 0, lastOpenedAt, now],
      },
    ]);
    return (await this.getByPath(path, true))!;
  }

  async rememberWorkspace(cwd: string, options: { managed?: boolean; pinned?: boolean; touch?: boolean; preservePath?: boolean } = {}): Promise<WorkspaceLocation> {
    const workspace = resolve(cwd);
    const manifest = await ensureProject(workspace);
    return this.remember({
      project_id: manifest.id,
      name: manifest.name,
      manifest_version: manifest.version,
      created_at: manifest.created_at,
      updated_at: manifest.updated_at,
      canonical_path: workspace,
      preserve_path: options.preservePath,
      is_managed: options.managed,
      is_pinned: options.pinned,
      ...(options.touch === false ? { last_opened_at: undefined } : {}),
      touch: options.touch,
    });
  }

  async rememberMissing(cwd: string, options: { pinned?: boolean; managed?: boolean; preservePath?: boolean } = {}): Promise<WorkspaceLocation> {
    const path = options.preservePath ? resolve(cwd) : await canonicalPath(cwd);
    const manifest = placeholderManifest(path);
    const location = await this.remember({
      project_id: manifest.id,
      name: manifest.name,
      manifest_version: manifest.version,
      created_at: manifest.created_at,
      updated_at: manifest.updated_at,
      canonical_path: path,
      preserve_path: true,
      is_pinned: options.pinned,
      is_managed: options.managed,
      last_opened_at: undefined,
      touch: false,
    });
    await this.markMissing(path);
    return location;
  }

  async getByPath(pathValue: string, preservePath = false): Promise<WorkspaceLocation | null> {
    const path = preservePath ? resolve(pathValue) : await canonicalPath(pathValue);
    if (!path) return null;
    const row = await this.store.get<WorkspaceRow>(
      `SELECT p.project_id, p.name, p.manifest_version, l.canonical_path, l.is_managed, l.is_pinned,
              l.last_opened_at, l.last_seen_at, l.missing_since
         FROM project_locations l JOIN projects p ON p.project_id = l.project_id
        WHERE l.canonical_path = ?`,
      [path],
    );
    return row ? toLocation(row) : null;
  }

  async getByProject(projectId: string): Promise<WorkspaceLocation[]> {
    const rows = await this.store.all<WorkspaceRow>(
      `SELECT p.project_id, p.name, p.manifest_version, l.canonical_path, l.is_managed, l.is_pinned,
              l.last_opened_at, l.last_seen_at, l.missing_since
         FROM project_locations l JOIN projects p ON p.project_id = l.project_id
        WHERE l.project_id = ? ORDER BY l.last_opened_at DESC NULLS LAST, l.canonical_path`,
      [projectId],
    );
    return rows.map(toLocation);
  }

  async listKnown(options: { includeMissing?: boolean } = {}): Promise<WorkspaceLocation[]> {
    const rows = await this.store.all<WorkspaceRow>(
      `SELECT p.project_id, p.name, p.manifest_version, l.canonical_path, l.is_managed, l.is_pinned,
              l.last_opened_at, l.last_seen_at, l.missing_since
         FROM project_locations l JOIN projects p ON p.project_id = l.project_id
        ${options.includeMissing === false ? "WHERE l.missing_since IS NULL" : ""}
        ORDER BY l.is_pinned DESC, l.last_opened_at DESC NULLS LAST, l.canonical_path`,
    );
    return rows.map(toLocation);
  }

  async listPinned(): Promise<WorkspaceLocation[]> {
    const rows = await this.store.all<WorkspaceRow>(
      `SELECT p.project_id, p.name, p.manifest_version, l.canonical_path, l.is_managed, l.is_pinned,
              l.last_opened_at, l.last_seen_at, l.missing_since
         FROM project_locations l JOIN projects p ON p.project_id = l.project_id
        WHERE l.is_pinned = 1 ORDER BY l.last_opened_at DESC NULLS LAST, l.canonical_path`,
    );
    return rows.map(toLocation);
  }

  async setPinned(pathOrProjectId: string, pinned: boolean): Promise<void> {
    const path = await canonicalPath(pathOrProjectId);
    const result = await this.store.run(
      `UPDATE project_locations SET is_pinned = ?
        WHERE canonical_path = ? OR project_id = ?`,
      [pinned ? 1 : 0, path, pathOrProjectId],
    );
    if (Number(result.changes) === 0) throw new Error(`Workspace location not found: ${pathOrProjectId}`);
  }

  async setPinnedPath(pathValue: string, pinned: boolean, preservePath = false): Promise<void> {
    const path = preservePath ? resolve(pathValue) : await canonicalPath(pathValue);
    const result = await this.store.run("UPDATE project_locations SET is_pinned = ? WHERE canonical_path = ?", [pinned ? 1 : 0, path]);
    if (Number(result.changes) === 0 && pinned) throw new Error(`Workspace location not found: ${path}`);
  }

  async moveLocation(projectId: string, fromValue: string, toValue: string, preservePath = false): Promise<void> {
    const from = preservePath ? resolve(fromValue) : await canonicalPath(fromValue);
    const to = preservePath ? resolve(toValue) : await canonicalPath(toValue);
    if (!from || !to) throw new Error("Both workspace paths are required");
    await this.store.batch([
      { sql: "UPDATE project_locations SET canonical_path = ? WHERE canonical_path = ? AND project_id = ?", params: [to, from, projectId] },
      { sql: "UPDATE projects SET updated_at = ?, last_seen_at = ? WHERE project_id = ?", params: [Date.now(), Date.now(), projectId] },
    ]);
  }

  async markMissing(pathValue: string, missingAt = Date.now()): Promise<void> {
    const path = await canonicalPath(pathValue);
    await this.store.run("UPDATE project_locations SET missing_since = COALESCE(missing_since, ?), last_seen_at = ? WHERE canonical_path = ?", [missingAt, missingAt, path]);
  }

  async importLegacy(sources: LegacyWorkspaceSources): Promise<{ rows: number; skipped: number }> {
    const pinned = new Set(sources.pinned_paths.map((path) => normalizePath(path)));
    let rows = 0;
    let skipped = 0;
    const sourceGroups: Array<[string, string | undefined, string[]]> = [
      ["workspace-registry", sources.registered_fingerprint, sources.registered_paths],
      ["workspace-pinned", sources.pinned_fingerprint, sources.pinned_paths],
      ["workspace-managed", sources.managed_fingerprint, sources.managed_paths],
    ];
    const changedSources = new Set<string>();
    for (const [source, fingerprint, group] of sourceGroups) {
      if (!fingerprint || await importAlreadyApplied(this.store, source, fingerprint)) { if (fingerprint) skipped += group.length; continue; }
      changedSources.add(source);
    }
    const pathsToImport = unique(sourceGroups.filter(([source]) => changedSources.has(source)).flatMap(([, , paths]) => paths));
    for (const pathValue of pathsToImport) {
      const preservePath = sources.managed_paths.some((item) => normalizePath(item) === normalizePath(pathValue));
      const path = preservePath ? resolve(pathValue) : await canonicalPath(pathValue);
      if (!path) continue;
      const exists = await workspaceExists(path);
      let manifest: ProjectManifest;
      if (exists) manifest = await ensureProject(path);
      else manifest = placeholderManifest(path);
      await this.remember({
        project_id: manifest.id,
        name: manifest.name,
        manifest_version: manifest.version,
        created_at: manifest.created_at,
        updated_at: manifest.updated_at,
        canonical_path: path,
        preserve_path: preservePath,
        is_managed: sources.managed_paths.some((item) => normalizePath(item) === normalizePath(path)),
        is_pinned: pinned.has(normalizePath(path)),
        ...(exists ? {} : { last_opened_at: undefined }),
        ...(exists ? {} : { touch: false }),
      });
      if (!exists) await this.markMissing(path);
      rows += 1;
    }
    for (const [source, fingerprint, group] of sourceGroups) {
      if (fingerprint && changedSources.has(source)) await markImport(this.store, source, fingerprint, group.length);
    }
    return { rows, skipped };
  }

  async ensureProjectForPath(cwd: string): Promise<string> {
    return (await this.rememberWorkspace(cwd)).project_id;
  }
}

interface WorkspaceRow {
  project_id: string;
  name: string;
  manifest_version: number;
  canonical_path: string;
  is_managed: number;
  is_pinned: number;
  last_opened_at: number | null;
  last_seen_at: number;
  missing_since: number | null;
}

function toLocation(row: WorkspaceRow): WorkspaceLocation {
  return {
    project_id: row.project_id,
    name: row.name,
    manifest_version: Number(row.manifest_version),
    canonical_path: row.canonical_path,
    path: row.canonical_path,
    is_managed: row.is_managed === 1,
    is_pinned: row.is_pinned === 1,
    last_opened_at: iso(row.last_opened_at),
    last_seen_at: iso(row.last_seen_at)!,
    missing_since: iso(row.missing_since),
  };
}

async function canonicalPath(value: string): Promise<string> {
  if (!value) return "";
  const resolved = resolve(value);
  return realpath(resolved).catch(() => resolved);
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(Number(value)).toISOString();
}

async function workspaceExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() && (await stat(`${path}/.pi-science`)).isDirectory(); } catch { return false; }
}

function placeholderManifest(path: string): ProjectManifest {
  const id = `project_legacy_${createHash("sha256").update(normalizePath(path)).digest("hex").slice(0, 24)}`;
  const now = new Date(0).toISOString();
  return { id, name: basename(path) || "Untitled project", version: 1, created_at: now, updated_at: now };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizePath(value);
    if (!seen.has(key)) { seen.add(key); result.push(value); }
  }
  return result;
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

export function fingerprintPaths(paths: string[]): string {
  return createHash("sha256").update(JSON.stringify(unique(paths).map(normalizePath).sort())).digest("hex");
}
