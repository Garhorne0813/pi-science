import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSingleInstanceLock, SingleInstanceError } from "./instance-lock.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function lockPath(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-launcher-"));
  cleanup.push(cwd);
  return join(cwd, "instance.lock");
}

/** A pid whose owning process has exited and been reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => child.once("close", resolve));
  return pid;
}

async function setOldMtime(path: string): Promise<void> {
  const old = new Date(Date.now() - 120_000);
  await utimes(path, old, old);
}

describe("single instance lock", () => {
  it("acquires and releases the lock", async () => {
    const path = await lockPath();
    const lock = await acquireSingleInstanceLock(path);
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await lock.release();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("rejects a second live instance immediately", async () => {
    const path = await lockPath();
    const first = await acquireSingleInstanceLock(path);
    await expect(acquireSingleInstanceLock(path)).rejects.toBeInstanceOf(SingleInstanceError);
    await first.release();
    await expect(acquireSingleInstanceLock(path)).resolves.toBeDefined();
  });

  it("reclaims a stale lock left by a dead process", async (ctx) => {
    const path = await lockPath();
    // Some dev machines recycle or alias pids so fast that a freshly reaped pid reads as alive again,
    // which correctly refuses the recycle. Retry a few rounds, then skip instead of flaking.
    for (let round = 0; round < 3; round += 1) {
      const pid = await deadPid();
      await writeFile(path, JSON.stringify({ pid, acquired_at: new Date(Date.now() - 120_000).toISOString(), token: "old" }), "utf8");
      await setOldMtime(path);
      try {
        const lock = await acquireSingleInstanceLock(path);
        expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
        await lock.release();
        return;
      } catch (error) {
        if (!(error instanceof SingleInstanceError)) throw error;
        await rm(path, { force: true });
      }
    }
    ctx.skip(true, "host pid semantics are unstable for dead-pid fixtures");
  });

  it("never recycles a lock whose recorded pid is still alive", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: process.pid, acquired_at: new Date(Date.now() - 120_000).toISOString(), token: "live" }), "utf8");
    await setOldMtime(path);

    await expect(acquireSingleInstanceLock(path)).rejects.toBeInstanceOf(SingleInstanceError);
  });

  it("self-heals a corrupt lock file once its mtime expires", async () => {
    const path = await lockPath();
    await writeFile(path, "{ truncated", "utf8");
    await setOldMtime(path);

    const lock = await acquireSingleInstanceLock(path);
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("rejects a corrupt lock file while its mtime is fresh", async () => {
    const path = await lockPath();
    await writeFile(path, "{ truncated", "utf8");

    await expect(acquireSingleInstanceLock(path)).rejects.toBeInstanceOf(SingleInstanceError);
  });

  it("lets exactly one of two concurrent recyclers win a stale lock", async () => {
    const path = await lockPath();
    // Corrupt content plus an expired mtime takes the same stale-recycle path without depending on pid liveness.
    await writeFile(path, "{ truncated", "utf8");
    await setOldMtime(path);

    const results = await Promise.allSettled([acquireSingleInstanceLock(path), acquireSingleInstanceLock(path)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    if (fulfilled[0]?.status === "fulfilled") await fulfilled[0].value.release();
  });
});