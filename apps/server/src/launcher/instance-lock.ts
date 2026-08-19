import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
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
      const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
      try { await rename(path, stalePath); } catch { throw new SingleInstanceError(); }
      await unlink(stalePath).catch(() => undefined);
      return attempt();
    }
  };

  return attempt();
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs < STALE_MS) return false;
    const text = await readFile(path, "utf8");
    const owner = JSON.parse(text) as { pid?: unknown };
    if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) return true;
    try { process.kill(owner.pid as number, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch {
    return false;
  }
}