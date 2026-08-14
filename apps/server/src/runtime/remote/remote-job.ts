/** Remote job coordinator (reverse-cs-inspiration 4.5): a narrow, complete
 *  SSH job loop — stage a script locally, launch it remotely with nohup,
 *  persist the remote pid, probe status, cancel, and harvest declared output
 *  globs back into the workspace where they are published as artifacts. */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJson, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { resolveWorkspaceFile } from "../../security/workspace-security.js";
import type { ComputeMachine, SshExecutor } from "./ssh-executor.js";

export type RemoteJobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface RemoteJobRecord {
  job_id: string;
  machine_label: string;
  host: string;
  user: string | null;
  status: RemoteJobStatus;
  remote_pid: string | null;
  script: string;
  script_sha256: string;
  output_glob: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  artifact_ids: string[];
}

export interface RemoteJobSubmitInput {
  machine_label: string;
  command: RemoteCommand;
  output_glob?: string;
}

const REMOTE_DIR = (jobId: string) => `~/.pi-jobs/${jobId}`;

type RemoteCommand = string | readonly string[];

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return "'" + value.split("'").join("'\\''") + "'";
}

function normalizeCommand(input: RemoteCommand): string {
  const parts = typeof input === "string"
    ? [input.trim()]
    : input.filter((part) => typeof part === "string" && part).map((part) => shellQuote(part));
  return parts.join(" ").trim();
}

