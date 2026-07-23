import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { appendJsonLine, metadataRoot, readJson, writeJsonAtomic } from "./persistence.js";
import { validateWorkspaceCwd } from "./workspace-security.js";

type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
interface Requirement { cpu?: number; memory_mb?: number; gpu?: boolean; runtime?: string; packages?: string[]; timeout_seconds?: number; [key: string]: unknown }
interface JobRecord {
  job_id: string; command: string[]; cwd: string; surface: string; status: JobStatus;
  created_at: string; started_at?: string; ended_at?: string; return_code?: number | null;
  stdout: string; stderr: string; artifact_ids: string[]; environment: Record<string, unknown>; requirement: Requirement;
}

const children = new Map<string, ChildProcess>();

function cwdOf(request: { query: unknown }): string {
  const query = request.query as Record<string, unknown>;
  return typeof query.cwd === "string" && query.cwd ? query.cwd : ".";
}

async function workspace(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  try { return await validateWorkspaceCwd(cwdOf(request)); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

function jobsDir(cwd: string): string { return join(metadataRoot(cwd), "jobs"); }
function jobPath(cwd: string, id: string): string { return join(jobsDir(cwd), `${id}.json`); }

function parseCommand(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return [];
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of value.matchAll(pattern)) tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\([\\"'])/g, "$1"));
  return tokens;
}

function capabilities(requirement: Requirement): { status: "ready" | "degraded" | "blocked"; checks: Record<string, unknown>; reasons: string[] } {
  const runtime = { node: process.execPath, python: process.env.PYTHON ?? "python3", r: null };
  const checks = { cpu: 1, memory_mb: null, gpu: Boolean(process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES), runtime, packages: {} };
  const reasons: string[] = [];
  if (Number(requirement.cpu ?? 1) > 1) reasons.push(`requires ${requirement.cpu} CPUs, host has 1`);
  if (requirement.gpu && !checks.gpu) reasons.push("GPU requested but no visible GPU was detected");
  if (requirement.runtime && requirement.runtime !== "any" && !(requirement.runtime in runtime) ) reasons.push(`runtime not found: ${requirement.runtime}`);
  return { status: reasons.length ? "blocked" : "ready", checks, reasons };
}

async function save(record: JobRecord): Promise<void> { await writeJsonAtomic(jobPath(record.cwd, record.job_id), record); }

async function run(record: JobRecord): Promise<void> {
  record.status = "running"; record.started_at = new Date().toISOString(); await save(record);
  let child: ChildProcess | undefined;
  try {
    child = spawn(record.command[0]!, record.command.slice(1), { cwd: record.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    children.set(record.job_id, child);
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = Math.max(1, Number(record.requirement.timeout_seconds ?? 3600)) * 1000;
    let timedOut = false;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => { if (timer) clearTimeout(timer); resolve({ code, signal }); };
      child!.once("close", (code, signal) => finish(code, signal));
      timer = setTimeout(() => { timedOut = true; child!.kill("SIGKILL"); finish(null, "SIGKILL"); }, timeout);
    });
    record.stdout = Buffer.concat(stdout).toString("utf8").slice(-100_000);
    record.stderr = Buffer.concat(stderr).toString("utf8").slice(-100_000);
    record.return_code = result.code;
    record.status = timedOut ? "timed_out" : result.code === 0 ? "succeeded" : "failed";
  } catch (error) {
    record.status = "failed"; record.stderr = String(error).slice(-100_000);
  } finally {
    record.ended_at = new Date().toISOString(); children.delete(record.job_id); await save(record);
  }
}

async function loadJobs(cwd: string, limit: number): Promise<JobRecord[]> {
  let names: string[];
  try { names = await readdir(jobsDir(cwd)); } catch { return []; }
  const records: JobRecord[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const record = await readJson<JobRecord | null>(join(jobsDir(cwd), name), null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export function registerJobRoutes(app: FastifyInstance): void {
  app.post("/api/jobs/capabilities", async (request) => capabilities((request.body ?? {}) as Requirement));
  app.post("/api/jobs", async (request, reply) => {
    const cwd = await workspace(request, reply); if (!cwd) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const command = parseCommand(body.command); if (!command.length) return reply.code(400).send({ error: "command is empty" });
    const requirement = (body.requirement && typeof body.requirement === "object" ? body.requirement : {}) as Requirement;
    const check = capabilities(requirement); if (check.status === "blocked") return reply.code(400).send({ error: check.reasons.join("; ") });
    const record: JobRecord = { job_id: `job_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, command, cwd, surface: typeof body.surface === "string" ? body.surface : "local", status: "pending", created_at: new Date().toISOString(), stdout: "", stderr: "", artifact_ids: [], environment: { platform: process.platform, node: process.version }, requirement };
    await save(record); void run(record);
    return record;
  });
  app.get("/api/jobs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; const q = request.query as { limit?: string }; return { jobs: await loadJobs(cwd, Math.min(1000, Math.max(1, Number(q.limit ?? 100)))) }; });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; const record = await readJson<JobRecord | null>(jobPath(cwd, request.params.job_id), null); return record ? record : reply.code(404).send({ error: "Job not found" }); });
  app.delete<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; const record = await readJson<JobRecord | null>(jobPath(cwd, request.params.job_id), null); if (!record) return reply.code(404).send({ error: "Job not found" }); const child = children.get(record.job_id); if (child) child.kill("SIGTERM"); record.status = "cancelled"; record.ended_at = new Date().toISOString(); await save(record); return record; });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id/logs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; const record = await readJson<JobRecord | null>(jobPath(cwd, request.params.job_id), null); if (!record) return reply.code(404).send({ error: "Job not found" }); return { job_id: record.job_id, stdout: record.stdout, stderr: record.stderr }; });
  app.addHook("onClose", async () => { for (const child of children.values()) child.kill("SIGTERM"); });
}
