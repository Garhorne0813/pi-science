import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EnvironmentRevision } from "../../runtime/workspace/workspace-environment.js";
import { configPath } from "../persistence.js";
import { JobRepository } from "./repositories/job-repository.js";
import { EnvironmentRepository } from "./repositories/environment-repository.js";
import { fingerprintPaths, WorkspaceRepository } from "./repositories/workspace-repository.js";
import type { SqliteStateStore } from "./state-store.js";

export interface LegacyStateImportOptions {
  store: SqliteStateStore;
  workspaces: WorkspaceRepository;
  environments: EnvironmentRepository;
  jobs: JobRepository;
  managedRoot: string;
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

export async function importLegacyState(options: LegacyStateImportOptions): Promise<void> {
  const registered = await readJsonArray(configPath("registered-workspaces.json"));
  const pinned = await readJsonArray(configPath("pinned.json"));
  const managed = await managedWorkspacePaths(options.managedRoot);
  const registeredText = await readText(configPath("registered-workspaces.json"));
  const pinnedText = await readText(configPath("pinned.json"));
  const workspaceResult = await options.workspaces.importLegacy({
    registered_paths: registered,
    pinned_paths: pinned,
    managed_paths: managed,
    ...(registeredText !== null ? { registered_fingerprint: fingerprint(registeredText) } : {}),
    ...(pinnedText !== null ? { pinned_fingerprint: fingerprint(pinnedText) } : {}),
    managed_fingerprint: fingerprintPaths(managed),
  });
  options.logger?.("SQLite legacy workspace import complete", workspaceResult);

  const environmentPath = configPath(join("environments", "registry.json"));
  const environmentText = await readText(environmentPath);
  if (environmentText !== null) {
    const parsed = parseEnvironmentRegistry(environmentText);
    const result = await options.environments.importLegacy(parsed, fingerprint(environmentText));
    options.logger?.("SQLite legacy environment import complete", result);
  }

  const known = await options.workspaces.listKnown({ includeMissing: false });
  const jobResult = await options.jobs.importLegacy(known.map((location) => location.path));
  options.logger?.("SQLite legacy job import complete", jobResult);
}

async function managedWorkspacePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const name of await readdir(root)) {
      const path = join(root, name);
      try {
        if ((await stat(path)).isDirectory() && (await stat(join(path, ".pi-science"))).isDirectory()) paths.push(resolve(path));
      } catch { /* ignore stale or non-workspace entries */ }
    }
  } catch { /* managed root may not exist yet */ }
  return paths;
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

async function readJsonArray(path: string): Promise<string[]> {
  const text = await readText(path);
  if (text === null) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch { return []; }
}

function parseEnvironmentRegistry(text: string): EnvironmentRevision[] {
  try {
    const value = JSON.parse(text) as { schema_version?: unknown; revisions?: unknown };
    if (value.schema_version !== 1 || !Array.isArray(value.revisions)) return [];
    return value.revisions.filter(isEnvironmentRevision);
  } catch { return []; }
}

function isEnvironmentRevision(value: unknown): value is EnvironmentRevision {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.environment_id === "string"
    && typeof row.revision_id === "string"
    && typeof row.name === "string"
    && typeof row.display_name === "string"
    && (row.language === "python" || row.language === "r")
    && (row.status === "creating" || row.status === "ready" || row.status === "failed" || row.status === "archived")
    && typeof row.prefix === "string"
    && Array.isArray(row.packages)
    && row.packages.every((item) => typeof item === "string")
    && typeof row.platform === "string"
    && typeof row.created_at === "string";
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
