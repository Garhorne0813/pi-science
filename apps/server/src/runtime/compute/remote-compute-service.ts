/**
 * Remote compute execution over SSH.
 *
 * The control plane owns machine resolution, command dispatch, bounded output
 * capture and execution records. Machines are registered in the workspace
 * `compute.json` registry (Settings → Compute) and only key-based identities
 * can run executions; registered passwords are never persisted, so password
 * probes stay one-off and execution refuses them explicitly.
 *
 * Remote commands run under a watchdog on the remote host: it stops the
 * command's process group when the SSH channel closes or the deadline passes,
 * and reports which watcher fired, so the client can tell a confirmed remote
 * stop from a local-only kill of the SSH client.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { ExecutionCorrelation } from "@pi-science/contracts";
import { readJson, workspaceFile } from "../../storage/persistence.js";
import { executionIdFor, executionRepository } from "../executions/execution-repository.js";
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

/** `confirmed` means the remote watchdog printed its marker; `unconfirmed` means only the local ssh client was stopped. */
export type RemoteStop = "not_required" | "confirmed" | "unconfirmed";

export interface SshRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  remoteStop: RemoteStop;
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
  job_execution_id: string;
}

export type SlurmJobState = "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout" | "unknown";

export type SlurmQueryStatus = "ok" | "no_records";

export interface SlurmCheckResult {
  machine: MachineSummary;
  job_id: string;
  state: SlurmJobState;
  raw_state: string;
  exit_code: string | null;
  elapsed: string | null;
  finished: boolean;
  query_status: SlurmQueryStatus;
  output_path: string;
  stdout_tail: string | null;
  stderr_tail: string | null;
  job_execution_id: string | null;
}

export class RemoteComputeError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "RemoteComputeError";
  }
}

type SpawnFn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;

export interface RemoteComputeDeps {
  spawn?: SpawnFn;
  now?: () => number;
}

const MAX_STDOUT_BYTES = 2_097_152;
const MAX_STDERR_BYTES = 262_144;
export const MAX_COMMAND_CHARS = 32_768;
export const MAX_SCRIPT_CHARS = 65_536;
const DEFAULT_EXECUTE_TIMEOUT_SECONDS = 300;
const MAX_EXECUTE_TIMEOUT_SECONDS = 600;
const SLURM_TIMEOUT_SECONDS = 60;
const MAX_TAIL_BYTES = 65_536;
/** Runs keeps this much of each stream; larger output is dropped rather than silently claimed as recoverable. */
export const RECORD_STDOUT_CHARS = 16_384;
export const RECORD_STDERR_CHARS = 4_096;
const LOCAL_KILL_GRACE_MS = 3_000;
const WATCHDOG_MARK = "[pi-science] watchdog:";

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
  // The key existence check mirrors the probe path so failures surface before the record exists.
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Wrap a remote command so the remote host owns the deadline and the cleanup.
 * The command runs in its own process group; a watcher kills the whole group
 * when stdin hits EOF (the SSH channel closed) and a timer does the same at the
 * deadline. Each watcher records why it fired, and the wrapper prints that
 * reason after the command ends, which is how the caller learns the stop was
 * remote and not just a local ssh kill.
 */
