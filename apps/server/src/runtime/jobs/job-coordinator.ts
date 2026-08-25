import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { metadataRoot, readJson, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";
import type { JobRepository } from "../../storage/sqlite/repositories/job-repository.js";
import { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { executionIdFor, executionRepository, type ExecutionRepository } from "../executions/execution-repository.js";
import { detectJobCapabilities } from "./job-capabilities.js";
import { restrictLocalJobEnvironment, restrictResearchEnvironment } from "./job-environment.js";
import { JobLeaseManager } from "./job-lease-manager.js";
import { ProcessSupervisor, type SpawnedJobProcess } from "./job-process-supervisor.js";
import { isNonterminal, isTerminal, transitionJobStatus, type JobChildIdentity, type JobOwnerProcessIdentity, type JobOwnership, type JobProcessIdentity, type JobRecord, type JobRequirement, type JobStatus, publicJobRecord } from "./job-types.js";

export type { JobChildIdentity, JobOwnerProcessIdentity, JobOwnership, JobProcessIdentity, JobRecord, JobRequirement, JobStatus, PublicJobRecord } from "./job-types.js";
export { publicJobRecord, isNonterminal, isTerminal, transitionJobStatus } from "./job-types.js";
export { restrictLocalJobEnvironment, restrictResearchEnvironment } from "./job-environment.js";
export { windowsTaskkillArgs } from "./job-process-supervisor.js";

export interface JobCoordinatorHooks { beforeSpawn?: (record: Readonly<JobRecord>) => Promise<void>; testBeforeAuthorizedSpawn?: (record: Readonly<JobRecord>) => Promise<void>; beforeTerminalSave?: (record: Readonly<JobRecord>) => Promise<void>; platform?: NodeJS.Platform; now?: () => number; leaseMs?: number; heartbeatMs?: number; ownerProcessAlive?: (pid: number, ownership: Readonly<JobOwnership>) => boolean; ownerProcessIdentity?: (pid: number, platform: NodeJS.Platform) => JobOwnerProcessIdentity | null; childStartIdentity?: (pid: number, platform: NodeJS.Platform) => JobProcessIdentity | null; reapChild?: (identity: Readonly<JobChildIdentity>) => "reaped" | "identity-mismatch" | "unverifiable" | "missing"; onHeartbeatStarted?: (jobId: string) => void; onHeartbeatStopped?: (jobId: string) => void }

export class JobCoordinator {
  private readonly processes: ProcessSupervisor;
  private readonly leases: JobLeaseManager;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly environments: Pick<WorkspaceEnvironmentService, "environment"> = new WorkspaceEnvironmentService(), private readonly hooks: JobCoordinatorHooks = {}, private readonly executions: Pick<ExecutionRepository, "start" | "finish"> = executionRepository, private readonly repository?: JobRepository) {
    this.now = hooks.now ?? Date.now;
    this.processes = new ProcessSupervisor({ platform: hooks.platform, childStartIdentity: hooks.childStartIdentity });
    this.leases = new JobLeaseManager({ ...hooks, stopChild: (jobId) => this.processes.terminate(jobId) });
  }

  capabilities(requirement: JobRequirement) { return detectJobCapabilities(requirement); }

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
    const platform = this.hooks.platform ?? process.platform;
    const environment = { ...(surface.startsWith("research") ? restrictResearchEnvironment(baseEnvironment, platform) : restrictLocalJobEnvironment(baseEnvironment, platform)), ...requestedEnvironment };
    const executionCwd = typeof body.execution_cwd === "string" ? resolve(body.execution_cwd) : resolve(cwd);
    const executionRelative = relative(resolve(cwd), executionCwd);
    if (isAbsolute(executionRelative) || executionRelative === ".." || executionRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("execution cwd escapes the workspace");
    const now = this.now();
    const ownership = this.leases.createOwnership(now);
    const jobId = `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const executionId = executionIdFor("job", resolve(cwd), jobId);
    const record: JobRecord = { job_id: jobId, execution_id: executionId, command, cwd, ...(executionCwd !== resolve(cwd) ? { execution_cwd: executionCwd } : {}), surface, status: "pending", created_at: new Date(now).toISOString(), stdout: "", stderr: "", artifact_ids: [], environment: { platform: process.platform, node: process.version, prefix: environment.PI_SCIENCE_ENVIRONMENT_PREFIX, npm_prefix: environment.npm_config_prefix }, requirement, ownership };
    await this.executions.start(cwd, {
      execution_id: executionId,
      kind: "job",
      surface: executionSurface(surface),
      producer: "node-job-coordinator",
      created_at: record.created_at,
      correlation: correlationFrom(body, jobId),
      request: { command: redactCommand(command), cwd: record.execution_cwd ?? record.cwd, requirement },
      runtime: record.environment,
    });
    try { await this.save(record); } catch (error) {
      this.leases.release(ownership);
      await this.executions.finish(cwd, executionId, { status: "failed", producer: "node-job-coordinator", result: { error: String(error) } }).catch(() => undefined);
      throw error;
    }
    const task = this.run(record, environment);
    this.jobs.set(record.job_id, task);
    void task.catch(() => undefined).finally(() => { if (this.jobs.get(record.job_id) === task) this.jobs.delete(record.job_id); });
    return record;
  }

  async list(cwd: string, limit: number): Promise<JobRecord[]> {
    if (this.repository) {
      const records = await this.repository.list(cwd, limit);
      return Promise.all(records.map((record) => this.healOrphan(record)));
    }
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

  async get(cwd: string, id: string): Promise<JobRecord | null> {
    if (this.repository) { const record = await this.repository.get(cwd, id); return record ? this.healOrphan(record) : null; }
    const record = await readJson<JobRecord | null>(this.jobPath(cwd, id), null); return record ? this.healOrphan(record) : null;
  }
  async logs(cwd: string, id: string) { const record = await this.get(cwd, id); return record ? { job_id: record.job_id, stdout: record.stdout, stderr: record.stderr, stdout_truncated: record.stdout_truncated === true, stderr_truncated: record.stderr_truncated === true } : null; }
  async cancel(cwd: string, id: string): Promise<JobRecord | null> {
    this.cancelled.add(id);
    const child = this.processes.get(id);
    if (child) this.processes.terminate(child);
    if (this.repository) {
      const cancelled = await this.repository.locked(id, async () => {
        const current = await this.repository!.get(cwd, id);
        if (!current) { this.cancelled.delete(id); return null; }
        if (isTerminal(current.status)) { if (current.status !== "cancelled") this.cancelled.delete(id); return current; }
        const diagnostic = !child && current.status === "running"
          ? `cancellation cleanup: ${current.ownership?.child ? this.reapOrphanChild(current.ownership) : "no persisted child identity was available; no process was signalled"}`
          : undefined;
        return this.repository!.cancel(cwd, id, this.now(), diagnostic);
      });
      if (cancelled) await this.finishExecution(cancelled);
      return cancelled;
    }
    const path = this.jobPath(cwd, id);
    const cancelled = await withFileWriteLock(path, async () => {
      const record = await readJson<JobRecord | null>(path, null);
      if (!record) { this.cancelled.delete(id); return null; }
      if (isTerminal(record.status)) { if (record.status !== "cancelled") this.cancelled.delete(id); return record; }
      if (!child && record.status === "running") {
        const cleanup = record.ownership?.child ? this.reapOrphanChild(record.ownership) : "no persisted child identity was available; no process was signalled";
        const note = `cancellation cleanup: ${cleanup}`;
        record.stderr = record.stderr ? `${record.stderr}\n${note}` : note;
      }
      Object.assign(record, transitionJobStatus(record, "cancelled")); record.ended_at = new Date(this.now()).toISOString(); await writeJsonAtomic(path, record);
      return record;
    });
    if (cancelled) await this.finishExecution(cancelled);
    return cancelled;
  }
  async shutdown(): Promise<void> {
    await this.processes.shutdown();
    await Promise.allSettled([...this.jobs.values()]);
    this.leases.stopAllHeartbeats();
  }

  private jobsDir(cwd: string) { return join(metadataRoot(cwd), "jobs"); }
  private jobPath(cwd: string, id: string) { if (!/^job_[A-Za-z0-9]{16}$/.test(id)) throw new Error("Invalid job id"); const root = resolve(this.jobsDir(cwd)); const target = resolve(root, `${id}.json`); const rel = relative(root, target); if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Job path escapes the workspace"); return target; }
  private async save(record: JobRecord) {
    if (this.repository) { await this.repository.save(record); return; }
    await writeJsonAtomic(this.jobPath(record.cwd, record.job_id), record);
  }
  private async readCurrent(record: JobRecord): Promise<JobRecord | null> {
    if (this.repository) return this.repository.get(record.cwd, record.job_id);
    return readJson<JobRecord | null>(this.jobPath(record.cwd, record.job_id), null);
  }
  private async persistHeartbeat(record: JobRecord, ownership: JobOwnership, now: number): Promise<JobRecord | null> {
    if (this.repository) return this.repository.heartbeat(record, ownership, now);
    const path = this.jobPath(record.cwd, record.job_id);
    return withFileWriteLock(path, async () => {
      const current = await readJson<JobRecord | null>(path, null);
      if (!current || !isNonterminal(current.status) || !this.ownershipMatches(current.ownership, ownership)) return current;
      current.ownership = { ...ownership, heartbeat_at: new Date(now).toISOString(), lease_expires_at: new Date(now + Math.max(100, Date.parse(ownership.lease_expires_at) - Date.parse(ownership.heartbeat_at))).toISOString() };
      await writeJsonAtomic(path, current);
      return current;
    });
  }
  private ownershipMatches(left: JobOwnership | undefined, right: JobOwnership | undefined): boolean { return this.leases.matches(left, right); }
  private reapOrphanChild(ownership: JobOwnership): string {
    if (!ownership.child) return "no persisted child identity was available; no process was signalled";
    if (ownership.child.ownership_generation !== ownership.generation || ownership.child.ownership_token !== ownership.token) return "persisted child identity failed ownership fencing; no process was signalled";
    const result = this.hooks.reapChild?.(ownership.child) ?? this.processes.reap(ownership.child);
    if (result === "reaped") return `verified orphan child/process group ${ownership.child.pid} was reaped`;
    if (result === "missing") return `persisted orphan child ${ownership.child.pid} was already gone`;
    if (result === "identity-mismatch") return `persisted child PID ${ownership.child.pid} was reused; no process was signalled`;
    return `child identity for PID ${ownership.child.pid} could not be verified on ${ownership.child.platform}; no process was signalled and manual cleanup may be required`;
  }
  private async healOrphan(record: JobRecord): Promise<JobRecord> {
    if (!isNonterminal(record.status) || this.jobs.has(record.job_id)) return record;
    if (this.repository) {
      const now = this.now();
      if (!this.leases.shouldHeal(record, now)) return record;
      const note = this.leases.orphanDiagnostic(record, (ownership) => this.reapOrphanChild(ownership));
      const healed = await this.repository.heal(record, now, note);
      if (healed && isTerminal(healed.status)) await this.finishExecution(healed);
      return healed ?? record;
    }
    const path = this.jobPath(record.cwd, record.job_id);
    const healed = await withFileWriteLock(path, async () => {
      const current = await readJson<JobRecord | null>(path, null);
      if (!current || !isNonterminal(current.status) || this.jobs.has(current.job_id)) return current ?? record;
      const now = this.now();
      if (!this.leases.shouldHeal(current, now)) return current;
      const note = this.leases.orphanDiagnostic(current, (ownership) => this.reapOrphanChild(ownership));
      Object.assign(current, transitionJobStatus(current, "failed")); current.return_code = null; current.ended_at = new Date(now).toISOString();
      current.stderr = current.stderr ? `${current.stderr}\n${note}` : note;
      await writeJsonAtomic(path, current);
      return current;
    });
    if (isTerminal(healed.status)) await this.finishExecution(healed);
    return healed;
  }
  private async run(record: JobRecord, environment: NodeJS.ProcessEnv): Promise<void> {
    const path = this.jobPath(record.cwd, record.job_id);
    if (this.cancelled.has(record.job_id)) {
      const cancelled = this.repository
        ? await this.repository.cancel(record.cwd, record.job_id, this.now())
        : (Object.assign(record, transitionJobStatus(record, "cancelled")), record.ended_at = new Date(this.now()).toISOString(), await this.save(record), record);
      if (cancelled) Object.assign(record, cancelled);
      await this.finishExecution(record);
      this.cancelled.delete(record.job_id); this.leases.release(record.ownership); return;
    }
    let enteredRunning = false;
    try {
      if (this.repository) {
        const current = await this.repository.transitionToRunning(record, this.now());
        if (!current || isTerminal(current.status) || !this.ownershipMatches(current.ownership, record.ownership)) {
          if (current) Object.assign(record, current);
          enteredRunning = false;
        } else {
          Object.assign(record, current);
          enteredRunning = true;
        }
      } else enteredRunning = await withFileWriteLock(path, async () => {
      const current = await readJson<JobRecord | null>(path, null);
      if (!current || isTerminal(current.status) || !this.ownershipMatches(current.ownership, record.ownership)) { if (current) Object.assign(record, current); return false; }
      Object.assign(current, transitionJobStatus(current, "running")); current.started_at = new Date(this.now()).toISOString(); Object.assign(record, current); await writeJsonAtomic(path, current); return true;
      });
    } catch (error) { this.leases.release(record.ownership); throw error; }
    if (!enteredRunning) { this.leases.release(record.ownership); return; }
    this.leases.startHeartbeat(record, (current) => this.readCurrent(current), (current, ownership, now) => this.persistHeartbeat(current, ownership, now));
    let child: ChildProcess | undefined;
    let spawnedProcess: SpawnedJobProcess | undefined;
    try {
      await this.hooks.beforeSpawn?.(record);
      if (this.cancelled.has(record.job_id)) { Object.assign(record, transitionJobStatus(record, "cancelled")); return; }
      const spawned = this.repository
        ? await this.repository.locked(record.job_id, async () => {
          const current = await this.repository!.get(record.cwd, record.job_id);
          if (!current || isTerminal(current.status) || !this.ownershipMatches(current.ownership, record.ownership)) { if (current) Object.assign(record, current); return false; }
          await this.hooks.testBeforeAuthorizedSpawn?.(record);
          if (this.cancelled.has(record.job_id)) { Object.assign(record, transitionJobStatus(record, "cancelled")); return false; }
          spawnedProcess = this.processes.spawn(record.job_id, record.command, record.execution_cwd ?? record.cwd, environment, Math.max(1, Number(record.requirement.timeout_seconds ?? 3600)) * 1000);
          child = spawnedProcess.child;
          const updatedOwnership = { ...current.ownership!, child: { ...spawnedProcess.identity, ownership_generation: current.ownership!.generation, ownership_token: current.ownership!.token } };
          record.ownership = updatedOwnership;
          const durable = await this.repository!.setChild(record, updatedOwnership, this.now());
          if (!durable || durable.status === "cancelled" || !this.ownershipMatches(durable.ownership, updatedOwnership)) {
            this.processes.terminate(child);
            if (durable) Object.assign(record, durable);
            return false;
          }
          Object.assign(record, durable);
          return true;
        })
        : await withFileWriteLock(path, async () => {
          const current = await readJson<JobRecord | null>(path, null);
          if (!current || isTerminal(current.status) || !this.ownershipMatches(current.ownership, record.ownership)) { if (current) Object.assign(record, current); return false; }
          // Test-only deterministic barrier. Production callers cannot inject work
          // into this spawn-authorization critical section.
          await this.hooks.testBeforeAuthorizedSpawn?.(record);
          // spawn() returns synchronously. Authorization, process creation, durable
          // child identity and local registration therefore share one per-job
          // critical section; another coordinator cannot cancel between them.
          spawnedProcess = this.processes.spawn(record.job_id, record.command, record.execution_cwd ?? record.cwd, environment, Math.max(1, Number(record.requirement.timeout_seconds ?? 3600)) * 1000);
          child = spawnedProcess.child;
          current.ownership = { ...current.ownership!, child: { ...spawnedProcess.identity, ownership_generation: current.ownership!.generation, ownership_token: current.ownership!.token } };
          record.ownership = current.ownership;
          await writeJsonAtomic(path, current);
          return true;
        });
      if (!spawned || !child || !spawnedProcess) return;
      if (this.cancelled.has(record.job_id)) this.processes.terminate(child);
      const result = await spawnedProcess.result;
      record.stdout = result.stdout;
      record.stderr = result.stderr;
      record.stdout_truncated = result.stdout_truncated;
      record.stderr_truncated = result.stderr_truncated;
      record.return_code = result.code;
      const nextStatus = this.cancelled.has(record.job_id) ? "cancelled" : result.timed_out ? "timed_out" : result.code === 0 ? "succeeded" : "failed";
      Object.assign(record, transitionJobStatus(record, nextStatus));
    } catch (error) { if (child) this.processes.terminate(child); if (!this.cancelled.has(record.job_id)) { Object.assign(record, transitionJobStatus(record, "failed")); record.stderr = String(error).slice(-100_000); } }
    finally {
      // Keep the in-process ownership proof until the terminal state is
      // durably written. Otherwise another coordinator can observe the still
      // running record in the small window after the child exits, conclude
      // that its expired lease is orphaned, and fence a healthy completion.
      this.leases.stopHeartbeat(record.job_id);
      record.ended_at = new Date(this.now()).toISOString(); this.processes.forget(record.job_id);
      try {
        await this.hooks.beforeTerminalSave?.(record);
        if (this.repository) {
          await this.repository.locked(record.job_id, async () => {
            const current = await this.repository!.getById(record.job_id);
            const terminal = current && isTerminal(current.status);
            const ownsCurrent = this.ownershipMatches(current?.ownership, record.ownership);
            const durable = current?.status === "cancelled"
              ? await this.repository!.updateCancelledDiagnostic({ ...record, status: "cancelled", ended_at: current.ended_at ?? record.ended_at, ownership: current.ownership, stderr: mergeDiagnosticText(record.stderr, current.stderr) }, this.now())
              : terminal || !ownsCurrent ? current ?? record : await this.repository!.saveTerminal(record, this.now());
            Object.assign(record, durable ?? current ?? record);
          });
        } else await withFileWriteLock(path, async () => {
          const current = await readJson<JobRecord | null>(path, null);
          const terminal = current && isTerminal(current.status);
          const ownsCurrent = this.ownershipMatches(current?.ownership, record.ownership);
          const durable = current?.status === "cancelled"
            ? { ...record, status: "cancelled" as const, ended_at: current.ended_at ?? record.ended_at, ownership: current.ownership, stderr: mergeDiagnosticText(record.stderr, current.stderr) }
            : terminal || !ownsCurrent ? current ?? record : record;
          await writeJsonAtomic(path, durable);
          Object.assign(record, durable);
        });
      } finally {
        this.leases.release(record.ownership);
        this.cancelled.delete(record.job_id);
      }
      await this.finishExecution(record);
    }
  }

  private async finishExecution(record: JobRecord): Promise<void> {
    if (!isTerminal(record.status)) return;
    const executionId = record.execution_id ?? executionIdFor("job", resolve(record.cwd), record.job_id);
    const status = record.status === "succeeded" ? "succeeded"
      : record.status === "cancelled" ? "cancelled"
        : record.status === "timed_out" ? "timed_out"
          : "failed";
    await this.executions.finish(record.cwd, executionId, {
      status,
      producer: "node-job-coordinator",
      ended_at: record.ended_at,
      result: {
        exit_code: record.return_code ?? null,
        stdout_preview: record.stdout.slice(-64_000),
        stderr_preview: record.stderr.slice(-64_000),
      },
    }).catch(() => undefined);
  }
}

function executionSurface(surface: string): "local" | "ssh" | "hpc" | "research" {
  if (surface === "ssh" || surface.startsWith("ssh:")) return "ssh";
  if (surface === "hpc" || surface.startsWith("hpc:")) return "hpc";
  if (surface.startsWith("research")) return "research";
  return "local";
}

function correlationFrom(body: Record<string, unknown>, jobId: string) {
  const result: Record<string, string> = { job_id: jobId };
  for (const key of ["session_id", "turn_id", "message_id", "run_id", "operation_id", "loop_id", "candidate_id", "parent_execution_id", "request_id"] as const) {
    if (typeof body[key] === "string" && body[key]) result[key] = body[key];
  }
  return result;
}

function redactCommand(command: string[]): string[] {
  const result = command.slice();
  for (let index = 0; index < result.length; index += 1) {
    const value = result[index] ?? "";
    if (/^--?(?:api[-_]?key|token|secret|password|authorization|credential)$/i.test(value) && index + 1 < result.length) {
      result[index + 1] = "[redacted]";
    } else if (/^--?(?:api[-_]?key|token|secret|password|authorization|credential)=/i.test(value)) {
      result[index] = `${value.slice(0, value.indexOf("=") + 1)}[redacted]`;
    }
  }
  return result;
}

function mergeDiagnosticText(runner: string, durable: string): string {
  if (!runner) return durable;
  if (!durable || runner === durable || runner.includes(durable)) return runner;
  if (durable.includes(runner)) return durable;
  return `${runner}\n${durable}`;
}

export function parseCommand(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return [];
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === '"') {
      if (character === '"') { quote = null; inToken = true; continue; }
      if (character === "\\") {
        const next = value[index + 1];
        if (next === "\\" || next === '"' || next === "'") { token += next; index += 1; }
        else token += character;
      } else token += character;
      inToken = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") { quote = null; inToken = true; continue; }
      token += character;
      inToken = true;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; inToken = true; continue; }
    if (character === "\\") {
      const next = value[index + 1];
      if (next !== undefined && (next === "\\" || next === '"' || next === "'")) { token += next; index += 1; }
      else token += character;
      inToken = true;
      continue;
    }
    const isWhitespace = character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\v" || character === "\f";
    if (isWhitespace) {
      if (inToken) { tokens.push(token); token = ""; inToken = false; }
      continue;
    }
    token += character;
    inToken = true;
  }
  if (inToken) tokens.push(token);
  return tokens;
}
