import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { metadataRoot, readJson, writeJsonAtomic } from "./persistence.js";
import { defaultPythonExecutable, WorkspaceEnvironmentService } from "./workspace-environment.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export interface JobRequirement { cpu?: number; memory_mb?: number; gpu?: boolean; runtime?: string; packages?: string[]; timeout_seconds?: number; [key: string]: unknown }
export interface JobRecord { job_id: string; command: string[]; cwd: string; execution_cwd?: string; surface: string; status: JobStatus; created_at: string; started_at?: string; ended_at?: string; return_code?: number | null; stdout: string; stderr: string; artifact_ids: string[]; environment: Record<string, unknown>; requirement: JobRequirement }

const ORPHAN_GRACE_MS = 15_000;
const KILL_GRACE_MS = 2_000;
const POSIX = process.platform !== "win32";
const RESEARCH_ENVIRONMENT_KEY_NAMES = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "USER", "LOGNAME", "SHELL", "VIRTUAL_ENV", "PYTHONNOUSERSITE", "PIP_REQUIRE_VIRTUALENV", "PIP_USER", "UV_PROJECT_ENVIRONMENT", "npm_config_prefix", "npm_config_cache", "npm_config_update_notifier", "PNPM_HOME", "COREPACK_HOME"] as const;
const RESEARCH_ENVIRONMENT_KEYS = new Map(RESEARCH_ENVIRONMENT_KEY_NAMES.map((key) => [key.toLowerCase(), key]));

export interface JobCoordinatorHooks { beforeSpawn?: (record: Readonly<JobRecord>) => Promise<void>; platform?: NodeJS.Platform }

export class JobCoordinator {
  private readonly children = new Map<string, ChildProcess>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly environments: Pick<WorkspaceEnvironmentService, "environment"> = new WorkspaceEnvironmentService(), private readonly hooks: JobCoordinatorHooks = {}) {}

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
    const record: JobRecord = { job_id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`, command, cwd, ...(executionCwd !== resolve(cwd) ? { execution_cwd: executionCwd } : {}), surface, status: "pending", created_at: new Date().toISOString(), stdout: "", stderr: "", artifact_ids: [], environment: { platform: process.platform, node: process.version, virtual_env: environment.VIRTUAL_ENV, npm_prefix: environment.npm_config_prefix }, requirement };
    await this.save(record);
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
    const record = await this.get(cwd, id);
    if (!record || ["succeeded", "failed", "cancelled", "timed_out"].includes(record.status)) return record;
    this.cancelled.add(id);
    const child = this.children.get(id);
    if (child) terminate(child);
    record.status = "cancelled"; record.ended_at = new Date().toISOString(); await this.save(record);
    return record;
  }
  async shutdown(): Promise<void> { for (const child of this.children.values()) terminate(child); await Promise.allSettled([...this.jobs.values()]); }

  private jobsDir(cwd: string) { return join(metadataRoot(cwd), "jobs"); }
  private jobPath(cwd: string, id: string) { if (!/^job_[A-Za-z0-9]{16}$/.test(id)) throw new Error("Invalid job id"); const root = resolve(this.jobsDir(cwd)); const target = resolve(root, `${id}.json`); const rel = relative(root, target); if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Job path escapes the workspace"); return target; }
  private async save(record: JobRecord) { await writeJsonAtomic(this.jobPath(record.cwd, record.job_id), record); }
  private async healOrphan(record: JobRecord): Promise<JobRecord> {
    if (!["pending", "running"].includes(record.status) || this.jobs.has(record.job_id)) return record;
    if (Date.now() - Date.parse(record.created_at) < ORPHAN_GRACE_MS) return record;
    const note = "job was orphaned by a server restart";
    record.status = "failed"; record.return_code = null; record.ended_at = new Date().toISOString();
    record.stderr = record.stderr ? `${record.stderr}\n${note}` : note;
    await this.save(record);
    return record;
  }
  private async run(record: JobRecord, environment: NodeJS.ProcessEnv): Promise<void> {
    if (this.cancelled.has(record.job_id)) { record.status = "cancelled"; record.ended_at = new Date().toISOString(); await this.save(record); this.cancelled.delete(record.job_id); return; }
    record.status = "running"; record.started_at = new Date().toISOString(); await this.save(record);
    let child: ChildProcess | undefined;
    try {
      await this.hooks.beforeSpawn?.(record);
      if (this.cancelled.has(record.job_id)) { record.status = "cancelled"; return; }
      // detached: the child leads its own process group so a shell grandchild
      // (which inherits the pipes and would otherwise keep `close` pending) dies
      // with it. Windows has no process groups, so it keeps the plain child kill.
      child = spawn(record.command[0]!, record.command.slice(1), { cwd: record.execution_cwd ?? record.cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: POSIX });
      this.children.set(record.job_id, child);
      if (this.cancelled.has(record.job_id)) terminate(child);
      let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0);
      const appendTail = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk]).subarray(-100_000);
      child.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
      const timeout = Math.max(1, Number(record.requirement.timeout_seconds ?? 3600)) * 1000; let timedOut = false;
      const result = await new Promise<{ code: number | null }>((done) => { let timer: NodeJS.Timeout | undefined; const finish = (code: number | null) => { if (timer) clearTimeout(timer); done({ code }); }; child!.once("close", (code) => finish(code)); timer = setTimeout(() => { timedOut = true; killGroup(child!, "SIGKILL"); finish(null); }, timeout); });
      record.stdout = stdout.toString("utf8"); record.stderr = stderr.toString("utf8"); record.return_code = result.code;
      record.status = this.cancelled.has(record.job_id) ? "cancelled" : timedOut ? "timed_out" : result.code === 0 ? "succeeded" : "failed";
    } catch (error) { if (!this.cancelled.has(record.job_id)) { record.status = "failed"; record.stderr = String(error).slice(-100_000); } }
    finally { record.ended_at = new Date().toISOString(); this.children.delete(record.job_id); await this.save(record); this.cancelled.delete(record.job_id); }
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
