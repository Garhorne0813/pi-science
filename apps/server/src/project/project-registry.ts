import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";

export const PROJECT_MANIFEST_VERSION = 1 as const;

export interface ProjectManifest {
  id: string;
  name: string;
  version: typeof PROJECT_MANIFEST_VERSION;
  created_at: string;
  updated_at: string;
}

export interface ProjectUpdate {
  name?: string;
}

function metadataRoot(cwd: string): string {
  return join(resolve(cwd), ".pi-science");
}

export function projectManifestPath(cwd: string): string {
  return join(metadataRoot(cwd), "project.json");
}

function normalizeName(value: string | undefined, cwd: string): string {
  const name = value?.trim().replace(/[\\/]/g, "-").slice(0, 100);
  return name || basename(resolve(cwd)) || "Untitled project";
}

function isProjectManifest(value: unknown): value is ProjectManifest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === PROJECT_MANIFEST_VERSION
    && typeof record.id === "string"
    && record.id.length > 0
    && typeof record.name === "string"
    && record.name.length > 0
    && typeof record.created_at === "string"
    && record.created_at.length > 0
    && typeof record.updated_at === "string"
    && record.updated_at.length > 0;
}

/** Read a registered project without creating or modifying anything. */
export async function readProject(cwd: string): Promise<ProjectManifest | null> {
  const path = projectManifestPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid project manifest JSON: ${path}`);
  }
  if (!isProjectManifest(value)) throw new Error(`Invalid project manifest: ${path}`);
  return value;
}

/**
 * Register a workspace once and return its stable project identity.
 *
 * The manifest is deliberately kept next to the workspace rather than in a
 * global registry. Moving or copying a workspace therefore keeps its identity
 * and remains usable without access to a central database.
 */
export async function ensureProject(cwd: string, name?: string): Promise<ProjectManifest> {
  const workspace = resolve(cwd);
  const workspaceStat = await stat(workspace);
  if (!workspaceStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);

  const metadata = metadataRoot(workspace);
  await mkdir(metadata, { recursive: true });
  const path = projectManifestPath(workspace);

  return withFileWriteLock(path, async () => {
    const existing = await readProject(workspace);
    if (existing) return existing;

    const now = new Date().toISOString();
    const manifest: ProjectManifest = {
      id: `project_${randomUUID()}`,
      name: normalizeName(name, workspace),
      version: PROJECT_MANIFEST_VERSION,
      created_at: now,
      updated_at: now,
    };
    await writeJsonAtomic(path, manifest);
    return manifest;
  });
}

export async function updateProject(cwd: string, update: ProjectUpdate): Promise<ProjectManifest> {
  const workspace = resolve(cwd);
  const workspaceStat = await stat(workspace);
  if (!workspaceStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  const path = projectManifestPath(workspace);
  await mkdir(metadataRoot(workspace), { recursive: true });

  return withFileWriteLock(path, async () => {
    const existing = await readProject(workspace);
    const now = new Date().toISOString();
    const current = existing ?? {
      id: `project_${randomUUID()}`,
      name: normalizeName(undefined, workspace),
      version: PROJECT_MANIFEST_VERSION,
      created_at: now,
      updated_at: now,
    } satisfies ProjectManifest;
    const next: ProjectManifest = {
      ...current,
      ...(update.name !== undefined ? { name: normalizeName(update.name, workspace) } : {}),
      updated_at: new Date().toISOString(),
    };
    await writeJsonAtomic(path, next);
    return next;
  });
}
