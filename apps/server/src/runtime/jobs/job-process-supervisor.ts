import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { JobChildIdentity, JobProcessIdentity } from "./job-types.js";

const KILL_GRACE_MS = 2_000;
const PROCESS_CLOSE_FAILSAFE_MS = 5_000;
const WINDOWS_EXIT_DRAIN_MS = 1_000;
const MAX_OUTPUT_BYTES = 100_000;

export interface SpawnedJobProcess {
  child: ChildProcess;
  identity: JobChildIdentity;
  result: Promise<JobProcessResult>;
}

export interface JobProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
}

export interface ProcessSupervisorOptions {
  platform?: NodeJS.Platform;
  childStartIdentity?: (pid: number, platform: NodeJS.Platform) => JobProcessIdentity | null;
}

/** Owns child-process lifecycle and output buffering for one coordinator. */
export class ProcessSupervisor {
  private readonly children = new Map<string, ChildProcess>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: ProcessSupervisorOptions = {}) {
    this.platform = options.platform ?? process.platform;
  }

  spawn(jobId: string, command: string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number): SpawnedJobProcess {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.platform !== "win32",
    });
    this.children.set(jobId, child);

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const appendTail = (current: Buffer, chunk: Buffer, markTruncated: () => void) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > MAX_OUTPUT_BYTES) markTruncated();
      return combined.subarray(-MAX_OUTPUT_BYTES);
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk, () => { stdoutTruncated = true; }); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk, () => { stderrTruncated = true; }); });

    let timedOut = false;
    const result = new Promise<JobProcessResult>((resolve) => {
      let timeoutTimer: NodeJS.Timeout | undefined;
      let closeFailsafe: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (closeFailsafe) clearTimeout(closeFailsafe);
        resolve({
          code,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
          timed_out: timedOut,
        });
      };
      child.once("close", (code) => finish(code));
      child.once("exit", (code) => {
        if (this.platform !== "win32" && !timedOut && !settled) return;
        if (this.platform === "win32" && !timedOut && !settled) {
          closeFailsafe = setTimeout(() => finish(code), WINDOWS_EXIT_DRAIN_MS);
          closeFailsafe.unref();
        }
      });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
        closeFailsafe = setTimeout(() => finish(null), PROCESS_CLOSE_FAILSAFE_MS);
        closeFailsafe.unref();
      }, Math.max(1, timeoutMs));
      timeoutTimer.unref();
    });

    const identity: JobChildIdentity = {
      pid: child.pid!,
      process_identity: this.options.childStartIdentity?.(child.pid!, this.platform) ?? childProcessIdentity(child.pid!, this.platform),
      process_group: this.platform !== "win32",
      platform: this.platform,
      ownership_generation: 0,
      ownership_token: "",
    };
    return { child, identity, result };
  }

  get(jobId: string): ChildProcess | undefined {
    return this.children.get(jobId);
  }

  terminate(jobId: string): void;
  terminate(child: ChildProcess): void;
  terminate(jobOrChild: string | ChildProcess): void {
    const child = typeof jobOrChild === "string" ? this.children.get(jobOrChild) : jobOrChild;
    if (child) terminate(child);
  }

  forget(jobId: string): void {
    this.children.delete(jobId);
  }

  async shutdown(): Promise<void> {
    for (const child of this.children.values()) terminate(child);
  }

  reap(identity: JobChildIdentity): "reaped" | "identity-mismatch" | "unverifiable" | "missing" {
    return reapPersistedChild(identity, this.platform);
  }
}

export function windowsTaskkillArgs(pid: number): string[] {
  return ["/pid", String(pid), "/T", "/F"];
}

/** Asks the whole job process group to stop, then forces it after a short grace. */
function terminate(child: ChildProcess): void {
  killGroup(child, "SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* the group is already gone or was never created */ }
  }
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", windowsTaskkillArgs(child.pid), { stdio: "ignore", windowsHide: true });
    killer.once("error", () => child.kill(signal));
    return;
  }
  child.kill(signal);
}

function childProcessIdentity(pid: number, platform: NodeJS.Platform): JobProcessIdentity | null {
  if (platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const commandStart = stat.indexOf("(");
    const commandEnd = stat.lastIndexOf(")");
    if (commandStart < 1 || commandEnd <= commandStart || !/^\d+\s$/.test(stat.slice(0, commandStart))) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    return startTicks && /^\d+$/.test(startTicks) ? { kind: "linux-proc-start-ticks", value: startTicks } : null;
  } catch {
    return null;
  }
}

function reapPersistedChild(identity: JobChildIdentity, platform: NodeJS.Platform): "reaped" | "identity-mismatch" | "unverifiable" | "missing" {
  try { process.kill(identity.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unverifiable"; }
  if (platform !== identity.platform || platform !== "linux" || identity.process_identity?.kind !== "linux-proc-start-ticks") return "unverifiable";
  const current = childProcessIdentity(identity.pid, platform);
  if (!current || current.kind !== identity.process_identity.kind || current.value !== identity.process_identity.value) return "identity-mismatch";
  try { process.kill(identity.process_group ? -identity.pid : identity.pid, "SIGKILL"); return "reaped"; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unverifiable"; }
}
