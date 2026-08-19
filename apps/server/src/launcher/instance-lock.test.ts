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

/** A pid that is guaranteed to be dead: spawn a process and wait for its exit. */
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

  it("reclaims a stale lock left by a dead process", async () => {
    const path = await lockPath();
    const pid = await deadPid();
    await writeFile(path, JSON.stringify({ pid, acquired_at: new Date(Date.now() - 120_000).toISOString(), token: "old" }), "utf8");
    await setOldMtime(path);

    const lock = await acquireSingleInstanceLock(path);
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });
});