import { spawn, execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { applySandboxProfile } from "./profiles.js";
import { canonicalDirectory, identifyPolicy, isWithin, operatorExecutionMode } from "./policy.js";
import { killSandboxGroup, launcherPath, prepareSandbox, type PreparedSandbox } from "./process.js";

/** Installers receive a new revision prefix and package cache, never workspaces,
 * credentials, the service state root or any previously published environment. */
export async function runEnvironmentProcess(command: string, args: string[], prefix: string, cache: string | undefined, timeoutMs: number, environment: Record<string, string> = {}): Promise<void> {
  await mkdir(prefix, { recursive: true }); prefix = await canonicalDirectory(await realpath(prefix));
  if (cache) { await mkdir(cache, { recursive: true }); cache = await canonicalDirectory(await realpath(cache)); }
  const mode = operatorExecutionMode();
  const executable = await realpath(isAbsolute(command) ? command : (await promisify(execFile)("/usr/bin/which", [command], { env: { PATH: process.env.PATH }, timeout: 5000 })).stdout.trim());
  let prepared: PreparedSandbox | undefined;
  try {
    if (mode === "required") {
      const policy = await applySandboxProfile(identifyPolicy({ mode, scope: "workspace", cwd: prefix, readPaths: [prefix, ...(cache ? [cache] : [])],
        writePaths: cache ? [prefix, cache] : [], denyPaths: [], network: { mode: "none" } }), cache ? "install" : "control");
      // A health check reads the installed prefix. The install executable must
      // be outside its writable target; package scripts remain inside it.
      if (cache && [prefix, cache].some((root) => isWithin(root, executable))) throw new Error("Installer executable overlaps writable environment paths");
      prepared = await prepareSandbox(policy, [executable, ...args], [...new Set([executable, ...(!cache ? [prefix] : [])])], Math.ceil(timeoutMs / 1000), undefined, undefined, environment);
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(prepared ? process.execPath : executable, prepared ? [launcherPath, prepared.manifest] : args, {
        cwd: prefix, env: prepared?.env ?? environment, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = "", timedOut = false, overflow = false;
      const timer = setTimeout(() => { timedOut = true; killSandboxGroup(child.pid); }, timeoutMs);
      for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(output) + chunk.length > 1024 * 1024) { overflow = true; killSandboxGroup(child.pid); } else output += chunk.toString("utf8");
      });
      child.once("error", (error) => { clearTimeout(timer); killSandboxGroup(child.pid); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer); killSandboxGroup(child.pid);
        if (timedOut || overflow || code !== 0) reject(new Error(timedOut ? `Environment operation timed out after ${timeoutMs}ms` : overflow ? "Environment operation exceeded its output limit" : `Environment operation failed: ${output || `exit ${code}`}`));
        else resolve();
      });
    });
  } finally { await prepared?.cleanup(); }
}
