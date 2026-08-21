import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class SingleInstanceError extends Error {
  code = "EALREADYRUNNING";

  constructor(message = "Another Pi-Science instance is already running") {
    super(message);
    this.name = "SingleInstanceError";
  }
}

export interface InstanceLock {
  release(): Promise<void>;
}

interface LockOwner { pid: number; acquired_at: string; token: string }

const STALE_MS = 30_000;

export async function acquireSingleInstanceLock(lockPath: string): Promise<InstanceLock> {
  const path = resolve(lockPath);
  await mkdir(dirname(path), { recursive: true });

  const removeOwnedLock = async (token: string): Promise<void> => {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return;
    let owner: LockOwner;
    try { owner = JSON.parse(text) as LockOwner; } catch { return; }
    if (owner.token === token) await unlink(path).catch(() => undefined);
  };

  const attempt = async (): Promise<InstanceLock> => {
    const token = randomUUID();
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          acquired_at: new Date().toISOString(),
          token,
        } satisfies LockOwner), "utf8");
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await removeOwnedLock(token);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await isStaleLock(path))) throw new SingleInstanceError();
      if (!(await reclaimStaleLock(path))) throw new SingleInstanceError();
      return attempt();
    }
  };

  return attempt();
}

interface LockSnapshot { mtimeMs: number; pid: number | null }

async function readLockSnapshot(path: string): Promise<LockSnapshot | null> {
  let info;
  let text;
  try {
    info = await stat(path);
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let pid: number | null = null;
  try {
    const owner = JSON.parse(text) as { pid?: unknown };
    pid = Number.isInteger(owner.pid) && (owner.pid as number) > 0 ? owner.pid as number : null;
  } catch {
    pid = null; // Corrupt content (for example a truncated write): only recyclable once the mtime expires.
  }
  return { mtimeMs: info.mtimeMs, pid };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Unlink a stale lock only after re-validating its content and mtime immediately before removal.
 * A fresh lock always carries a live pid, so a concurrent recycler that lost the race never deletes it.
 * Remaining window: a lock written between the final snapshot and unlink can still be removed; the next
 * contender then wins the open("wx") while the previous holder keeps running. Full exclusion would need
 * OS advisory locks; this keeps the window to two filesystem operations. */
async function reclaimStaleLock(path: string): Promise<boolean> {
  const before = await readLockSnapshot(path);
  if (!before || Date.now() - before.mtimeMs < STALE_MS) return false;
  if (before.pid !== null && pidAlive(before.pid)) return false;
  const current = await readLockSnapshot(path);
  if (!current || current.mtimeMs !== before.mtimeMs || current.pid !== before.pid) return false;
  if (current.pid !== null && pidAlive(current.pid)) return false;
  try { await unlink(path); } catch { return false; }
  return true;
}

async function isStaleLock(path: string): Promise<boolean> {
  const owner = await readLockSnapshot(path);
  if (!owner) return false;
  if (Date.now() - owner.mtimeMs < STALE_MS) return false;
  if (owner.pid === null) return true; // Corrupt content plus expired mtime: safe to recycle.
  return !pidAlive(owner.pid);
}