export function remoteWatchdogCommand(command: string, timeoutSeconds: number): string {
  // The watchers keep no inherited pipe and report through a state file, so the
  // SSH channel closes as soon as the command exits, whatever killed it.
  const mark = "${TMPDIR:-/tmp}/pi-science-watch-$$";
  const stop = (reason: string) => `printf '${reason}' > "$__pi_mark"; kill -TERM -$__pi_pid 2>/dev/null || kill -TERM $__pi_pid 2>/dev/null; sleep 2; kill -KILL -$__pi_pid 2>/dev/null || kill -KILL $__pi_pid 2>/dev/null`;
  return [
    `__pi_mark=${mark}`,
    "set -m 2>/dev/null",
    `( eval ${shellQuote(command)} ) < /dev/null & __pi_pid=$!`,
    `( while read -r __pi_line; do :; done; ${stop("disconnect")} ) > /dev/null 2>&1 & __pi_watch=$!`,
    `( sleep ${Math.max(1, Math.ceil(timeoutSeconds))}; ${stop("deadline")} ) > /dev/null 2>&1 & __pi_timer=$!`,
    "wait $__pi_pid 2>/dev/null; __pi_status=$?",
    // Detach the watchers first so the login shell does not print job-control
    // notices into the command's stderr.
    "disown -a 2>/dev/null",
    "kill -TERM -$__pi_watch -$__pi_timer 2>/dev/null || kill $__pi_watch $__pi_timer 2>/dev/null",
    `[ -s "$__pi_mark" ] && printf '${WATCHDOG_MARK} %s\\n' "$(cat "$__pi_mark")" >&2`,
    `rm -f "$__pi_mark"`,
    "wait 2>/dev/null",
    "exit $__pi_status",
  ].join("\n");
}

function stripWatchdogLines(value: string): string {
  if (!value.includes(WATCHDOG_MARK)) return value;
  return value.split(/\r?\n/).filter((line) => !line.startsWith(WATCHDOG_MARK)).join("\n");
}

interface SshRunOptions {
  timeoutSeconds: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

async function runSsh(machine: ComputeMachine, remoteCommand: string, options: SshRunOptions, deps: RemoteComputeDeps = {}): Promise<SshRunResult> {
  const spawnFn = deps.spawn ?? (spawn as unknown as SpawnFn);
  const now = deps.now ?? Date.now;
  const { command, args } = await buildSshInvocation(machine);
  const child = spawnFn(command, [...args, remoteWatchdogCommand(remoteCommand, options.timeoutSeconds)], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  let stdoutCaptured = 0;
  let stderrCaptured = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const maxStderr = options.maxStderrBytes ?? MAX_STDERR_BYTES;
  let timedOut = false;
  let aborted = false;
  const startedAt = now();

  return await new Promise<SshRunResult>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const remoteStop: RemoteStop = !timedOut && !aborted ? "not_required" : stderr.includes(WATCHDOG_MARK) ? "confirmed" : "unconfirmed";
      resolve({
        exitCode,
        stdout,
        stderr: stripWatchdogLines(stderr),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted,
        remoteStop,
        durationMs: now() - startedAt,
      });
    };
    const hardKill = () => {
      if (child.killed) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2_000);
    };
    // Closing the channel gives the remote watchdog a clean EOF, so an aborted run
    // can still stop remote work before the local process is signalled.
    const closeChannel = () => { try { child.stdin?.end(); } catch { /* the channel may already be gone */ } };
    const onAbort = () => {
      aborted = true;
      closeChannel();
      graceTimer = setTimeout(hardKill, LOCAL_KILL_GRACE_MS);
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // Decode only complete characters: a chunk boundary or the capture limit can
    // split a multi-byte sequence, and the decoder keeps the remainder.
    const capture = (chunk: Buffer, decoder: StringDecoder, used: number, cap: number) => {
      if (used >= cap) return { text: "", used, cut: true };
      const slice = chunk.length > cap - used ? chunk.subarray(0, cap - used) : chunk;
      return { text: decoder.write(slice), used: used + slice.length, cut: slice.length < chunk.length };
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      const part = capture(chunk, stdoutDecoder, stdoutCaptured, maxStdout);
      stdout += part.text;
      stdoutCaptured = part.used;
      if (part.cut) stdoutTruncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      const part = capture(chunk, stderrDecoder, stderrCaptured, maxStderr);
      stderr += part.text;
      stderrCaptured = part.used;
      if (part.cut) stderrTruncated = true;
    });
    child.on("error", (error) => {
      stderr = stderr ? `${stderr}\n${String(error.message)}` : String(error.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));

    deadlineTimer = setTimeout(() => {
      timedOut = true;
      // The remote timer owns the deadline. Give it time to report, then stop the
      // local client and mark the remote stop unconfirmed.
      graceTimer = setTimeout(hardKill, LOCAL_KILL_GRACE_MS);
    }, options.timeoutSeconds * 1_000);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort);
  });
}

