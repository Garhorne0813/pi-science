import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobCoordinator, type JobRecord, type JobStatus, restrictResearchEnvironment, windowsTaskkillArgs } from "./job-coordinator.js";

const cleanup: string[] = [];
const jobs: JobCoordinator[] = [];
const TERMINAL: JobStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

afterEach(async () => {
  await Promise.allSettled(jobs.splice(0).map((coordinator) => coordinator.shutdown()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-job-coordinator-"));
  cleanup.push(cwd);
  return cwd;
}

function jobCoordinator(environment: NodeJS.ProcessEnv = { ...process.env }, hooks: ConstructorParameters<typeof JobCoordinator>[1] = {}): JobCoordinator {
  const coordinator = new JobCoordinator({ environment: async () => ({ ...environment }) }, hooks);
  jobs.push(coordinator);
  return coordinator;
}

async function writeStoredJob(cwd: string, jobId: string, status: JobStatus, createdAt: string, stderr = ""): Promise<void> {
  const record: JobRecord = { job_id: jobId, command: ["/bin/true"], cwd, surface: "local", status, created_at: createdAt, stdout: "", stderr, artifact_ids: [], environment: {}, requirement: {} };
  await mkdir(join(cwd, ".pi-science", "jobs"), { recursive: true });
  await writeFile(join(cwd, ".pi-science", "jobs", `${jobId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

const terminal = (record: JobRecord | null) => Boolean(record && TERMINAL.includes(record.status));

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    const value = await read();
    last = value;
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for job state: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("job coordinator", () => {
  it("heals orphaned pending/running records after a restart and unblocks hasActive", async () => {
    const cwd = await workspace();
    await writeStoredJob(cwd, "job_orphan0000000000", "running", new Date(Date.now() - 60_000).toISOString(), "earlier stderr");
    const coordinator = jobCoordinator();
    const healed = await coordinator.get(cwd, "job_orphan0000000000");
    expect(healed?.status).toBe("failed");
    expect(healed?.return_code).toBeNull();
    expect(healed?.ended_at).toBeTruthy();
    expect(healed?.stderr).toContain("earlier stderr");
    expect(healed?.stderr).toContain("orphaned by a server restart");
    const persisted = JSON.parse(await readFile(join(cwd, ".pi-science", "jobs", "job_orphan0000000000.json"), "utf8")) as JobRecord;
    expect(persisted.status).toBe("failed");
    expect(await coordinator.hasActive(cwd)).toBe(false);
  });

  it("keeps untracked records inside the grace period untouched", async () => {
    const cwd = await workspace();
    const now = new Date().toISOString();
    await writeStoredJob(cwd, "job_fresh00000000000", "pending", now);
    await writeStoredJob(cwd, "job_fresh11111111111", "running", now);
    const coordinator = jobCoordinator();
    expect((await coordinator.get(cwd, "job_fresh00000000000"))?.status).toBe("pending");
    expect((await coordinator.list(cwd, 10)).map((record) => record.status).sort()).toEqual(["pending", "running"]);
    expect(await coordinator.hasActive(cwd)).toBe(true);
  });

  it("leaves live submitted jobs alone until they finish on their own", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator();
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", "setTimeout(() => {}, 200)"] });
    expect((await coordinator.get(cwd, submitted.job_id))?.status).not.toBe("failed");
    expect((await coordinator.list(cwd, 10))[0]?.status).not.toBe("failed");
    const finished = await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal, process.platform === "win32" ? 20_000 : 8_000);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.return_code).toBe(0);
    expect((await coordinator.cancel(cwd, submitted.job_id))?.status).toBe("succeeded");
    expect((await coordinator.get(cwd, submitted.job_id))?.status).toBe("succeeded");
  }, 30_000);

  it("cancels a ready process grandchild instead of stalling shutdown", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator();
    const ready = join(cwd, "grandchild-ready");
    const childScript = `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => {}, 30000);`;
    const parentScript = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: ["ignore", "inherit", "inherit"] }); setTimeout(() => {}, 30000);`;
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", parentScript] });
    await waitFor(async () => stat(ready).then(() => true, () => false), Boolean);

    const started = Date.now();
    await coordinator.cancel(cwd, submitted.job_id);
    await coordinator.shutdown();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await coordinator.get(cwd, submitted.job_id))?.status).toBe("cancelled");
  }, 20_000);

  it("does not spawn a job cancelled after running state is persisted", async () => {
    const cwd = await workspace();
    const marker = join(cwd, "must-not-start");
    let releaseSpawn!: () => void;
    let enteredSpawnGate!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const gateEntered = new Promise<void>((resolve) => { enteredSpawnGate = resolve; });
    const coordinator = jobCoordinator(undefined, { beforeSpawn: async () => { enteredSpawnGate(); await spawnGate; } });
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`] });
    await gateEntered;

    const cancelled = await coordinator.cancel(cwd, submitted.job_id);
    expect(cancelled?.status).toBe("cancelled");
    releaseSpawn();
    await coordinator.shutdown();
    const finished = await coordinator.get(cwd, submitted.job_id);
    expect(finished?.status).toBe("cancelled");
    await expect(stat(marker)).rejects.toThrow();
  });

  it("does not spawn when another coordinator durably cancels the job", async () => {
    const cwd = await workspace();
    const marker = join(cwd, "cross-coordinator-must-not-start");
    let releaseSpawn!: () => void;
    let enteredSpawnGate!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const gateEntered = new Promise<void>((resolve) => { enteredSpawnGate = resolve; });
    const runner = jobCoordinator(undefined, { beforeSpawn: async () => { enteredSpawnGate(); await spawnGate; } });
    const canceller = jobCoordinator();
    const submitted = await runner.submit(cwd, { command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`] });
    await gateEntered;

    expect((await canceller.cancel(cwd, submitted.job_id))?.status).toBe("cancelled");
    releaseSpawn();
    await runner.shutdown();

    expect((await runner.get(cwd, submitted.job_id))?.status).toBe("cancelled");
    await expect(stat(marker)).rejects.toThrow();
  });

  it("waits for a timed-out process tree to close before settling", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator();
    const ready = join(cwd, "timeout-grandchild-ready");
    const childScript = `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => {}, 30000);`;
    const parentScript = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: ["ignore", "inherit", "inherit"] }); setTimeout(() => {}, 30000);`;
    const started = Date.now();
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", parentScript], requirement: { timeout_seconds: 1 } });
    await waitFor(async () => stat(ready).then(() => true, () => false), Boolean);

    const finished = await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal, process.platform === "win32" ? 20_000 : 10_000);
    expect(finished?.status).toBe("timed_out");
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    const shutdownStarted = Date.now();
    await coordinator.shutdown();
    expect(Date.now() - shutdownStarted).toBeLessThan(1_000);
  }, 30_000);

  it("preserves a durable cancellation when the runner is ready to persist success", async () => {
    const cwd = await workspace();
    let releaseTerminalSave!: () => void;
    let enteredTerminalSave!: () => void;
    const terminalSaveGate = new Promise<void>((resolve) => { releaseTerminalSave = resolve; });
    const gateEntered = new Promise<void>((resolve) => { enteredTerminalSave = resolve; });
    const coordinator = jobCoordinator(undefined, { beforeTerminalSave: async (record) => { if (record.status === "succeeded") { enteredTerminalSave(); await terminalSaveGate; } } });
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", "process.stdout.write('completed-output')"] });
    await gateEntered;

    const cancelled = await coordinator.cancel(cwd, submitted.job_id);
    expect(cancelled?.status).toBe("cancelled");
    releaseTerminalSave();
    await coordinator.shutdown();

    const finished = await coordinator.get(cwd, submitted.job_id);
    expect(finished).toMatchObject({ status: "cancelled", stdout: "completed-output", return_code: 0 });
    expect((await coordinator.cancel(cwd, submitted.job_id))?.status).toBe("cancelled");
  });

  it("builds a Windows taskkill command that includes the descendant tree", () => {
    expect(windowsTaskkillArgs(4321)).toEqual(["/pid", "4321", "/T", "/F"]);
  });

  it("uses exact allowlist keys on POSIX without promoting mixed-case host variables", () => {
    const filtered = restrictResearchEnvironment({ PATH: "/canonical/bin", PaTh: "/untrusted/bin", HOME: "/canonical/home", hOmE: "/untrusted/home", sEcReT_tOkEn: "leak-me", SECRET_TOKEN: "also-leak-me" }, "linux");
    expect(filtered).toEqual({ PATH: "/canonical/bin", HOME: "/canonical/home" });
  });

  it("matches Windows research environment keys case-insensitively and emits canonical non-duplicated keys", () => {
    const filtered = restrictResearchEnvironment({ PATH: "C:\\canonical", PaTh: "C:\\duplicate", hOmE: "C:\\Users\\scientist", sYsTeMrOoT: "C:\\Windows", cOmSpEc: "C:\\Windows\\System32\\cmd.exe", pAtHeXt: ".COM;.EXE;.BAT;.CMD", sEcReT_tOkEn: "leak-me" }, "win32");
    expect(filtered).toEqual({ PATH: "C:\\canonical", HOME: "C:\\Users\\scientist", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".COM;.EXE;.BAT;.CMD" });
  });

  it("passes only canonical research variables and requested PI_SCIENCE values to a POSIX child", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator({ PATH: process.env.PATH, HOME: "/tmp", hOmE: "/untrusted", sEcReT_tOkEn: "leak-me" }, { platform: "linux" });
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", "console.log(JSON.stringify(process.env))"], surface: "research-loop", env: { PI_SCIENCE_OUTPUT_DIR: "/tmp/x" } });
    const finished = await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal);
    expect(finished?.status).toBe("succeeded");
    const childEnv = JSON.parse(finished?.stdout ?? "{}") as Record<string, string | undefined>;
    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.HOME).toBe("/tmp");
    expect(childEnv.PI_SCIENCE_OUTPUT_DIR).toBe("/tmp/x");
    expect(childEnv.hOmE).toBeUndefined();
    expect(childEnv.sEcReT_tOkEn).toBeUndefined();
  });

  it("keeps the full environment for non-research surfaces", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator({ ...process.env, SECRET_TOKEN: "leak-me" });
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", "console.log(JSON.stringify(process.env))"], surface: "local" });
    const finished = await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal);
    expect(finished?.status).toBe("succeeded");
    const childEnv = JSON.parse(finished?.stdout ?? "{}") as Record<string, string | undefined>;
    expect(childEnv.SECRET_TOKEN).toBe("leak-me");
  }, 15_000);
});
