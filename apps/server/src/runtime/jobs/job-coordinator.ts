import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { metadataRoot, readJson, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";
import { defaultPythonExecutable, WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export interface JobRequirement { cpu?: number; memory_mb?: number; gpu?: boolean; runtime?: string; packages?: string[]; timeout_seconds?: number; [key: string]: unknown }
export type JobProcessIdentity = { kind: "linux-proc-start-ticks"; value: string };
export type JobOwnerProcessIdentity = { kind: "linux-proc-start-ticks" | "ps-lstart-utc"; platform: NodeJS.Platform; value: string };
export interface JobChildIdentity { pid: number; process_identity: JobProcessIdentity | null; process_group: boolean; platform: NodeJS.Platform; ownership_generation: number; ownership_token: string }
export interface JobOwnership { instance_id: string; pid: number; process_started_at: string; process_identity?: JobOwnerProcessIdentity; generation: number; token: string; heartbeat_at: string; lease_expires_at: string; child?: JobChildIdentity }
export interface JobRecord { job_id: string; command: string[]; cwd: string; execution_cwd?: string; surface: string; status: JobStatus; created_at: string; started_at?: string; ended_at?: string; return_code?: number | null; stdout: string; stderr: string; artifact_ids: string[]; environment: Record<string, unknown>; requirement: JobRequirement; ownership?: JobOwnership }
export type PublicJobRecord = Omit<JobRecord, "ownership">;
export function publicJobRecord(record: JobRecord): PublicJobRecord { const { ownership: _ownership, ...publicRecord } = record; return publicRecord; }

const ORPHAN_GRACE_MS = 15_000;
const OWNERSHIP_LEASE_MS = 30_000;
const OWNERSHIP_HEARTBEAT_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const PROCESS_CLOSE_FAILSAFE_MS = 5_000;
const WINDOWS_EXIT_DRAIN_MS = 1_000;
const POSIX = process.platform !== "win32";
const RESEARCH_ENVIRONMENT_KEY_NAMES = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "USER", "LOGNAME", "SHELL", "VIRTUAL_ENV", "PYTHONNOUSERSITE", "PIP_REQUIRE_VIRTUALENV", "PIP_USER", "UV_PROJECT_ENVIRONMENT", "npm_config_prefix", "npm_config_cache", "npm_config_update_notifier", "PNPM_HOME", "COREPACK_HOME"] as const;
const RESEARCH_ENVIRONMENT_KEYS = new Map(RESEARCH_ENVIRONMENT_KEY_NAMES.map((key) => [key.toLowerCase(), key]));

export interface JobCoordinatorHooks { beforeSpawn?: (record: Readonly<JobRecord>) => Promise<void>; testBeforeAuthorizedSpawn?: (record: Readonly<JobRecord>) => Promise<void>; beforeTerminalSave?: (record: Readonly<JobRecord>) => Promise<void>; platform?: NodeJS.Platform; now?: () => number; leaseMs?: number; heartbeatMs?: number; ownerProcessAlive?: (pid: number, ownership: Readonly<JobOwnership>) => boolean; ownerProcessIdentity?: (pid: number, platform: NodeJS.Platform) => JobOwnerProcessIdentity | null; childStartIdentity?: (pid: number, platform: NodeJS.Platform) => JobProcessIdentity | null; reapChild?: (identity: Readonly<JobChildIdentity>) => "reaped" | "identity-mismatch" | "unverifiable" | "missing"; onHeartbeatStarted?: (jobId: string) => void; onHeartbeatStopped?: (jobId: string) => void }

const LIVE_JOB_OWNERS = new Set<string>();

export class JobCoordinator {
  private readonly children = new Map<string, ChildProcess>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly instanceId = `coordinator_${randomUUID()}`;
  private readonly processIdentity: JobOwnerProcessIdentity | null;
  private readonly processStartedAt: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly environments: Pick<WorkspaceEnvironmentService, "environment"> = new WorkspaceEnvironmentService(), private readonly hooks: JobCoordinatorHooks = {}) {
    const platform = hooks.platform ?? process.platform;
    this.processIdentity = hooks.ownerProcessIdentity ? hooks.ownerProcessIdentity(process.pid, platform) : ownerProcessIdentity(process.pid, platform);
    this.processStartedAt = this.processIdentity?.value ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
    this.now = hooks.now ?? Date.now;
    this.leaseMs = Math.max(100, hooks.leaseMs ?? OWNERSHIP_LEASE_MS);
    this.heartbeatMs = Math.max(25, Math.min(hooks.heartbeatMs ?? OWNERSHIP_HEARTBEAT_MS, Math.floor(this.leaseMs / 2)));
  }

  capabilities(requirement: JobRequirement) {
    const runtime = { node: process.execPath, python: defaultPythonExecutable(), r: null };
    const checks = { cpu: 1, memory_mb: null, gpu: Boolean(process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES), runtime, packages: {} };
    const reasons: string[] = [];
    if (Number(requirement.cpu ?? 1) > 1) reasons.push(`requires ${requirement.cpu} CPUs, host has 1`);
    if (requirement.gpu && !checks.gpu) reasons.push("GPU requested but no visible GPU was detected");
    if (requirement.runtime && requirement.runtime !== "any" && !(requirement.runtime in runtime)) reasons.push(`runtime not found: ${requirement.runtime}`);
    return { status: reasons.length ? "blocked" as const : "ready" as const, checks, reasons };
  }

  async submit(cwd: string, body: Record<string, unknown>): Promise<JobRecord> {
    const command = parseCommand(body.command);
    if (!command.length) throw new Error("command is empty");
    const requirement = (body.requirement && typeof body.requirement === "object" ? body.requirement : {}) as JobRequirement;
    const check = this.capabilities(requirement);
    if (check.status === "blocked") throw new Error(check.reasons.join("; "));
    const baseEnvironment = await this.environments.environment(cwd);
    const requestedEnvironment = body.env && typeof body.env === "object"
      ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>)
        .filter((entry): entry is [string, string] => /^PI_SCIENCE_[A-Z0-9_]+$/.test(entry[0]) && typeof entry[1] === "string"))
      : {};
    const surface = typeof body.surface === "string" ? body.surface : "local";
    const environment = { ...(surface.startsWith("research") ? restrictResearchEnvironment(baseEnvironment, this.hooks.platform ?? process.platform) : baseEnvironment), ...requestedEnvironment };
    const executionCwd = typeof body.execution_cwd === "string" ? resolve(body.execution_cwd) : resolve(cwd);
    const executionRelative = relative(resolve(cwd), executionCwd);
    if (isAbsolute(executionRelative) || executionRelative === ".." || executionRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("execution cwd escapes the workspace");
    const now = this.now();
    const ownership: JobOwnership = { instance_id: this.instanceId, pid: process.pid, process_started_at: this.processStartedAt, ...(this.processIdentity ? { process_identity: this.processIdentity } : {}), generation: 1, token: randomUUID(), heartbeat_at: new Date(now).toISOString(), lease_expires_at: new Date(now + this.leaseMs).toISOString() };
    const record: JobRecord = { job_id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`, command, cwd, ...(executionCwd !== resolve(cwd) ? { execution_cwd: executionCwd } : {}), surface, status: "pending", created_at: new Date(now).toISOString(), stdout: "", stderr: "", artifact_ids: [], environment: { platform: process.platform, node: process.version, virtual_env: environment.VIRTUAL_ENV, npm_prefix: environment.npm_config_prefix }, requirement, ownership };
    LIVE_JOB_OWNERS.add(ownership.token);
    try { await this.save(record); } catch (error) { LIVE_JOB_OWNERS.delete(ownership.token); throw error; }
    const task = this.run(record, environment);
    this.jobs.set(record.job_id, task);
    void task.catch(() => undefined).finally(() => { if (this.jobs.get(record.job_id) === task) this.jobs.delete(record.job_id); });
    return record;
  }

  async list(cwd: string, limit: number): Promise<JobRecord[]> {
    let names: string[];
    try { names = await readdir(this.jobsDir(cwd)); } catch { return []; }
    const records: JobRecord[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const record = await readJson<JobRecord | null>(join(this.jobsDir(cwd), name), null);
      if (record) records.push(await this.healOrphan(record));
    }
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  async hasActive(cwd: string): Promise<boolean> {
    return (await this.list(cwd, Number.MAX_SAFE_INTEGER)).some((record) => ["pending", "running"].includes(record.status));
  }

  async get(cwd: string, id: string): Promise<JobRecord | null> { const record = await readJson<JobRecord | null>(this.jobPath(cwd, id), null); return record ? this.healOrphan(record) : null; }
  async logs(cwd: string, id: string) { const record = await this.get(cwd, id); return record ? { job_id: record.job_id, stdout: record.stdout, stderr: record.stderr } : null; }
  async cancel(cwd: string, id: string): Promise<JobRecord | null> {
    this.cancelled.add(id);
    const child = this.children.get(id);
    if (child) terminate(child);
    const path = this.jobPath(cwd, id);
    return withFileWriteLock(path, async () => {
      const record = await readJson<JobRecord | null>(path, null);
      if (!record) { this.cancelled.delete(id); return null; }
      if (isTerminal(record.status)) { if (record.status !== "cancelled") this.cancelled.delete(id); return record; }
      if (!child && record.ownership?.child) {
        const cleanup = this.reapOrphanChild(record.ownership);
        const note = `cancellation cleanup: ${cleanup}`;
        record.stderr = record.stderr ? `${record.stderr}\n${note}` : note;
      }
      record.status = "cancelled"; record.ended_at = new Date(this.now()).toISOString(); await writeJsonAtomic(path, record);
      return record;
    });
  }
  async shutdown(): Promise<void> {
    for (const child of this.children.values()) terminate(child);
    await Promise.allSettled([...this.jobs.values()]);
    for (const id of [...this.heartbeats.keys()]) this.stopHeartbeat(id);
  }

  private jobsDir(cwd: string) { return join(metadataRoot(cwd), "jobs"); }
  private jobPath(cwd: string, id: string) { if (!/^job_[A-Za-z0-9]{16}$/.test(id)) throw new Error("Invalid job id"); const root = resolve(this.jobsDir(cwd)); const target = resolve(root, `${id}.json`); const rel = relative(root, target); if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Job path escapes the workspace"); return target; }
  private async save(record: JobRecord) { await writeJsonAtomic(this.jobPath(record.cwd, record.job_id), record); }
  private ownershipMatches(left: JobOwnership | undefined, right: JobOwnership | undefined): boolean { return Boolean(left && right && left.instance_id === right.instance_id && left.generation === right.generation && left.token === right.token); }
  private ownerCrediblyAlive(ownership: JobOwnership): boolean {
    if (LIVE_JOB_OWNERS.has(ownership.token)) return true;
    if (this.hooks.ownerProcessAlive) return this.hooks.ownerProcessAlive(ownership.pid, ownership);
    if (ownership.pid === process.pid) return false;
    try {
      process.kill(ownership.pid, 0);
      const expected = ownership.process_identity;
      if (!expected) return true;
      const platform = this.hooks.platform ?? process.platform;
      if (expected.platform !== platform) return true;
      const identity = this.hooks.ownerProcessIdentity ? this.hooks.ownerProcessIdentity(ownership.pid, platform) : ownerProcessIdentity(ownership.pid, platform);
      return !identity || identity.kind !== expected.kind || identity.platform !== expected.platform ? true : identity.value === expected.value;
    } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }
  private reapOrphanChild(ownership: JobOwnership): string {
    if (!ownership.child) return "no persisted child identity was available; no process was signalled";
    if (ownership.child.ownership_generation !== ownership.generation || ownership.child.ownership_token !== ownership.token) return "persisted child identity failed ownership fencing; no process was signalled";
    const result = this.hooks.reapChild?.(ownership.child) ?? reapPersistedChild(ownership.child, this.hooks.platform ?? process.platform);
    if (result === "reaped") return `verified orphan child/process group ${ownership.child.pid} was reaped`;
    if (result === "missing") return `persisted orphan child ${ownership.child.pid} was already gone`;
    if (result === "identity-mismatch") return `persisted child PID ${ownership.child.pid} was reused; no process was signalled`;
    return `child identity for PID ${ownership.child.pid} could not be verified on ${ownership.child.platform}; no process was signalled and manual cleanup may be required`;
  }
  private async healOrphan(record: JobRecord): Promise<JobRecord> {
    if (!isNonterminal(record.status) || this.jobs.has(record.job_id)) return record;
    const path = this.jobPath(record.cwd, record.job_id);
    return withFileWriteLock(path, async () => {
      const current = await readJson<JobRecord | null>(path, null);
      if (!current || !isNonterminal(current.status) || this.jobs.has(current.job_id)) return current ?? record;
      const now = this.now();
      if (!current.ownership) {
        if (now - Date.parse(current.created_at) < ORPHAN_GRACE_MS) return current;
      } else {
        if (Date.parse(current.ownership.lease_expires_at) > now || this.ownerCrediblyAlive(current.ownership)) return current;
      }
      const note = current.ownership ? `job owner lease expired and owner process is no longer active (${current.ownership.instance_id}); ${this.reapOrphanChild(current.ownership)}` : "job was orphaned by a server restart";
      current.status = "failed"; current.return_code = null; current.ended_at = new Date(now).toISOString();
      current.stderr = current.stderr ? `${current.stderr}\n${note}` : note;
      await writeJsonAtomic(path, current);
      return current;
    });
  }
  private startHeartbeat(record: JobRecord): void {
    if (!record.ownership || this.heartbeats.has(record.job_id)) return;
    const refresh = async () => {
      const ownership = record.ownership;
      if (!ownership) return;
      const path = this.jobPath(record.cwd, record.job_id);
      await withFileWriteLock(path, async () => {
        const current = await readJson<JobRecord | null>(path, null);
        if (!current || !isNonterminal(current.status) || !this.ownershipMatches(current.ownership, ownership)) {
          if (current?.status === "cancelled") { const child = this.children.get(record.job_id); if (child) terminate(child); }
          this.stopHeartbeat(record.job_id); return;
        }
        const now = this.now();
        current.ownership = { ...ownership, heartbeat_at: new Date(now).toISOString(), lease_expires_at: new Date(now + this.leaseMs).toISOString() };
        record.ownership = current.ownership;
        await writeJsonAtomic(path, current);
      });
    };
    let refreshing = false;
    const timer = setInterval(() => { if (refreshing) return; refreshing = true; void refresh().catch(() => undefined).finally(() => { refreshing = false; }); }, this.heartbeatMs);
    timer.unref(); this.heartbeats.set(record.job_id, timer); this.hooks.onHeartbeatStarted?.(record.job_id);
  }
  private stopHeartbeat(id: string): void {
    const timer = this.heartbeats.get(id); if (!timer) return;
    clearInterval(timer); this.heartbeats.delete(id); this.hooks.onHeartbeatStopped?.(id);
  }
  private async run(record: JobRecord, environment: NodeJS.ProcessEnv): Promise<void> {
    const path = this.jobPath(record.cwd, record.job_id);
    if (this.cancelled.has(record.job_id)) { record.status = "cancelled"; record.ended_at = new Date(this.now()).toISOString(); await this.save(record); this.cancelled.delete(record.job_id); LIVE_JOB_OWNERS.delete(record.ownership?.token ?? ""); return; }
    let enteredRunning = false;
    try { enteredRunning = await withFileWriteLock(path, async () => {
      const current = await readJson<JobRecord | null>(path, null);
      if (!current || isTerminal(current.status) || !this.ownershipMatches(current.ownership, record.ownership)) { if (current) Object.assign(record, current); return false; }
      current.status = "running"; current.started_at = new Date(this.now()).toISOString(); Object.assign(record, current); await writeJsonAtomic(path, current); return true;
    }); } catch (error) { LIVE_JOB_OWNERS.delete(record.ownership?.token ?? ""); throw error; }
    if (!enteredRunning) { LIVE_JOB_OWNERS.delete(record.ownership?.token ?? ""); return; }
    this.startHeartbeat(record);
    let child: ChildProcess | undefined; let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let timedOut = false; let childResult: Promise<{ code: number | null }> | undefined;
    const appendTail = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk]).subarray(-100_000);
    try {
      await this.hooks.beforeSpawn?.(record);
      if (this.cancelled.has(record.job_id)) { record.status = "cancelled"; return; }
      const spawned = await withFileWriteLock(path, async () => {
        const current = await readJson<JobRecord | null>(path, null);
        if (!current || isTerminal(current.status) || !this.ownershipMatches(current.ownership, record.ownership)) { if (current) Object.assign(record, current); return false; }
        // Test-only deterministic barrier. Production callers cannot inject work
        // into this spawn-authorization critical section.
        await this.hooks.testBeforeAuthorizedSpawn?.(record);
        // spawn() returns synchronously. Authorization, process creation, durable
        // child identity and local registration therefore share one per-job
        // critical section; another coordinator cannot cancel between them.
        child = spawn(record.command[0]!, record.command.slice(1), { cwd: record.execution_cwd ?? record.cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: POSIX });
        this.children.set(record.job_id, child);
        child.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
        const timeout = Math.max(1, Number(record.requirement.timeout_seconds ?? 3600)) * 1000;
        childResult = new Promise<{ code: number | null }>((done) => {
          let timeoutTimer: NodeJS.Timeout | undefined; let closeFailsafe: NodeJS.Timeout | undefined; let settled = false;
          const finish = (code: number | null) => { if (settled) return; settled = true; if (timeoutTimer) clearTimeout(timeoutTimer); if (closeFailsafe) clearTimeout(closeFailsafe); done({ code }); };
          child!.once("close", (code) => finish(code));
          child!.once("exit", (code) => { if (!POSIX && !timedOut && !settled) { closeFailsafe = setTimeout(() => finish(code), WINDOWS_EXIT_DRAIN_MS); closeFailsafe.unref(); } });
          timeoutTimer = setTimeout(() => { timedOut = true; terminate(child!); closeFailsafe = setTimeout(() => finish(null), PROCESS_CLOSE_FAILSAFE_MS); closeFailsafe.unref(); }, timeout);
        });
        const platform = this.hooks.platform ?? process.platform;
        const childIdentity: JobChildIdentity = { pid: child.pid!, process_identity: this.hooks.childStartIdentity?.(child.pid!, platform) ?? childProcessIdentity(child.pid!, platform), process_group: platform !== "win32", platform, ownership_generation: current.ownership!.generation, ownership_token: current.ownership!.token };
        current.ownership = { ...current.ownership!, child: childIdentity };
        record.ownership = current.ownership;
        await writeJsonAtomic(path, current);
        return true;
      });
      if (!spawned || !child || !childResult) return;
      if (this.cancelled.has(record.job_id)) terminate(child);
      const result = await childResult;
      record.stdout = stdout.toString("utf8"); record.stderr = stderr.toString("utf8"); record.return_code = result.code;
      record.status = this.cancelled.has(record.job_id) ? "cancelled" : timedOut ? "timed_out" : result.code === 0 ? "succeeded" : "failed";
    } catch (error) { if (child) terminate(child); if (!this.cancelled.has(record.job_id)) { record.status = "failed"; record.stderr = String(error).slice(-100_000); } }
    finally {
      this.stopHeartbeat(record.job_id); LIVE_JOB_OWNERS.delete(record.ownership?.token ?? "");
      record.ended_at = new Date(this.now()).toISOString(); this.children.delete(record.job_id);
      await this.hooks.beforeTerminalSave?.(record);
      await withFileWriteLock(path, async () => {
        const current = await readJson<JobRecord | null>(path, null);
        const terminal = current && isTerminal(current.status);
        const ownsCurrent = this.ownershipMatches(current?.ownership, record.ownership);
        const durable = current?.status === "cancelled"
          ? { ...record, status: "cancelled" as const, ended_at: current.ended_at ?? record.ended_at, ownership: current.ownership, stderr: mergeDiagnosticText(record.stderr, current.stderr) }
          : terminal || !ownsCurrent ? current ?? record : record;
        await writeJsonAtomic(path, durable);
        Object.assign(record, durable);
      });
      this.cancelled.delete(record.job_id);
    }
  }
}

/** Asks the whole job process group to stop, then forces it after a short grace. */
function terminate(child: ChildProcess): void {
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL"); }, KILL_GRACE_MS);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

export function windowsTaskkillArgs(pid: number): string[] { return ["/pid", String(pid), "/T", "/F"]; }

function isTerminal(status: JobStatus): boolean { return ["succeeded", "failed", "cancelled", "timed_out"].includes(status); }
function isNonterminal(status: JobStatus): boolean { return status === "pending" || status === "running"; }
function mergeDiagnosticText(runner: string, durable: string): string {
  if (!runner) return durable;
  if (!durable || runner === durable || runner.includes(durable)) return runner;
  if (durable.includes(runner)) return durable;
  return `${runner}\n${durable}`;
}

function ownerProcessIdentity(pid: number, platform: NodeJS.Platform): JobOwnerProcessIdentity | null {
  const linux = childProcessIdentity(pid, platform);
  if (linux) return { ...linux, platform };
  if (platform === "win32") return null;
  const result = spawnSync("ps", ["-ww", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", windowsHide: true, env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value ? { kind: "ps-lstart-utc", platform, value } : null;
}

function childProcessIdentity(pid: number, platform: NodeJS.Platform): JobProcessIdentity | null {
  if (platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const commandStart = stat.indexOf("("); const commandEnd = stat.lastIndexOf(")");
    if (commandStart < 1 || commandEnd <= commandStart || !/^\d+\s$/.test(stat.slice(0, commandStart))) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19]; // field 22; field 3 is index 0 here
    return startTicks && /^\d+$/.test(startTicks) ? { kind: "linux-proc-start-ticks", value: startTicks } : null;
  } catch { return null; }
}

function reapPersistedChild(identity: JobChildIdentity, platform: NodeJS.Platform): "reaped" | "identity-mismatch" | "unverifiable" | "missing" {
  try { process.kill(identity.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unverifiable"; }
  if (platform !== identity.platform || platform !== "linux" || identity.process_identity?.kind !== "linux-proc-start-ticks") return "unverifiable";
  const current = childProcessIdentity(identity.pid, platform);
  if (!current || current.kind !== identity.process_identity.kind || current.value !== identity.process_identity.value) return "identity-mismatch";
  try { process.kill(identity.process_group ? -identity.pid : identity.pid, "SIGKILL"); return "reaped"; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unverifiable"; }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (POSIX && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* the group is already gone or was never created */ }
  }
  if (!POSIX && child.pid) {
    const killer = spawn("taskkill", windowsTaskkillArgs(child.pid), { stdio: "ignore", windowsHide: true });
    killer.once("error", () => child.kill(signal));
    return;
  }
  child.kill(signal);
}

export function restrictResearchEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const restricted: NodeJS.ProcessEnv = {};
  for (const key of RESEARCH_ENVIRONMENT_KEY_NAMES) if (environment[key] !== undefined) restricted[key] = environment[key];
  if (platform !== "win32") return restricted;
  for (const [key, value] of Object.entries(environment)) {
    const canonical = RESEARCH_ENVIRONMENT_KEYS.get(key.toLowerCase());
    if (canonical && value !== undefined && restricted[canonical] === undefined) restricted[canonical] = value;
  }
  return restricted;
}

export function parseCommand(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return [];
  const tokens: string[] = []; const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of value.matchAll(pattern)) tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\([\\"'])/g, "$1"));
  return tokens;
}
