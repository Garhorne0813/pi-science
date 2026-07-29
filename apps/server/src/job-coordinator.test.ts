import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobCoordinator, type JobRecord, type JobStatus, windowsTaskkillArgs } from "./job-coordinator.js";

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

function jobCoordinator(environment: NodeJS.ProcessEnv = { ...process.env }): JobCoordinator {
  const coordinator = new JobCoordinator({ environment: async () => ({ ...environment }) });
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
    const finished = await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.return_code).toBe(0);
  }, 15_000);

  it("cancels a process grandchild instead of stalling shutdown", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator();
    const parentScript = 'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"] }); setTimeout(() => {}, 30000);';
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", parentScript] });
    await waitFor(() => coordinator.get(cwd, submitted.job_id), (record) => record?.status === "running");

    const started = Date.now();
    await coordinator.cancel(cwd, submitted.job_id);
    await coordinator.shutdown();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await coordinator.get(cwd, submitted.job_id))?.status).toBe("cancelled");
  }, 20_000);

  it("builds a Windows taskkill command that includes the descendant tree", () => {
    expect(windowsTaskkillArgs(4321)).toEqual(["/pid", "4321", "/T", "/F"]);
  });

  it("restricts research surface jobs to an allowlisted environment while preserving Windows process essentials", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator({ PATH: process.env.PATH, HOME: "/tmp", USERPROFILE: "C:\\Users\\scientist", APPDATA: "C:\\Users\\scientist\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\scientist\\AppData\\Local", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".COM;.EXE;.BAT;.CMD", SECRET_TOKEN: "leak-me" });
    const submitted = await coordinator.submit(cwd, {
      command: [process.execPath, "-e", "console.log(JSON.stringify(process.env))"],
      surface: "research-loop",
      env: { PI_SCIENCE_OUTPUT_DIR: "/tmp/x" },
    });
    const finished = await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal);
    expect(finished?.status).toBe("succeeded");
    const childEnv = JSON.parse(finished?.stdout ?? "{}") as Record<string, string | undefined>;
    expect(childEnv.SECRET_TOKEN).toBeUndefined();
    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.HOME).toBe("/tmp");
    expect(childEnv.USERPROFILE).toBe("C:\\Users\\scientist");
    expect(childEnv.APPDATA).toBe("C:\\Users\\scientist\\AppData\\Roaming");
    expect(childEnv.LOCALAPPDATA).toBe("C:\\Users\\scientist\\AppData\\Local");
    expect(childEnv.SystemRoot).toBe("C:\\Windows");
    expect(childEnv.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(childEnv.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(childEnv.PI_SCIENCE_OUTPUT_DIR).toBe("/tmp/x");
  });

  it("keeps the full environment for non-research surfaces", async () => {
    const cwd = await workspace();
    const coordinator = jobCoordinator({ PATH: process.env.PATH, HOME: "/tmp", SECRET_TOKEN: "leak-me" });
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", "console.log(JSON.stringify(process.env))"], surface: "local" });
    const finished = await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal);
    expect(finished?.status).toBe("succeeded");
    const childEnv = JSON.parse(finished?.stdout ?? "{}") as Record<string, string | undefined>;
    expect(childEnv.SECRET_TOKEN).toBe("leak-me");
  });
});