function executionStatus(run: SshRunResult): "succeeded" | "failed" | "cancelled" | "timed_out" {
  if (run.aborted) return "cancelled";
  if (run.timedOut) return "timed_out";
  return run.exitCode === 0 ? "succeeded" : "failed";
}

function correlationFor(input: { session_id?: string; tool_call_id?: string; operation_id?: string }): ExecutionCorrelation {
  return {
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}),
    ...(input.operation_id ? { operation_id: input.operation_id } : {}),
  };
}

const QUEUE_STATE = /^[A-Z_]+$/;
const ACCOUNT_ROW = /^([A-Z_]+)\|([^|]*)\|([^|]*)$/;

// The probe frames each answer as marker + exit code + marker + body. C0 markers keep
// scheduler text from impersonating a frame, so they are read as delimiters, not matched.
function framedBody(text: string | undefined, marker: string): string | null {
  if (!text?.startsWith(marker)) return null;
  const rest = text.slice(1);
  const end = rest.indexOf(marker);
  return end > 0 && /^\d+$/.test(rest.slice(0, end)) ? rest.slice(end + 1) : null;
}

function parseSchedulerQuery(stdout: string): { queueText: string; acctText: string } | null {
  const [queuePart, acctPart] = stdout.split("\x02");
  const queue = framedBody(queuePart, "\x01");
  const acct = framedBody(acctPart, "\x03");
  return queue !== null && acct !== null ? { queueText: queue, acctText: acct } : null;
}

function schedulerLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function jobStateFor(raw: string): SlurmJobState {
  if (/^RUNNING|^COMPLETING|^CONFIGURING|^STAGE_OUT|^RESIZING/i.test(raw)) return "running";
  if (/^PENDING|^REQUEUE|^SUSPEND/i.test(raw)) return "pending";
  if (/^COMPLETED/i.test(raw)) return "completed";
  if (/^TIMEOUT|^DEADLINE/i.test(raw)) return "timeout";
  if (/^CANCELLED/i.test(raw)) return "cancelled";
  if (/^FAILED|^OUT_OF_MEMORY|^NODE_FAIL|^PREEMPTED|^BOOT_FAIL/i.test(raw)) return "failed";
  return "unknown";
}

const STATE_RANK: Record<SlurmJobState, number> = { unknown: 0, completed: 1, pending: 2, running: 3, cancelled: 4, timeout: 5, failed: 6 };

/** Aggregate array elements and accounting steps so one failed element cannot hide behind a completed one. */
function worstState(states: string[]): SlurmJobState {
  return states.map(jobStateFor).reduce<SlurmJobState>((worst, next) => STATE_RANK[next] > STATE_RANK[worst] ? next : worst, "unknown");
}

