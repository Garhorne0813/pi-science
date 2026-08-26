import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { userHome } from "../support/platform-utils.js";

const writeQueues = new Map<string, Promise<void>>();
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 100;
const LOCK_RELEASE_RETRIES = 5;
const LOCK_RELEASE_RETRY_MS = 20;
const JSON_ATOMIC_RENAME_RETRIES = 5;
const JSON_ATOMIC_RENAME_RETRY_MS = 20;

export interface FileLockHooks { unlink?: (path: string) => Promise<void>; sleep?: (ms: number) => Promise<void> }
export interface WriteJsonAtomicOptions extends FileLockHooks { mode?: number }
interface LockOwner { pid: number; acquired_at: string; token?: string }

export function metadataRoot(workspace: string): string {
  return join(resolve(workspace), ".pi-science");
}

/** Serializes writers for a workspace's metadata under a single workspace-level lock. */
export async function withWorkspaceWriteLock<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const root = metadataRoot(workspace);
  await mkdir(root, { recursive: true });
  return withFileWriteLock(join(root, "workspace.lock"), operation);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await withFileWriteLock(path, async () => {
    await appendJsonLineUnlocked(path, value);
  });
}

export async function appendJsonLineUnlocked(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

/** Serializes writers to `path`: the in-process promise queue is the fast path,
 *  and the advisory lockfile held for the queued operation keeps a second server
 *  process on the same workspace out. */
export async function withFileWriteLock<T>(path: string, operation: () => Promise<T>, hooks: FileLockHooks = {}): Promise<T> {
  const key = resolve(path);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const pending = previous.then(() => gate);
  writeQueues.set(key, pending);
  await previous;
  try {
    const unlock = await acquireFileLock(key, hooks);
    try { return await operation(); } finally { await unlock(); }
  } finally { release(); if (writeQueues.get(key) === pending) writeQueues.delete(key); }
}

/** Cross-process advisory lock: exclusive creation of a `<path>.lock` sidecar is
 *  the mutual-exclusion primitive. Resolves with the release function once the
 *  lock is held; callers must release it in a `finally`. */
export async function acquireFileLock(path: string, hooks: FileLockHooks = {}): Promise<() => Promise<void>> {
  const lockPath = `${resolve(path)}.lock`;
  const token = randomUUID();
  await mkdir(dirname(lockPath), { recursive: true });
  for (let wait = LOCK_RETRY_MIN_MS; ; wait = Math.min(wait * 2, LOCK_RETRY_MAX_MS)) {
    try {
      const handle = await open(lockPath, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), token } satisfies LockOwner), "utf8"); } finally { await handle.close(); }
      return async () => releaseFileLock(lockPath, token, hooks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await breakStaleLock(lockPath);
      await new Promise((resolveWait) => setTimeout(resolveWait, wait));
    }
  }
}

async function releaseFileLock(lockPath: string, token: string, hooks: FileLockHooks): Promise<void> {
  const remove = hooks.unlink ?? unlink;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
  const claim = `${lockPath}.release-${process.pid}-${token}`;
  let owner = await readLockOwner(lockPath);
  if (!owner) return;
  if (owner.token !== token) throw new Error(`File lock ownership changed before release: ${lockPath}`);
  try { await rename(lockPath, claim); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  owner = await readLockOwner(claim);
  if (owner?.token !== token) {
    try { await rename(claim, lockPath); } catch { /* keep the replacement claim for manual recovery rather than deleting it */ }
    throw new Error(`File lock ownership changed during release: ${lockPath}`);
  }
  for (let attempt = 0; ; attempt += 1) {
    const current = await readLockOwner(claim);
    if (current?.token !== token) throw new Error(`File lock ownership changed during release retry: ${lockPath}`);
    try { await remove(claim); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt >= LOCK_RELEASE_RETRIES - 1) throw error;
      await sleep(LOCK_RELEASE_RETRY_MS * (attempt + 1));
    }
  }
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return JSON.parse(text) as LockOwner; }
  catch { throw new Error(`Invalid file lock ownership record: ${path}`); }
}

/** A lock is only stolen when it is BOTH older than the stale window AND its
 *  owner is gone: age alone would steal from a slow but healthy writer, while a
 *  dead pid alone would steal from a fresh lock whose pid the OS recycled. */
async function breakStaleLock(lockPath: string): Promise<void> {
  let info;
  try { info = await stat(lockPath); } catch { return; }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
  const observed = await readFile(lockPath, "utf8").catch(() => null);
  if (observed === null || await lockOwnerIsAlive(lockPath)) return;
  const claim = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try { await rename(lockPath, claim); } catch { return; }
  const moved = await readFile(claim, "utf8").catch(() => null);
  if (moved !== observed) {
    try { await rename(claim, lockPath); } catch { /* never delete an unverified replacement lock */ }
    return;
  }
  await unlink(claim).catch(() => undefined);
}

async function lockOwnerIsAlive(lockPath: string): Promise<boolean> {
  let pid: number;
  try { pid = Number((JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown }).pid); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    const result: T[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { result.push(JSON.parse(line) as T); } catch { /* tolerate a torn tail */ }
    }
    return result;
  } catch {
    return [];
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

async function writeJsonPayload(path: string, serialized: string, mode?: number): Promise<void> {
  if (mode === undefined) {
    await writeFile(path, serialized, "utf8");
    return;
  }
  // Apply mode on create and chmod this inode before rename so a crash cannot
  // leave the destination world-readable.
  const handle = await open(path, "w", mode);
  try {
    await handle.writeFile(serialized, "utf8");
    try { await handle.chmod(mode); } catch { /* Windows and non-POSIX volumes */ }
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(path: string, value: unknown, options: WriteJsonAtomicOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
  const remove = options.unlink ?? unlink;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeJsonPayload(temporary, serialized, options.mode);
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, path); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (attempt >= JSON_ATOMIC_RENAME_RETRIES - 1) throw error;
        // Antivirus or a cleaner removed the temp file; rewrite and retry.
        await writeJsonPayload(temporary, serialized, options.mode);
        await sleep(JSON_ATOMIC_RENAME_RETRY_MS * (attempt + 1));
        continue;
      }
      if (code !== "EPERM" && code !== "EBUSY") throw error;
      if (attempt >= JSON_ATOMIC_RENAME_RETRIES - 1) { await remove(temporary).catch(() => undefined); throw error; }
      await sleep(JSON_ATOMIC_RENAME_RETRY_MS * (attempt + 1));
    }
  }
}

export function configRoot(): string {
  const configured = process.env.PI_SCIENCE_HOME;
  const candidates = [
    configured ? resolve(configured) : resolve(userHome(), ".pi-science"),
    resolve(process.cwd(), ".runtime", "pi-science"),
  ];
  for (const candidate of candidates) {
    const probe = join(candidate, `.write-probe-${process.pid}`);
    try {
      mkdirSync(candidate, { recursive: true });
      writeFileSync(probe, "", "utf8");
      unlinkSync(probe);
      return candidate;
    } catch {
      try { unlinkSync(probe); } catch { /* best effort */ }
      // Try the project-local runtime root when the home directory is managed
      // or mounted read-only.
    }
  }
  return candidates[0]!;
}

export function configPath(name: string): string {
  return join(configRoot(), name);
}

export function workspaceFile(workspace: string, name: string): string {
  return join(metadataRoot(workspace), name);
}
