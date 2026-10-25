/**
 * Remote compute execution over SSH.
 *
 * The control plane owns machine resolution, command dispatch, bounded output
 * capture and execution records. Machines are registered in the workspace
 * `compute.json` registry (Settings → Compute) and only key-based identities
 * can run executions; registered passwords are never persisted, so password
 * probes stay one-off and execution refuses them explicitly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { readJson, workspaceFile } from "../../storage/persistence.js";
import { executionRepository } from "../executions/execution-repository.js";
import { userHome } from "../../support/platform-utils.js";

export interface ComputeMachine {
  label: string;
  host: string;
  user?: string;
  port?: number;
  identity_file?: string;
  auth_method?: "key" | "password";
}

export interface MachineSummary {
  label: string;
  host: string;
  user: string | null;
  port: number;
  auth_method: "key" | "password";
  identity_file: string | null;
}

export interface SshRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface RemoteExecuteResult extends SshRunResult {
  machine: MachineSummary;
  execution_id: string;
}

export interface SlurmSubmitResult {
  machine: MachineSummary;
  job_id: string;
  output_path: string;
  error_path: string;
  raw: string;
  execution_id: string;
}

export type SlurmJobState = "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout" | "unknown";

export interface SlurmCheckResult {
  machine: MachineSummary;
  job_id: string;
  state: SlurmJobState;
  raw_state: string;
  exit_code: string | null;
  elapsed: string | null;
  finished: boolean;
  stdout_tail: string | null;
  stderr_tail: string | null;
}

export class RemoteComputeError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "RemoteComputeError";
  }
}

type SpawnFn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;

export interface RemoteComputeDeps {
  spawn?: SpawnFn;
  now?: () => number;
}

const MAX_STDOUT_BYTES = 2_097_152;
const MAX_STDERR_BYTES = 262_144;
const MAX_COMMAND_CHARS = 32_768;
const MAX_SCRIPT_CHARS = 65_536;
const DEFAULT_EXECUTE_TIMEOUT_SECONDS = 300;
const MAX_EXECUTE_TIMEOUT_SECONDS = 600;
const SLURM_TIMEOUT_MS = 60_000;
const MAX_TAIL_BYTES = 65_536;

function expandIdentityPath(path: string): string {
  if (path === "~") return userHome();
  if (path.startsWith("~/")) return `${userHome()}/${path.slice(2)}`;
  return path;
}

function validateMachine(machine: ComputeMachine): void {
  const host = String(machine.host ?? "").trim();
  if (!host || host.startsWith("-") || !/^[a-zA-Z0-9._:[\]-]+$/.test(host)) throw new RemoteComputeError(`Invalid SSH hostname for machine "${machine.label}"`);
  const user = String(machine.user ?? "").trim();
  if (user && !/^[a-zA-Z0-9._-]+$/.test(user)) throw new RemoteComputeError(`Invalid SSH username for machine "${machine.label}"`);
  const port = Number(machine.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RemoteComputeError(`SSH port must be between 1 and 65535 for machine "${machine.label}"`);
}

function machineSummary(machine: ComputeMachine): MachineSummary {
  return {
    label: String(machine.label ?? ""),
    host: String(machine.host ?? ""),
    user: machine.user ? String(machine.user) : null,
    port: Number(machine.port ?? 22),
    auth_method: machine.auth_method === "password" ? "password" : "key",
    identity_file: machine.identity_file ? String(machine.identity_file) : null,
  };
}

async function readMachines(cwd: string): Promise<ComputeMachine[]> {
  const value = await readJson<{ machines?: ComputeMachine[] }>(workspaceFile(cwd, "compute.json"), {});
  return Array.isArray(value.machines) ? value.machines : [];
}

async function resolveMachine(cwd: string, label: string): Promise<ComputeMachine> {
  const wanted = String(label ?? "").trim();
  if (!wanted) throw new RemoteComputeError("machine_label is required");
  const machines = await readMachines(cwd);
  const machine = machines.find((item) => String(item.label ?? "") === wanted);
  if (!machine) {
    const available = machines.map((item) => String(item.label ?? "")).filter(Boolean);
    throw new RemoteComputeError(
      available.length
        ? `Machine "${wanted}" is not registered. Registered machines: ${available.join(", ")}.`
        : `Machine "${wanted}" is not registered and no machines are configured. Register one in Settings → Compute.`,
      404,
    );
  }
  validateMachine(machine);
  return machine;
}

async function buildSshInvocation(machine: ComputeMachine): Promise<{ command: string; args: string[] }> {
  if (machine.auth_method === "password") {
    throw new RemoteComputeError(`Machine "${machine.label}" uses password authentication. Execution requires a key-based machine; register an SSH key identity.`);
  }
  const identityFile = expandIdentityPath(String(machine.identity_file ?? "~/.ssh/id_rsa").trim() || "~/.ssh/id_rsa");
  // The key existence check mirrors the probe path so failures surface before the process starts.
  try {
    await access(identityFile);
  } catch {
    throw new RemoteComputeError(`SSH key not found for machine "${machine.label}": ${machine.identity_file ?? "~/.ssh/id_rsa"}`);
  }
  return {
    command: "ssh",
    args: [
      "-o", "ConnectTimeout=10",
      "-o", "ConnectionAttempts=1",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-p", String(Number(machine.port ?? 22)),
      "-i", identityFile,
      machine.user ? `${machine.user}@${machine.host}` : machine.host,
    ],
  };
}

interface SshRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

async function runSsh(machine: ComputeMachine, remoteCommand: string, options: SshRunOptions, deps: RemoteComputeDeps = {}): Promise<SshRunResult> {
  const spawnFn = deps.spawn ?? (spawn as unknown as SpawnFn);
  const now = deps.now ?? Date.now;
  const { command, args } = await buildSshInvocation(machine);
  const child = spawnFn(command, [...args, remoteCommand], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const maxStderr = options.maxStderrBytes ?? MAX_STDERR_BYTES;
  let timedOut = false;
  let aborted = false;

  return await new Promise<SshRunResult>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted,
        durationMs: now() - startedAt,
      });
    };
    const killTree = () => {
      if (child.killed) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const onAbort = () => { aborted = true; killTree(); };
    const startedAt = now();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxStdout) { stdoutTruncated = true; return; }
      const remaining = maxStdout - stdoutBytes;
      if (chunk.length > remaining) {
        stdout += chunk.subarray(0, remaining).toString("utf8");
        stdoutBytes = maxStdout;
        stdoutTruncated = true;
      } else {
        stdout += chunk.toString("utf8");
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxStderr) { stderrTruncated = true; return; }
      const remaining = maxStderr - stderrBytes;
      if (chunk.length > remaining) {
        stderr += chunk.subarray(0, remaining).toString("utf8");
        stderrBytes = maxStderr;
        stderrTruncated = true;
      } else {
        stderr += chunk.toString("utf8");
        stderrBytes += chunk.length;
      }
    });
    child.on("error", (error) => {
      stderr = stderr ? `${stderr}\n${String(error.message)}` : String(error.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));

    const timer = setTimeout(() => { timedOut = true; killTree(); }, options.timeoutMs);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort);
  });
}

function executionStatus(run: SshRunResult): "succeeded" | "failed" | "cancelled" | "timed_out" {
  if (run.aborted) return "cancelled";
  if (run.timedOut) return "timed_out";
  return run.exitCode === 0 ? "succeeded" : "failed";
}

export const remoteComputeService = {
  async listMachines(cwd: string): Promise<MachineSummary[]> {
    const machines = await readMachines(cwd);
    return machines.map(machineSummary).filter((item) => item.label && item.host);
  },

  async execute(cwd: string, input: { machine_label: string; command: string; timeout_seconds?: number; session_id?: string; signal?: AbortSignal }, deps: RemoteComputeDeps = {}): Promise<RemoteExecuteResult> {
    const machine = await resolveMachine(cwd, input.machine_label);
    const command = String(input.command ?? "");
    if (!command.trim()) throw new RemoteComputeError("command is required");
    if (command.length > MAX_COMMAND_CHARS) throw new RemoteComputeError(`command exceeds ${MAX_COMMAND_CHARS} characters`);
    const timeoutSeconds = Math.min(MAX_EXECUTE_TIMEOUT_SECONDS, Math.max(1, Number(input.timeout_seconds ?? DEFAULT_EXECUTE_TIMEOUT_SECONDS)));
    const summary = machineSummary(machine);
    const execution = await executionRepository.start(cwd, {
      kind: "job",
      surface: "ssh",
      producer: "remote-compute-service",
      // contracts model request.command as a string array; keep the raw command
      // as its single element so Runs search and previews stay schema-valid.
      request: { tool: "remote_execute", machine: summary.label, command: [command.slice(0, 4_000)], timeout_seconds: timeoutSeconds },
      runtime: { host: summary.host, user: summary.user, port: summary.port },
    });
    const run = await runSsh(machine, command, { timeoutMs: timeoutSeconds * 1_000 + 5_000, signal: input.signal }, deps);
    await executionRepository.finish(cwd, execution.execution_id, {
      status: executionStatus(run),
      producer: "remote-compute-service",
      result: {
        exit_code: run.exitCode,
        stdout_truncated: run.stdoutTruncated,
        stderr_truncated: run.stderrTruncated,
        stdout_bytes: run.stdout.length,
        duration_ms: run.durationMs,
      },
    });
    return { ...run, machine: summary, execution_id: execution.execution_id };
  },

  async slurmSubmit(cwd: string, input: { machine_label: string; script: string; name?: string; session_id?: string; signal?: AbortSignal }, deps: RemoteComputeDeps = {}): Promise<SlurmSubmitResult> {
    const machine = await resolveMachine(cwd, input.machine_label);
    if (machine.auth_method === "password") throw new RemoteComputeError(`Machine "${machine.label}" uses password authentication. Slurm submission requires a key-based machine.`);
    const script = String(input.script ?? "");
    if (!script.trim()) throw new RemoteComputeError("script is required");
    if (script.length > MAX_SCRIPT_CHARS) throw new RemoteComputeError(`script exceeds ${MAX_SCRIPT_CHARS} characters`);
    const rawName = String(input.name ?? "").trim();
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawName) ? rawName : "pi-science";
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const summary = machineSummary(machine);
    // base64 transport keeps the script out of shell quoting; sbatch reads it from /dev/stdin.
    const remoteCommand = `printf '%s' '${encoded}' | base64 -d | sbatch --job-name='${name}' --output='slurm-%j.out' --error='slurm-%j.err' /dev/stdin`;
    const execution = await executionRepository.start(cwd, {
      kind: "job",
      surface: "hpc",
      producer: "remote-compute-service",
      request: { machine: summary.label, slurm: true, name, script_chars: script.length },
      runtime: { host: summary.host, user: summary.user, port: summary.port },
    });
    const run = await runSsh(machine, remoteCommand, { timeoutMs: SLURM_TIMEOUT_MS, signal: input.signal }, deps);
    const match = /Submitted batch job (\d+)/.exec(run.stdout);
    await executionRepository.finish(cwd, execution.execution_id, {
      status: executionStatus(run),
      producer: "remote-compute-service",
      result: { exit_code: run.exitCode, slurm_job_id: match?.[1] ?? null },
    });
    if (!match) {
      throw new RemoteComputeError(
        `sbatch did not report a job id on "${summary.label}". Exit code ${run.exitCode ?? "null"}.\nstdout: ${run.stdout.slice(0, 2_000)}\nstderr: ${run.stderr.slice(0, 2_000)}`,
        502,
      );
    }
    const jobId = match[1]!;
    return { machine: summary, job_id: jobId, output_path: `slurm-${jobId}.out`, error_path: `slurm-${jobId}.err`, raw: run.stdout, execution_id: execution.execution_id };
  },

  async slurmCheck(cwd: string, input: { machine_label: string; job_id: string; include_output?: boolean; signal?: AbortSignal }, deps: RemoteComputeDeps = {}): Promise<SlurmCheckResult> {
    const machine = await resolveMachine(cwd, input.machine_label);
    const jobId = String(input.job_id ?? "").trim();
    if (!/^\d{1,20}$/.test(jobId)) throw new RemoteComputeError("job_id must be a Slurm numeric job id");
    const summary = machineSummary(machine);
    const includeOutput = input.include_output !== false;

    // squeue answers while the job lives; sacct covers accounting states after it ends.
    const statusCommand = `squeue -j ${jobId} -h -o '%T' 2>/dev/null; printf '\\001'; sacct -j ${jobId} -n -P -o State,ExitCode,Elapsed 2>/dev/null | head -n 1`;
    const status = await runSsh(machine, statusCommand, { timeoutMs: SLURM_TIMEOUT_MS, signal: input.signal }, deps);
    const [queuePart, acctPart] = status.stdout.split("\x01");
    const queueState = (queuePart ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(0) ?? "";
    const acctLine = (acctPart ?? "").trim();
    const [acctState = "", acctExit = "", acctElapsed = ""] = acctLine.split("|").map((part) => part.trim());
    const rawState = queueState || acctState;
    let state: SlurmJobState = "unknown";
    if (/^RUNNING|^COMPLETING|^CONFIGURING/i.test(rawState)) state = "running";
    else if (/^PENDING|^REQUEUE|^SUSPENDED/i.test(rawState)) state = "pending";
    else if (/^COMPLETED/i.test(rawState)) state = "completed";
    else if (/^TIMEOUT|^DEADLINE/i.test(rawState)) state = "timeout";
    else if (/^CANCELLED/i.test(rawState)) state = "cancelled";
    else if (/^FAILED|^OUT_OF_MEMORY|^NODE_FAIL|^PREEMPTED/i.test(rawState)) state = "failed";

    let stdoutTail: string | null = null;
    let stderrTail: string | null = null;
    if (includeOutput && (state === "completed" || state === "failed" || state === "timeout" || state === "cancelled" || (state === "unknown" && !queueState))) {
      const outputCommand = `tail -c ${MAX_TAIL_BYTES} 'slurm-${jobId}.out' 2>/dev/null; printf '\\001'; tail -c 16384 'slurm-${jobId}.err' 2>/dev/null`;
      const output = await runSsh(machine, outputCommand, { timeoutMs: SLURM_TIMEOUT_MS, maxStdoutBytes: MAX_TAIL_BYTES + 16_384 + 16, signal: input.signal }, deps);
      const [outPart = "", errPart = ""] = output.stdout.split("\x01");
      stdoutTail = outPart.length ? outPart : null;
      stderrTail = errPart.length ? errPart : null;
    }

    return {
      machine: summary,
      job_id: jobId,
      state,
      raw_state: rawState || "UNKNOWN",
      exit_code: acctExit || null,
      elapsed: acctElapsed || null,
      finished: state === "completed" || state === "failed" || state === "timeout" || state === "cancelled",
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
    };
  },
};
