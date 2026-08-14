/** SSH executor for remote job dispatch (reverse-cs-inspiration 4.5).
 *  Reuses the catalog probe's argument assembly; the executor itself is
 *  injectable so the coordinator can be tested without a real host. */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface ComputeMachine {
  label: string;
  host: string;
  user?: string;
  port?: number;
  identity_file?: string;
  auth_method?: "key" | "password";
}

export interface RemoteExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface SshExecutor {
  /** Run one remote command (its stdin carries `stdin` when given). */
  run(machine: ComputeMachine, remoteCommand: string, stdin?: string, timeoutMs?: number): Promise<RemoteExecResult>;
}

export function expandUserPath(path: string): string {
  return path.startsWith("~") ? join(process.env.HOME ?? "", path.slice(1)) : path;
}

function buildSshArgs(machine: ComputeMachine, password: string | undefined): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const host = String(machine.host ?? "").trim();
  const user = String(machine.user ?? "").trim();
  const port = Number(machine.port ?? 22);
  const sshArgs = [
    "-o", "ConnectTimeout=8",
    "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=1",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", String(port),
  ];
  const env = { ...process.env };
  if (machine.auth_method === "password") {
    env.SSHPASS = String(password ?? "");
    return { command: "sshpass", args: ["-e", "ssh", ...sshArgs, "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"], env };
  }
  const keyPath = expandUserPath(String(machine.identity_file ?? "~/.ssh/id_rsa"));
  return { command: "ssh", args: [...sshArgs, "-o", "BatchMode=yes", "-i", keyPath], env };
}

/** Validate a machine's host/port fields; returns an error string or null. */
export function validateMachine(machine: ComputeMachine): string | null {
  const host = String(machine.host ?? "").trim();
  const port = Number(machine.port ?? 22);
  if (!host || host.startsWith("-") || !/^[a-zA-Z0-9._:[]-]+$/.test(host)) return "Invalid SSH hostname";
  if (machine.user && !/^[a-zA-Z0-9._-]+$/.test(String(machine.user))) return "Invalid SSH username";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "SSH port must be between 1 and 65535";
  return null;
}

/** Concrete executor over system ssh/sshpass. */
export class SystemSshExecutor implements SshExecutor {
  constructor(private readonly passwordProvider: (machine: ComputeMachine) => string | undefined = () => undefined) {}

  async run(machine: ComputeMachine, remoteCommand: string, stdin?: string, timeoutMs = 60_000): Promise<RemoteExecResult> {
    const validation = validateMachine(machine);
    if (validation) return { success: false, stdout: "", stderr: validation, exitCode: null };
    const password = machine.auth_method === "password" ? this.passwordProvider(machine) : undefined;
    const { command, args, env } = buildSshArgs(machine, password);
    if (machine.auth_method === "key") {
      try { await access(expandUserPath(String(machine.identity_file ?? "~/.ssh/id_rsa"))); }
      catch { return { success: false, stdout: "", stderr: `SSH key not found: ${machine.identity_file ?? "~/.ssh/id_rsa"}`, exitCode: null }; }
    }
    const target = machine.user ? `${machine.user}@${machine.host}` : String(machine.host);
    args.push(target, remoteCommand);
    return await new Promise((resolve) => {
      const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ success: false, stdout, stderr: stderr + "\n(remote command timed out)", exitCode: null });
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, stdout, stderr: error.message, exitCode: null });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: code === 0, stdout, stderr, exitCode: code });
      });
      if (stdin !== undefined) {
        child.stdin.write(stdin, "utf8", () => child.stdin.end());
      } else {
        child.stdin.end();
      }
    });
  }
}