function isSafeOutputGlob(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\0")) return false;
  if (value.includes(String.fromCharCode(96)) || /[\s;&|$(){}<>\\'"!]/.test(value)) return false;
  return !value.split("/").some((part) => part === ".." || part === "~");
}

function jobsPath(cwd: string, jobId: string): string {
  return workspaceFile(cwd, `jobs/remote-${jobId}.json`);
}

function jobDir(cwd: string, jobId: string): string {
  return join(cwd, ".pi-science", "staging", jobId);
}

function normalizeStatusLine(line: string): RemoteJobStatus {
  const text = line.trim().toLowerCase();
  if (text.includes("running")) return "running";
  if (text.includes("succeeded")) return "succeeded";
  if (text.includes("failed")) return "failed";
  if (text.startsWith("exited")) {
    const code = Number(text.split(/\s+/)[1] ?? 0);
    return Number.isFinite(code) && code !== 0 ? "failed" : "succeeded";
  }
  return "unknown";
}

/** Remote job lifecycle without a daemon: each probe is a fresh SSH round trip.
 *  `executor` is injectable so tests run without a host. */
export class RemoteJobCoordinator {
  constructor(
    private readonly executor: SshExecutor,
    private readonly publishArtifact: (cwd: string, relativePath: string, content: Buffer, tool: string, sessionId?: string) => Promise<{ artifact_id: string }>,
  ) {}

  async submit(cwd: string, input: RemoteJobSubmitInput): Promise<RemoteJobRecord | { error: string; code?: string }> {
    const command = normalizeCommand(input.command);
    if (command.length === 0) return { error: "command is required" };
    if (/[\r\n]/.test(command)) return { error: "command must be a single line", code: "invalid_command" };
    const outputGlob = String(input.output_glob ?? "*").trim() || "*";
    if (!isSafeOutputGlob(outputGlob)) return { error: "output_glob must be a relative file glob without shell operators", code: "invalid_output_glob" };
    const machines = await readJson<{ machines?: ComputeMachine[] }>(workspaceFile(cwd, "compute.json"), {});
    const machine = (machines.machines ?? []).find((item) => item.label === input.machine_label);
    if (!machine) return { error: `Compute machine not found: ${input.machine_label}`, code: "machine_not_found" };
    const jobId = randomUUID().replaceAll("-", "").slice(0, 16);
    const remoteDir = REMOTE_DIR(jobId);
    const script = ["#!/bin/sh", "set +e", `cd ${remoteDir}`, command, "exit_code=$?", "printf '%s\\n' \"$exit_code\" > exit.code", "exit \"$exit_code\""].join("\n") + "\n";
    const scriptSha = createHash("sha256").update(script).digest("hex").slice(0, 16);
    const record: RemoteJobRecord = {
      job_id: jobId, machine_label: machine.label, host: machine.host, user: machine.user ?? null,
      status: "pending", remote_pid: null, script, script_sha256: scriptSha,
      output_glob: outputGlob, created_at: new Date().toISOString(),
      started_at: null, ended_at: null, exit_code: null, artifact_ids: [],
    };
    // Local staging (rollback-safe: the record is only written after launch).
    await mkdir(jobDir(cwd, jobId), { recursive: true });
    await writeFile(join(jobDir(cwd, jobId), "run.sh"), script, "utf8");
    // Remote launch: stream the script over stdin, start it detached, print the pid.
    const launch = `mkdir -p ${remoteDir} && cat > ${remoteDir}/run.sh && (nohup sh ${remoteDir}/run.sh > ${remoteDir}/output.log 2>&1 & echo $! > ${remoteDir}/pid) && cat ${remoteDir}/pid`;
    const result = await this.executor.run(machine, launch, script, 30_000);
    if (!result.success) {
      record.status = "failed";
      record.ended_at = new Date().toISOString();
      await writeJsonAtomic(jobsPath(cwd, jobId), record);
      return { error: `Remote launch failed: ${result.stderr.trim() || "unknown error"}`, code: "launch_failed" };
    }
    const pid = result.stdout.trim().split(/\s+/).pop() ?? null;
    record.remote_pid = pid;
    record.status = "running";
    record.started_at = new Date().toISOString();
    await writeJsonAtomic(jobsPath(cwd, jobId), record);
    return record;
  }

  async list(cwd: string): Promise<RemoteJobRecord[]> {
    const { readdir } = await import("node:fs/promises");
    const dir = join(cwd, ".pi-science", "jobs");
    let names: string[] = [];
    try { names = await readdir(dir); } catch { return []; }
    const records: RemoteJobRecord[] = [];
    for (const name of names.filter((entry) => entry.startsWith("remote-") && entry.endsWith(".json"))) {
      try { const record = await readJson<RemoteJobRecord | null>(join(dir, name), null); if (record) records.push(record); } catch { /* torn write: skip */ }
    }
    return records.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async get(cwd: string, jobId: string): Promise<RemoteJobRecord | null> {
    try { return await readJson<RemoteJobRecord | null>(jobsPath(cwd, jobId), null); } catch { return null; }
  }

  /** Probe the remote process and reconcile the persisted status. */
  async refresh(cwd: string, jobId: string): Promise<RemoteJobRecord | null> {
    const record = await this.get(cwd, jobId);
    if (!record || !record.remote_pid || record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return record;
    const machines = await readJson<{ machines?: ComputeMachine[] }>(workspaceFile(cwd, "compute.json"), {});
    const machine = (machines.machines ?? []).find((item) => item.label === record.machine_label);
    if (!machine) return record;
    const remoteDir = REMOTE_DIR(record.job_id);
    const probe = `if kill -0 ${record.remote_pid} 2>/dev/null; then echo running; elif [ -f ${remoteDir}/exit.code ]; then code=$(cat ${remoteDir}/exit.code 2>/dev/null || echo 1); if [ "$code" -eq 0 ] 2>/dev/null; then echo succeeded; else echo failed; fi; else echo missing; fi`;
    const result = await this.executor.run(machine, probe, undefined, 15_000);
    const status = result.success ? normalizeStatusLine(result.stdout) : "unknown";
    const updated: RemoteJobRecord = { ...record, status };
    if (status === "succeeded" || status === "failed") updated.ended_at = new Date().toISOString();
    if (status === "succeeded" || status === "failed") {
      const codeResult = await this.executor.run(machine, `cat ${remoteDir}/exit.code`, undefined, 15_000);
      updated.exit_code = codeResult.success ? Number(codeResult.stdout.trim()) : null;
    }
    await withFileWriteLock(jobsPath(cwd, jobId), async () => writeJsonAtomic(jobsPath(cwd, jobId), updated));
    return updated;
  }

  async cancel(cwd: string, jobId: string): Promise<RemoteJobRecord | null> {
    const record = await this.get(cwd, jobId);
    if (!record) return null;
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return record;
    const machines = await readJson<{ machines?: ComputeMachine[] }>(workspaceFile(cwd, "compute.json"), {});
    const machine = (machines.machines ?? []).find((item) => item.label === record.machine_label);
    let updated = { ...record, status: "cancelled" as RemoteJobStatus, ended_at: new Date().toISOString() };
    if (machine && record.remote_pid) {
      await this.executor.run(machine, `kill ${record.remote_pid} 2>/dev/null; rm -rf ${REMOTE_DIR(record.job_id)}`, undefined, 15_000);
    }
    await withFileWriteLock(jobsPath(cwd, jobId), async () => writeJsonAtomic(jobsPath(cwd, jobId), updated));
    return updated;
  }

  /** Pull declared output globs back into the workspace and publish them as
   *  artifacts. Text-ish files (<= 8 MB) are transferred as base64. */
  async harvest(cwd: string, jobId: string, sessionId?: string): Promise<{ artifact_ids: string[]; files: string[]; error?: string }> {
    const record = await this.refresh(cwd, jobId);
    if (!record) return { artifact_ids: [], files: [], error: "Job not found" };
    if (record.status !== "succeeded" && record.status !== "failed") return { artifact_ids: [], files: [], error: `Job is not finished (${record.status})` };
    const machines = await readJson<{ machines?: ComputeMachine[] }>(workspaceFile(cwd, "compute.json"), {});
    const machine = (machines.machines ?? []).find((item) => item.label === record.machine_label);
    if (!machine) return { artifact_ids: [], files: [], error: "Compute machine not found" };
    const remoteDir = REMOTE_DIR(jobId);
    // List matching files with sizes; skip job bookkeeping files.
    const listCmd = `cd ${remoteDir} && for f in ${record.output_glob}; do [ -f "$f" ] && [ "$f" != "output.log" ] && [ "$f" != "exit.code" ] && [ "$f" != "run.sh" ] && [ "$f" != "pid" ] && printf '%s %s\\n' "$f" "$(wc -c < "$f")"; done`;
    const list = await this.executor.run(machine, listCmd, undefined, 15_000);
    if (!list.success) return { artifact_ids: [], files: [], error: `Failed to list remote outputs: ${list.stderr.trim()}` };
    const artifactIds: string[] = [];
    const files: string[] = [];
    for (const line of list.stdout.trim().split("\n").filter(Boolean)) {
      const [name, sizeText] = line.split(/\s+/);
      const size = Number(sizeText ?? 0);
      if (!name || !Number.isFinite(size) || size > 8 * 1024 * 1024) continue;
      // Keep $HOME outside the quoted filename: quoting the complete
      // `~/.pi-jobs/...` path would suppress tilde expansion on the remote
      // shell and make every harvest look like a missing file.
      const remoteFile = `"$HOME/.pi-jobs/"${shellQuote(record.job_id)}"/"${shellQuote(name)}`;
      const fetched = await this.executor.run(machine, `base64 ${remoteFile}`, undefined, 30_000);
      if (!fetched.success) continue;
      const content = Buffer.from(fetched.stdout.replace(/\s+/g, ""), "base64");
      if (content.length !== size) continue;
      const safe = name.replaceAll("\\", "/");
      let target: string;
      try { target = await resolveWorkspaceFile(cwd, safe); } catch { continue; }
      await mkdir(dirname(target), { recursive: true }).catch(() => undefined);
      await writeFile(target, content);
      const published = await this.publishArtifact(cwd, safe.replaceAll("\\", "/"), content, "remote_job", sessionId);
      artifactIds.push(published.artifact_id);
      files.push(safe);
    }
    const updated = await this.get(cwd, jobId);
    if (updated) {
      const withArtifacts = { ...updated, artifact_ids: [...new Set([...updated.artifact_ids, ...artifactIds])] };
      await withFileWriteLock(jobsPath(cwd, jobId), async () => writeJsonAtomic(jobsPath(cwd, jobId), withArtifacts));
    }
    return { artifact_ids: artifactIds, files };
  }
}

export type { ComputeMachine };