export const remoteComputeService = {
  async listMachines(cwd: string): Promise<MachineSummary[]> {
    const machines = await readMachines(cwd);
    return machines.map(machineSummary).filter((item) => item.label && item.host);
  },

  async execute(cwd: string, input: { machine_label: string; command: string; timeout_seconds?: number; session_id?: string; tool_call_id?: string; operation_id?: string; signal?: AbortSignal }, deps: RemoteComputeDeps = {}): Promise<RemoteExecuteResult> {
    const machine = await resolveMachine(cwd, input.machine_label);
    const command = String(input.command ?? "");
    if (!command.trim()) throw new RemoteComputeError("command is required");
    if (command.length > MAX_COMMAND_CHARS) throw new RemoteComputeError(`command exceeds ${MAX_COMMAND_CHARS} characters`);
    const timeoutSeconds = Math.min(MAX_EXECUTE_TIMEOUT_SECONDS, Math.max(1, Number(input.timeout_seconds ?? DEFAULT_EXECUTE_TIMEOUT_SECONDS)));
    const summary = machineSummary(machine);
    // Identity checks run before the record exists so a missing key cannot leave a
    // permanently running Runs entry behind.
    await buildSshInvocation(machine);
    const execution = await executionRepository.start(cwd, {
      kind: "job",
      surface: "ssh",
      producer: "remote-compute-service",
      correlation: correlationFor(input),
      request: {
        tool: "remote_execute",
        machine: summary.label,
        // contracts model request.command as a string array; keep the raw command
        // as its single element so Runs search and previews stay schema-valid.
        command: [command],
        timeout_seconds: timeoutSeconds,
      },
      runtime: { host: summary.host, user: summary.user, port: summary.port },
    });
    try {
      const run = await runSsh(machine, command, { timeoutSeconds, signal: input.signal }, deps);
      await executionRepository.finish(cwd, execution.execution_id, {
        status: executionStatus(run),
        producer: "remote-compute-service",
        result: {
          exit_code: run.exitCode,
          duration_ms: run.durationMs,
          stdout_bytes: run.stdoutBytes,
          stderr_bytes: run.stderrBytes,
          stdout_truncated: run.stdoutTruncated,
          stderr_truncated: run.stderrTruncated,
          stdout_preview: run.stdout.slice(0, RECORD_STDOUT_CHARS),
          stderr_preview: run.stderr.slice(0, RECORD_STDERR_CHARS),
          remote_stop: run.remoteStop,
        },
      });
      return { ...run, machine: summary, execution_id: execution.execution_id };
    } catch (error) {
      await executionRepository.finish(cwd, execution.execution_id, { status: "failed", producer: "remote-compute-service", result: { error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  },

  async slurmSubmit(cwd: string, input: { machine_label: string; script: string; name?: string; session_id?: string; tool_call_id?: string; operation_id?: string; signal?: AbortSignal }, deps: RemoteComputeDeps = {}): Promise<SlurmSubmitResult> {
    const machine = await resolveMachine(cwd, input.machine_label);
    if (machine.auth_method === "password") throw new RemoteComputeError(`Machine "${machine.label}" uses password authentication. Slurm submission requires a key-based machine.`);
    const script = String(input.script ?? "");
    if (!script.trim()) throw new RemoteComputeError("script is required");
    if (script.length > MAX_SCRIPT_CHARS) throw new RemoteComputeError(`script exceeds ${MAX_SCRIPT_CHARS} characters`);
    if (/^\s*#SBATCH[^\n]*--array\b/im.test(script)) throw new RemoteComputeError("Array jobs (#SBATCH --array) are not supported: slurm_check reports and records one job at a time. Submit one job per call.");
    const rawName = String(input.name ?? "").trim();
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawName) ? rawName : "pi-science";
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const summary = machineSummary(machine);
    await buildSshInvocation(machine);
    // Absolute output paths stay discoverable even when the script sets
    // #SBATCH --chdir, which moves the job's working directory.
    const remoteCommand = [
      "__pi_dir=$(pwd)",
      `printf '%s' '${encoded}' | base64 -d | sbatch --job-name='${name}' --output="$__pi_dir/slurm-%j.out" --error="$__pi_dir/slurm-%j.err" /dev/stdin`,
      "__pi_status=$?",
      `printf 'PI-SCIENCE-DIR=%s\\n' "$__pi_dir"`,
      "exit $__pi_status",
    ].join("; ");
    const execution = await executionRepository.start(cwd, {
      kind: "job",
      surface: "hpc",
      producer: "remote-compute-service",
      correlation: correlationFor(input),
      request: { tool: "slurm_submit", machine: summary.label, name, script_chars: script.length },
      runtime: { host: summary.host, user: summary.user, port: summary.port },
    });
    let run: SshRunResult;
    try {
      run = await runSsh(machine, remoteCommand, { timeoutSeconds: SLURM_TIMEOUT_SECONDS, signal: input.signal }, deps);
    } catch (error) {
      await executionRepository.finish(cwd, execution.execution_id, { status: "failed", producer: "remote-compute-service", result: { error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
    const match = /Submitted batch job (\d+)/.exec(run.stdout);
    const directory = /PI-SCIENCE-DIR=(.+)/.exec(run.stdout)?.[1]?.trim();
    if (!match) {
      await executionRepository.finish(cwd, execution.execution_id, {
        status: executionStatus(run),
        producer: "remote-compute-service",
        result: { exit_code: run.exitCode, slurm_job_id: null, stdout_preview: run.stdout.slice(0, RECORD_STDOUT_CHARS), stderr_preview: run.stderr.slice(0, RECORD_STDERR_CHARS) },
      });
      throw new RemoteComputeError(
        `sbatch did not report a job id on "${summary.label}". Exit code ${run.exitCode ?? "null"}.\nstdout: ${run.stdout.slice(0, 2_000)}\nstderr: ${run.stderr.slice(0, 2_000)}`,
        502,
      );
    }
    const jobId = match[1]!;
    const outputPath = directory ? `${directory}/slurm-${jobId}.out` : `slurm-${jobId}.out`;
    const errorPath = directory ? `${directory}/slurm-${jobId}.err` : `slurm-${jobId}.err`;
    await executionRepository.finish(cwd, execution.execution_id, {
      status: executionStatus(run),
      producer: "remote-compute-service",
      result: {
        exit_code: run.exitCode,
        // sbatch succeeding means the submission was accepted, not that the job
        // succeeded; the job record tracks the scheduler state from slurm_check.
        slurm_phase: "submitted",
        slurm_job_id: jobId,
        output_path: outputPath,
        error_path: errorPath,
        remote_stop: run.remoteStop,
      },
    });
    const jobExecutionId = executionIdFor(cwd, "slurm-job", summary.label, jobId);
    await executionRepository.start(cwd, {
      execution_id: jobExecutionId,
      kind: "job",
      surface: "hpc",
      producer: "remote-compute-service",
      correlation: { ...correlationFor(input), job_id: jobId },
      request: { tool: "slurm_job", machine: summary.label, job_id: jobId, name, output_path: outputPath, error_path: errorPath },
      runtime: { host: summary.host, user: summary.user, port: summary.port },
    });
    return { machine: summary, job_id: jobId, output_path: outputPath, error_path: errorPath, raw: run.stdout, execution_id: execution.execution_id, job_execution_id: jobExecutionId };
  },

  async slurmCheck(cwd: string, input: { machine_label: string; job_id: string; include_output?: boolean; signal?: AbortSignal }, deps: RemoteComputeDeps = {}): Promise<SlurmCheckResult> {
    const machine = await resolveMachine(cwd, input.machine_label);
    const jobId = String(input.job_id ?? "").trim();
    if (!/^\d{1,20}$/.test(jobId)) throw new RemoteComputeError("job_id must be a Slurm numeric job id");
    const summary = machineSummary(machine);
    const includeOutput = input.include_output !== false;
    const jobExecutionId = executionIdFor(cwd, "slurm-job", summary.label, jobId);
    const jobRecord = await executionRepository.get(cwd, jobExecutionId);
    const outputPath = typeof jobRecord?.request.output_path === "string" ? jobRecord.request.output_path : `slurm-${jobId}.out`;
    const errorPath = typeof jobRecord?.request.error_path === "string" ? jobRecord.request.error_path : `slurm-${jobId}.err`;

    // squeue answers while the job lives; sacct covers accounting states after it
    // ends. Both report their exit status so a broken connection or scheduler is
    // not mistaken for a missing job.
    const statusCommand = [
      `__sq=$(squeue -j ${jobId} -h -o '%T' 2>&1); __sqs=$?; printf '\\001%s\\001%s' "$__sqs" "$__sq"`,
      `printf '\\002'`,
      `__sa=$(sacct -j ${jobId} -n -P -o State,ExitCode,Elapsed 2>&1); __sas=$?; printf '\\003%s\\003%s' "$__sas" "$__sa"`,
    ].join("\n");
    const status = await runSsh(machine, statusCommand, { timeoutSeconds: SLURM_TIMEOUT_SECONDS, signal: input.signal }, deps);
    const parsed = parseSchedulerQuery(status.stdout);
    if (!parsed) {
      throw new RemoteComputeError(`Scheduler query failed on "${summary.label}": ${(status.stderr || `ssh exit ${status.exitCode ?? "null"}`).slice(0, 2_000)}`, 502);
    }
    const queueStates = schedulerLines(parsed.queueText).filter((line) => QUEUE_STATE.test(line));
    const acctRows = schedulerLines(parsed.acctText).flatMap((line) => {
      const row = ACCOUNT_ROW.exec(line);
      return row ? [{ state: row[1]!, exit: row[2]!.trim(), elapsed: row[3]!.trim() }] : [];
    });
    const noise = [
      ...schedulerLines(parsed.queueText).filter((line) => !QUEUE_STATE.test(line)),
      ...schedulerLines(parsed.acctText).filter((line) => !ACCOUNT_ROW.test(line)),
    ];
    // A scheduler that answers "no such job" is a valid empty answer; anything else
    // in the output is an error and must not be reported as an unknown job.
    const noRecords = /invalid job id|not found|no job/i.test(noise.join(" "));
    if (!queueStates.length && !acctRows.length && noise.length && !noRecords) {
      throw new RemoteComputeError(`Scheduler query failed on "${summary.label}": ${noise.join(" ").slice(0, 2_000)}`, 502);
    }
    const observed = [...queueStates, ...acctRows.map((row) => row.state)];
    const state: SlurmJobState = observed.length ? worstState(observed) : "unknown";
    const rawState = [...new Set(observed)].join(",") || "UNKNOWN";
    const finished = state === "completed" || state === "failed" || state === "timeout" || state === "cancelled";

    let stdoutTail: string | null = null;
    let stderrTail: string | null = null;
    if (includeOutput && (finished || state === "unknown")) {
      const outputCommand = `tail -c ${MAX_TAIL_BYTES} -- ${shellQuote(outputPath)} 2>/dev/null; printf '\\001'; tail -c 16384 -- ${shellQuote(errorPath)} 2>/dev/null`;
      const output = await runSsh(machine, outputCommand, { timeoutSeconds: SLURM_TIMEOUT_SECONDS, maxStdoutBytes: MAX_TAIL_BYTES + 16_384 + 16, signal: input.signal }, deps);
      const [outPart = "", errPart = ""] = output.stdout.split("\x01");
      stdoutTail = outPart.length ? outPart : null;
      stderrTail = errPart.length ? errPart : null;
    }

    if (jobRecord && finished && jobRecord.status === "running") {
      await executionRepository.finish(cwd, jobExecutionId, {
        status: state === "completed" ? "succeeded" : state === "cancelled" ? "cancelled" : state === "timeout" ? "timed_out" : "failed",
        producer: "remote-compute-service",
        result: {
          state,
          raw_state: rawState,
          slurm_exit_code: acctRows[0]?.exit ?? null,
          elapsed: acctRows[0]?.elapsed ?? null,
          stdout_preview: stdoutTail?.slice(0, RECORD_STDOUT_CHARS),
          stderr_preview: stderrTail?.slice(0, RECORD_STDERR_CHARS),
          query_status: "ok",
        },
      });
    }

    return {
      machine: summary,
      job_id: jobId,
      state,
      raw_state: rawState,
      exit_code: acctRows[0]?.exit ?? null,
      elapsed: acctRows[0]?.elapsed ?? null,
      finished,
      query_status: observed.length ? "ok" : "no_records",
      output_path: outputPath,
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
      job_execution_id: jobRecord ? jobExecutionId : null,
    };
  },
};
