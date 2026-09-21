import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { legacyMetadataRoot, metadataRoot, withFileWriteLock, workspaceStateRoot, writeJsonAtomic } from "../storage/persistence.js";

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

export function projectManifestPath(cwd: string): string {
  return join(metadataRoot(cwd), "project.json");
}

async function assertSafeMetadataTree(root: string): Promise<void> {
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Legacy workspace metadata contains a symbolic link: ${path}`);
    if (info.isFile()) {
      if (info.nlink > 1) throw new Error(`Legacy workspace metadata contains a hard-linked file: ${path}`);
      return;
    }
    if (!info.isDirectory()) throw new Error(`Legacy workspace metadata contains an unsupported file type: ${path}`);
    for (const name of await readdir(path)) {
      entries += 1;
      if (entries > 100_000) throw new Error(`Legacy workspace metadata contains too many entries: ${root}`);
      await visit(join(path, name));
    }
  };
  await visit(root);
}

async function migrateLegacyMetadata(cwd: string): Promise<void> {
  const legacy = legacyMetadataRoot(cwd);
  let info;
  try { info = await lstat(legacy); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Legacy workspace metadata is not a directory: ${legacy}`);
  await assertSafeMetadataTree(legacy);
  const target = workspaceStateRoot(cwd);
  await mkdir(dirname(target), { recursive: true });
  await withFileWriteLock(`${target}.migration`, async () => {
    try {
      await rename(legacy, target);
      try { await assertSafeMetadataTree(target); }
      catch (error) { await rename(target, legacy).catch(() => undefined); throw error; }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        try { if ((await stat(target)).isDirectory()) return; } catch { /* continue to surface the original failure */ }
      }
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        const entries = await readdir(target);
        if (entries.length > 0) throw new Error(`Cannot migrate legacy workspace metadata because the global state directory is not empty: ${target}`);
        await rm(target, { recursive: true });
        await rename(legacy, target);
        try { await assertSafeMetadataTree(target); }
        catch (error) { await rename(target, legacy).catch(() => undefined); throw error; }
        return;
      }
      if (code !== "EXDEV") throw error;
    }
    const staging = `${target}.migrating-${randomUUID()}`;
    try {
      await cp(legacy, staging, { recursive: true, force: false, errorOnExist: true });
      await assertSafeMetadataTree(staging);
      await rename(staging, target);
      await rm(legacy, { recursive: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
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
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
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
 * The manifest lives in the application state root so agent processes that can
 * write the project never gain access to control-plane identity or state.
 */
export async function ensureProject(cwd: string, name?: string): Promise<ProjectManifest> {
  const workspace = resolve(cwd);
  const workspaceStat = await stat(workspace);
  if (!workspaceStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);

  await migrateLegacyMetadata(workspace);
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
