import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock, withFileWriteLock, writeJsonAtomic } from "./persistence.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-persistence-"));
  cleanup.push(cwd);
  return cwd;
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** A pid that is guaranteed to be dead: spawn a process and wait for its exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => child.once("close", resolve));
  return pid;
}

describe("cross-process file lock", () => {
  it("serializes two concurrent acquisitions of the same lock", async () => {
    const cwd = await workspace();
    const path = join(cwd, "records.jsonl");
    const order: string[] = [];
    const first = await acquireFileLock(path);
    order.push("first-acquired");
    let secondHeld = false;
    const second = acquireFileLock(path).then((release) => { secondHeld = true; order.push("second-acquired"); return release; });

    await delay(120);
    expect(secondHeld).toBe(false);
    expect(await stat(`${path}.lock`).then(() => true)).toBe(true);
    order.push("first-released");
    await first();
    const release = await second;
    expect(secondHeld).toBe(true);
    expect(order).toEqual(["first-acquired", "first-released", "second-acquired"]);
    expect(JSON.parse(await readFile(`${path}.lock`, "utf8")).pid).toBe(process.pid);
    await release();
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it("takes over a lock whose owner died and left the file behind", async () => {
    const cwd = await workspace();
    const path = join(cwd, "records.jsonl");
    const owner = await deadPid();
    await writeFile(`${path}.lock`, JSON.stringify({ pid: owner, acquired_at: new Date(Date.now() - 120_000).toISOString() }), "utf8");
    const stale = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, stale, stale);

    const started = Date.now();
    const release = await acquireFileLock(path);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.parse(await readFile(`${path}.lock`, "utf8")).pid).toBe(process.pid);
    await release();
  });

  it("waits for a fresh lock held by a live process instead of stealing it", async () => {
    const cwd = await workspace();
    const path = join(cwd, "records.jsonl");
    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }), "utf8");

    let acquired = false;
    const pending = acquireFileLock(path).then((release) => { acquired = true; return release; });
    await delay(300);
    expect(acquired).toBe(false);

    await rm(`${path}.lock`);
    const release = await pending;
    expect(acquired).toBe(true);
    await release();
  });

  it("blocks withFileWriteLock while another process holds the lockfile", async () => {
    const cwd = await workspace();
    const path = join(cwd, "records.jsonl");
    // Stand in for a second server process: a live pid keeps the lock unstealable.
    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }), "utf8");

    let ran = false;
    const pending = withFileWriteLock(path, async () => { ran = true; return "done"; });
    await delay(250);
    expect(ran).toBe(false);

    await rm(`${path}.lock`);
    expect(await pending).toBe("done");
    expect(ran).toBe(true);
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  it("retries transient Windows-style release failures before advancing the queue", async () => {
    const cwd = await workspace();
    const path = join(cwd, "records.jsonl");
    let attempts = 0;
    const result = await withFileWriteLock(path, async () => "done", {
      unlink: async (target) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("busy"), { code: attempts === 1 ? "EPERM" : "EBUSY" });
        await rm(target);
      },
      sleep: async () => undefined,
    });
    expect(result).toBe("done");
    expect(attempts).toBe(3);
    expect(await withFileWriteLock(path, async () => "next")).toBe("next");
  });

  it("propagates permanent release failure without leaving the next queued writer hanging", async () => {
    const cwd = await workspace();
    const path = join(cwd, "records.jsonl");
    const permanent = Object.assign(new Error("access denied"), { code: "EACCES" });
    const first = withFileWriteLock(path, async () => "first", { unlink: async () => { throw permanent; } });
    const second = withFileWriteLock(path, async () => "second");
    await expect(first).rejects.toThrow("access denied");
    await expect(Promise.race([second, delay(2_000).then(() => "hung")])).resolves.toBe("second");
  });

  it("writes atomically with idempotent overwrite", async () => {
    const cwd = await workspace();
    const path = join(cwd, "normal.json");
    await writeJsonAtomic(path, { key: "value" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ key: "value" });
    await writeJsonAtomic(path, { key: "updated" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ key: "updated" });
  });

  it("creates the destination with the requested POSIX mode", async () => {
    const cwd = await workspace();
    const path = join(cwd, "secret.json");
    await writeJsonAtomic(path, { key: "secret" }, { mode: 0o600 });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ key: "secret" });
  });

  it("leaves no orphaned temp files after a normal atomic write", async () => {
    const cwd = await workspace();
    const path = join(cwd, "no-temp.json");
    await writeJsonAtomic(path, { key: "clean" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(cwd).catch(() => [] as string[]);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("never removes a lock whose ownership token was replaced", async () => {
    const cwd = await workspace();
    const path = join(cwd, "records.jsonl");
    const release = await acquireFileLock(path);
    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), token: "replacement-token" }), "utf8");
    await expect(release()).rejects.toThrow("ownership changed");
    expect(JSON.parse(await readFile(`${path}.lock`, "utf8")).token).toBe("replacement-token");
    await rm(`${path}.lock`);
  });
});
