import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { metadataRoot, readJson, writeJsonAtomic } from "./persistence.js";
import { WorkspaceEnvironmentService } from "./workspace-environment.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export interface JobRequirement { cpu?: number; memory_mb?: number; gpu?: boolean; runtime?: string; packages?: string[]; timeout_seconds?: number; [key: string]: unknown }
export interface JobRecord { job_id: string; command: string[]; cwd: string; execution_cwd?: string; surface: string; status: JobStatus; created_at: string; started_at?: string; ended_at?: string; return_code?: number | null; stdout: string; stderr: string; artifact_ids: string[]; environment: Record<string, unknown>; requirement: JobRequirement }

export class JobCoordinator {
  private readonly children = new Map<string, ChildProcess>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly environments: Pick<WorkspaceEnvironmentService, "environment"> = new WorkspaceEnvironmentService()) {}

  capabilities(requirement: JobRequirement) {
    const runtime = { node: process.execPath, python: process.env.PYTHON ?? "python3", r: null };
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
      ? Object.fromEntries(Object.entries(body.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const environment = { ...baseEnvironment, ...requestedEnvironment };
    const executionCwd = typeof body.execution_cwd === "string" ? resolve(body.execution_cwd) : resolve(cwd);
    const executionRelative = relative(resolve(cwd), executionCwd);
    if (isAbsolute(executionRelative) || executionRelative === ".." || executionRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("execution cwd escapes the workspace");
    const record: JobRecord = { job_id: `job_${randomUUID().replaceAll("-", "").slice(0, 16)}`, command, cwd, ...(executionCwd !== resolve(cwd) ? { execution_cwd: executionCwd } : {}), surface: typeof body.surface === "string" ? body.surface : "local", status: "pending", created_at: new Date().toISOString(), stdout: "", stderr: "", artifact_ids: [], environment: { platform: process.platform, node: process.version, virtual_env: environment.VIRTUAL_ENV, npm_prefix: environment.npm_config_prefix }, requirement };
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
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  async get(cwd: string, id: string): Promise<JobRecord | null> { return readJson<JobRecord | null>(this.jobPath(cwd, id), null); }
  async logs(cwd: string, id: string) { const record = await this.get(cwd, id); return record ? { job_id: record.job_id, stdout: record.stdout, stderr: record.stderr } : null; }
  async cancel(cwd: string, id: string): Promise<JobRecord | null> {
    const record = await this.get(cwd, id);
    if (!record || ["succeeded", "failed", "cancelled", "timed_out"].includes(record.status)) return record;
    this.cancelled.add(id);
    this.children.get(id)?.kill("SIGTERM");
    record.status = "cancelled"; record.ended_at = new Date().toISOString(); await this.save(record);
    return record;
  }
  async shutdown(): Promise<void> { for (const child of this.children.values()) child.kill("SIGTERM"); await Promise.allSettled([...this.jobs.values()]); }

  private jobsDir(cwd: string) { return join(metadataRoot(cwd), "jobs"); }
  private jobPath(cwd: string, id: string) { if (!/^job_[A-Za-z0-9]{16}$/.test(id)) throw new Error("Invalid job id"); const root = resolve(this.jobsDir(cwd)); const target = resolve(root, `${id}.json`); const rel = relative(root, target); if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Job path escapes the workspace"); return target; }
  private async save(record: JobRecord) { await writeJsonAtomic(this.jobPath(record.cwd, record.job_id), record); }
  private async run(record: JobRecord, environment: NodeJS.ProcessEnv): Promise<void> {
    if (this.cancelled.has(record.job_id)) { record.status = "cancelled"; record.ended_at = new Date().toISOString(); await this.save(record); this.cancelled.delete(record.job_id); return; }
    record.status = "running"; record.started_at = new Date().toISOString(); await this.save(record);
    let child: ChildProcess | undefined;
    try {
      child = spawn(record.command[0]!, record.command.slice(1), { cwd: record.execution_cwd ?? record.cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
      this.children.set(record.job_id, child);
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      const timeout = Math.max(1, Number(record.requirement.timeout_seconds ?? 3600)) * 1000; let timedOut = false;
      const result = await new Promise<{ code: number | null }>((done) => { let timer: NodeJS.Timeout | undefined; const finish = (code: number | null) => { if (timer) clearTimeout(timer); done({ code }); }; child!.once("close", (code) => finish(code)); timer = setTimeout(() => { timedOut = true; child!.kill("SIGKILL"); finish(null); }, timeout); });
      record.stdout = Buffer.concat(stdout).toString("utf8").slice(-100_000); record.stderr = Buffer.concat(stderr).toString("utf8").slice(-100_000); record.return_code = result.code;
      record.status = this.cancelled.has(record.job_id) ? "cancelled" : timedOut ? "timed_out" : result.code === 0 ? "succeeded" : "failed";
    } catch (error) { if (!this.cancelled.has(record.job_id)) { record.status = "failed"; record.stderr = String(error).slice(-100_000); } }
    finally { record.ended_at = new Date().toISOString(); this.children.delete(record.job_id); await this.save(record); this.cancelled.delete(record.job_id); }
  }
}

export function parseCommand(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return [];
  const tokens: string[] = []; const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of value.matchAll(pattern)) tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\([\\"'])/g, "$1"));
  return tokens;
}
