import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobCoordinator, type JobOwnership, type JobRecord, type JobStatus, restrictResearchEnvironment, windowsTaskkillArgs } from "./job-coordinator.js";

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

async function writeStoredJob(cwd: string, jobId: string, status: JobStatus, createdAt: string, stderr = "", ownership?: JobOwnership): Promise<void> {
  const record: JobRecord = { job_id: jobId, command: ["/bin/true"], cwd, surface: "local", status, created_at: createdAt, stdout: "", stderr, artifact_ids: [], environment: {}, requirement: {}, ...(ownership ? { ownership } : {}) };
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

async function linuxStartTicks(pid: number): Promise<string | null> {
  try {
    const value = (await readFile(`/proc/${pid}/stat`, "utf8")).trim();
    const commandStart = value.indexOf("("); const commandEnd = value.lastIndexOf(")");
    const fields = commandStart >= 1 && commandEnd > commandStart && /^\d+\s$/.test(value.slice(0, commandStart)) ? value.slice(commandEnd + 1).trim().split(/\s+/) : [];
    return fields[19] && /^\d+$/.test(fields[19]!) ? fields[19]! : null;
  } catch { return null; }
}

async function processExists(pid: number): Promise<boolean> { try { process.kill(pid, 0); return true; } catch { return false; } }

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

  it("preserves a healthy job owned by another coordinator beyond the legacy orphan grace", async () => {
    const cwd = await workspace();
    let now = 1_000;
    let releaseSpawn!: () => void;
    let enteredSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const gateEntered = new Promise<void>((resolve) => { enteredSpawn = resolve; });
    const owner = jobCoordinator(undefined, { now: () => now, leaseMs: 200, heartbeatMs: 25, beforeSpawn: async () => { enteredSpawn(); await spawnGate; } });
    const observer = jobCoordinator(undefined, { now: () => now, leaseMs: 200, heartbeatMs: 25 });
    const submitted = await owner.submit(cwd, { command: [process.execPath, "-e", "process.exit(0)"] });
    await gateEntered;
    now += 60_000;
    expect((await observer.get(cwd, submitted.job_id))?.status).toBe("running");
    expect(await observer.hasActive(cwd)).toBe(true);
    releaseSpawn();
    expect((await waitFor(() => observer.get(cwd, submitted.job_id), terminal))?.status).toBe("succeeded");
  });

  it("heals only an expired lease whose owner is no longer credibly active", async () => {
    const cwd = await workspace();
    const ownership: JobOwnership = { instance_id: "dead-owner", pid: 999_999, process_started_at: new Date(0).toISOString(), generation: 7, token: "dead-token", heartbeat_at: new Date(1_000).toISOString(), lease_expires_at: new Date(2_000).toISOString() };
    await writeStoredJob(cwd, "job_aaaaaaaaaaaaaaaa", "running", new Date(1_000).toISOString(), "", ownership);
    const observer = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => false });
    const healed = await observer.get(cwd, "job_aaaaaaaaaaaaaaaa");
    expect(healed?.status).toBe("failed");
    expect(healed?.stderr).toContain("owner lease expired");
    expect(healed?.stderr).toContain("dead-owner");
  });

  it("does not heal a valid lease or an expired lease with an unverifiably reused live PID", async () => {
    const cwd = await workspace();
    const valid: JobOwnership = { instance_id: "remote-owner", pid: 42, process_started_at: new Date(0).toISOString(), generation: 1, token: "valid-token", heartbeat_at: new Date(1_000).toISOString(), lease_expires_at: new Date(5_000).toISOString() };
    await writeStoredJob(cwd, "job_bbbbbbbbbbbbbbbb", "running", new Date(1_000).toISOString(), "", valid);
    const observer = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => false });
    expect((await observer.get(cwd, "job_bbbbbbbbbbbbbbbb"))?.status).toBe("running");
    const expired = { ...valid, token: "reused-token", lease_expires_at: new Date(2_000).toISOString() };
    await writeStoredJob(cwd, "job_cccccccccccccccc", "running", new Date(1_000).toISOString(), "", expired);
    const conservative = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => true });
    expect((await conservative.get(cwd, "job_cccccccccccccccc"))?.status).toBe("running");
  });

  it("fences a stale owner terminal write after another coordinator heals the job", async () => {
    const cwd = await workspace();
    let now = 1_000;
    let releaseTerminal!: () => void;
    let enteredTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const gateEntered = new Promise<void>((resolve) => { enteredTerminal = resolve; });
    const owner = jobCoordinator(undefined, { now: () => now, leaseMs: 10_000, heartbeatMs: 5_000, beforeTerminalSave: async () => { enteredTerminal(); await terminalGate; } });
    const submitted = await owner.submit(cwd, { command: [process.execPath, "-e", "process.stdout.write('stale-success')"] });
    await gateEntered;
    now += 20_000;
    const observer = jobCoordinator(undefined, { now: () => now, ownerProcessAlive: () => false });
    const ownership = (await observer.get(cwd, submitted.job_id))?.ownership;
    expect(ownership).toBeTruthy();
    // The in-process ownership token still proves the owner is live, so simulate
    // a replacement process by expiring the durable owner directly.
    if (ownership) ownership.token = "lost-owner-token";
    const path = join(cwd, ".pi-science", "jobs", `${submitted.job_id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as JobRecord;
    if (stored.ownership) stored.ownership.token = "lost-owner-token";
    await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    try { expect((await observer.get(cwd, submitted.job_id))?.status).toBe("failed"); }
    finally { releaseTerminal(); }
    await owner.shutdown();
    expect((await observer.get(cwd, submitted.job_id))?.status).toBe("failed");
  });

  it("starts one bounded heartbeat, extends the durable lease, and stops on completion", async () => {
    const cwd = await workspace();
    const started: string[] = []; const stopped: string[] = [];
    const coordinator = jobCoordinator(undefined, { leaseMs: 300, heartbeatMs: 25, onHeartbeatStarted: (id) => started.push(id), onHeartbeatStopped: (id) => stopped.push(id) });
    const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", "setTimeout(() => {}, 180)"] });
    const initialLease = Date.parse(submitted.ownership!.lease_expires_at);
    await waitFor(async () => {
      const stored = JSON.parse(await readFile(join(cwd, ".pi-science", "jobs", `${submitted.job_id}.json`), "utf8")) as JobRecord;
      return Date.parse(stored.ownership?.lease_expires_at ?? "") > initialLease;
    }, Boolean);
    expect((await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal))?.status).toBe("succeeded");
    expect(started).toEqual([submitted.job_id]);
    expect(stopped).toEqual([submitted.job_id]);
  });

  it("stops ownership heartbeats after cancel, timeout, and shutdown", async () => {
    const cwd = await workspace();
    for (const mode of ["cancel", "timeout", "shutdown"] as const) {
      const started: string[] = []; const stopped: string[] = [];
      const coordinator = jobCoordinator(undefined, { leaseMs: 200, heartbeatMs: 25, onHeartbeatStarted: (id) => started.push(id), onHeartbeatStopped: (id) => stopped.push(id) });
      const submitted = await coordinator.submit(cwd, { command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], ...(mode === "timeout" ? { requirement: { timeout_seconds: 1 } } : {}) });
      await waitFor(() => coordinator.get(cwd, submitted.job_id), (record) => record?.status === "running");
      if (mode === "cancel") await coordinator.cancel(cwd, submitted.job_id);
      if (mode === "shutdown") await coordinator.shutdown();
      else await waitFor(() => coordinator.get(cwd, submitted.job_id), terminal, 10_000);
      expect(started).toContain(submitted.job_id);
      await waitFor(async () => stopped.includes(submitted.job_id), Boolean);
      expect(stopped).toContain(submitted.job_id);
    }
  }, 20_000);

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

  it("terminates a locally owned child when another coordinator cancels after readiness", async () => {
    const cwd = await workspace();
    const ready = join(cwd, "cross-ready"); const delayed = join(cwd, "cross-delayed");
    const runner = jobCoordinator(undefined, { leaseMs: 300, heartbeatMs: 25 });
    const canceller = jobCoordinator();
    const script = `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)},"ready"); setTimeout(()=>fs.writeFileSync(${JSON.stringify(delayed)},"bad"),1000); setTimeout(()=>{},30000)`;
    const submitted = await runner.submit(cwd, { command: [process.execPath, "-e", script] });
    await waitFor(async () => stat(ready).then(() => true, () => false), Boolean);
    const started = Date.now();
    expect((await canceller.cancel(cwd, submitted.job_id))?.status).toBe("cancelled");
    expect((await waitFor(() => runner.get(cwd, submitted.job_id), terminal, 5_000))?.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(stat(delayed)).rejects.toThrow();
  }, 10_000);

  it("serializes final authorization, spawn registration, and cross-coordinator cancellation", async () => {
    const cwd = await workspace(); const delayed = join(cwd, "authorization-delayed");
    let entered!: () => void; let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const runner = jobCoordinator(undefined, { leaseMs: 300, heartbeatMs: 25, testBeforeAuthorizedSpawn: async () => { entered(); await releasePromise; } });
    const canceller = jobCoordinator();
    const submitted = await runner.submit(cwd, { command: [process.execPath, "-e", `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(delayed)},"bad"),1000); setTimeout(()=>{},30000)`] });
    await enteredPromise;
    const cancellation = canceller.cancel(cwd, submitted.job_id);
    release();
    expect((await cancellation)?.status).toBe("cancelled");
    expect((await waitFor(() => runner.get(cwd, submitted.job_id), terminal, 5_000))?.status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(stat(delayed)).rejects.toThrow();
  }, 10_000);

  it("reaps only a verified fenced orphan child identity", async () => {
    const cwd = await workspace();
    const ownership: JobOwnership = { instance_id: "dead-owner", pid: 999_999, process_started_at: new Date(0).toISOString(), generation: 4, token: "owner-token", heartbeat_at: new Date(1_000).toISOString(), lease_expires_at: new Date(2_000).toISOString(), child: { pid: 4567, process_identity: { kind: "linux-proc-start-ticks", value: "123" }, process_group: true, platform: "linux", ownership_generation: 4, ownership_token: "owner-token" } };
    await writeStoredJob(cwd, "job_dddddddddddddddd", "running", new Date(1_000).toISOString(), "", ownership);
    const reaped: number[] = [];
    const observer = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => false, reapChild: (identity) => { reaped.push(identity.pid); return "reaped"; } });
    const healed = await observer.get(cwd, "job_dddddddddddddddd");
    expect(healed?.status).toBe("failed"); expect(reaped).toEqual([4567]); expect(healed?.stderr).toContain("was reaped");
  });

  it("does not signal a reused or unverifiable orphan child identity", async () => {
    const cwd = await workspace();
    for (const [suffix, result] of [["eeeeeeeeeeeeeeee", "identity-mismatch"], ["ffffffffffffffff", "unverifiable"]] as const) {
      const token = `token-${suffix}`;
      const ownership: JobOwnership = { instance_id: "dead-owner", pid: 999_999, process_started_at: new Date(0).toISOString(), generation: 2, token, heartbeat_at: new Date(1_000).toISOString(), lease_expires_at: new Date(2_000).toISOString(), child: { pid: 7654, process_identity: { kind: "linux-proc-start-ticks", value: "123" }, process_group: true, platform: "linux", ownership_generation: 2, ownership_token: token } };
      await writeStoredJob(cwd, `job_${suffix}`, "running", new Date(1_000).toISOString(), "", ownership);
      const observer = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => false, reapChild: () => result });
      const healed = await observer.get(cwd, `job_${suffix}`);
      expect(healed?.status).toBe("failed"); expect(healed?.stderr).toMatch(result === "identity-mismatch" ? /was reused/ : /manual cleanup may be required/);
    }
  });

  it.skipIf(process.platform !== "linux")("reaps a real Linux process group only when proc start ticks and platform match", async () => {
    const cwd = await workspace();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    try {
      const ticks = await waitFor(() => linuxStartTicks(pid), Boolean);
      const token = "real-linux-token";
      const ownership: JobOwnership = { instance_id: "dead-owner", pid: 999_999, process_started_at: new Date(0).toISOString(), generation: 8, token, heartbeat_at: new Date(1_000).toISOString(), lease_expires_at: new Date(2_000).toISOString(), child: { pid, process_identity: { kind: "linux-proc-start-ticks", value: ticks! }, process_group: true, platform: "linux", ownership_generation: 8, ownership_token: token } };
      await writeStoredJob(cwd, "job_realreap00000000", "running", new Date(1_000).toISOString(), "", ownership);
      const observer = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => false });
      const healed = await observer.get(cwd, "job_realreap00000000");
      expect(healed?.status).toBe("failed"); expect(healed?.stderr).toContain("was reaped");
      await waitFor(() => processExists(pid), (alive) => !alive);
    } finally { try { process.kill(-pid, "SIGKILL"); } catch { /* already reaped */ } await waitFor(() => processExists(pid), (alive) => !alive).catch(() => undefined); }
  });

  it.skipIf(process.platform !== "linux")("leaves a real process alive for identity or platform mismatch and skips unfenced reaping", async () => {
    const cwd = await workspace();
    for (const [suffix, platform, identityValue] of [["realmismatch0000", "linux", "0"], ["platformmismatch", "darwin", "0"]] as const) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], { detached: true, stdio: "ignore" });
      const pid = child.pid!;
      try {
        const ticks = await waitFor(() => linuxStartTicks(pid), Boolean);
        const token = `token-${suffix}`;
        const ownership: JobOwnership = { instance_id: "dead-owner", pid: 999_999, process_started_at: new Date(0).toISOString(), generation: 9, token, heartbeat_at: new Date(1_000).toISOString(), lease_expires_at: new Date(2_000).toISOString(), child: { pid, process_identity: { kind: "linux-proc-start-ticks", value: identityValue === "0" && platform === "linux" ? `${ticks!}0` : ticks! }, process_group: true, platform, ownership_generation: 9, ownership_token: token } };
        await writeStoredJob(cwd, `job_${suffix}`, "running", new Date(1_000).toISOString(), "", ownership);
        const observer = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => false });
        const healed = await observer.get(cwd, `job_${suffix}`);
        expect(healed?.status).toBe("failed"); expect(await processExists(pid)).toBe(true);
      } finally { try { process.kill(-pid, "SIGKILL"); } catch { /* cleanup */ } await waitFor(() => processExists(pid), (alive) => !alive).catch(() => undefined); }
    }

    const token = "fence-token"; const reaped: number[] = [];
    const ownership: JobOwnership = { instance_id: "dead-owner", pid: 999_999, process_started_at: new Date(0).toISOString(), generation: 10, token, heartbeat_at: new Date(1_000).toISOString(), lease_expires_at: new Date(2_000).toISOString(), child: { pid: 4321, process_identity: { kind: "linux-proc-start-ticks", value: "123" }, process_group: true, platform: "linux", ownership_generation: 9, ownership_token: token } };
    await writeStoredJob(cwd, "job_fencemismatch000", "running", new Date(1_000).toISOString(), "", ownership);
    const observer = jobCoordinator(undefined, { now: () => 3_000, ownerProcessAlive: () => false, reapChild: (identity) => { reaped.push(identity.pid); return "reaped"; } });
    expect((await observer.get(cwd, "job_fencemismatch000"))?.status).toBe("failed"); expect(reaped).toEqual([]);
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
