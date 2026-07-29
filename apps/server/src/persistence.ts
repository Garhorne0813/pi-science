import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { userHome } from "./platform-utils.js";

const writeQueues = new Map<string, Promise<void>>();
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 100;

export function metadataRoot(workspace: string): string {
  return join(resolve(workspace), ".pi-science");
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
export async function withFileWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const pending = previous.then(() => gate);
  writeQueues.set(key, pending);
  await previous;
  try {
    const unlock = await acquireFileLock(key);
    try { return await operation(); } finally { await unlock(); }
  } finally { release(); if (writeQueues.get(key) === pending) writeQueues.delete(key); }
}

/** Cross-process advisory lock: exclusive creation of a `<path>.lock` sidecar is
 *  the mutual-exclusion primitive. Resolves with the release function once the
 *  lock is held; callers must release it in a `finally`. */
export async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${resolve(path)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let wait = LOCK_RETRY_MIN_MS; ; wait = Math.min(wait * 2, LOCK_RETRY_MAX_MS)) {
    try {
      const handle = await open(lockPath, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }), "utf8"); } finally { await handle.close(); }
      return async () => { await unlink(lockPath).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await breakStaleLock(lockPath);
      await new Promise((resolveWait) => setTimeout(resolveWait, wait));
    }
  }
}

/** A lock is only stolen when it is BOTH older than the stale window AND its
 *  owner is gone: age alone would steal from a slow but healthy writer, while a
 *  dead pid alone would steal from a fresh lock whose pid the OS recycled. */
async function breakStaleLock(lockPath: string): Promise<void> {
  let info;
  try { info = await stat(lockPath); } catch { return; }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
  if (await lockOwnerIsAlive(lockPath)) return;
  // rename() is the arbiter: only one of several racing processes can move the
  // stale inode away, so only one of them goes on to recreate the lock.
  const claim = `${lockPath}.stale-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try { await rename(lockPath, claim); } catch { return; }
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

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
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
