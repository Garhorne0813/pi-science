import { spawn, type ChildProcess } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { workspacePolicy, identifyPolicy, operatorExecutionMode, isWithin } from "../runtime/sandbox/policy.js";
import { bashDependencies } from "../runtime/sandbox/settings.js";
import { prepareSandbox, launcherPath, killSandboxGroup, type PreparedSandbox } from "../runtime/sandbox/process.js";
import { readRegularFile } from "../runtime/sandbox/file-read.js";
import { configRoot } from "../storage/persistence.js";

export async function localMcpTransport(workspace: string, command: string, args: string[], cwd: string, environment: Record<string, string>, builtinName?: string): Promise<Transport> {
  if (operatorExecutionMode() === "trusted-host") return new StdioClientTransport({ command, args, cwd, env: environment, stderr: "pipe" });
  workspace = await realpath(workspace); cwd = await realpath(cwd);
  if (!isWithin(workspace, cwd)) throw new Error("Local MCP cwd must remain inside the workspace");
  let executable: string | undefined;
  for (const path of isAbsolute(command) ? [command] : command === "node" ? [process.execPath] : [join("/usr/bin", command), join("/bin", command)]) {
    if (!isAbsolute(command) && command.includes("/")) throw new Error("MCP commands require a trusted executable");
    try { await access(path, constants.X_OK); executable = await realpath(path); break; } catch { /* try the next fixed system directory */ }
  }
  if (!executable) throw new Error("MCP executable is unavailable; install it through environment management first");
  const policy = await workspacePolicy(workspace, undefined, "mcp");
  const dependencies = [...new Set([...bashDependencies(), executable, fileURLToPath(new URL("../", import.meta.url)), fileURLToPath(new URL("../../../../node_modules", import.meta.url))])];
  // Source-mode TS loaders read package/tsconfig metadata. Grant only those
  // files, rather than opening the installation's parent directories.
  for (const relative of ["../../src", "../../dist", "../../node_modules", "../../package.json", "../../tsconfig.json", "../../../../package.json", "../../../../tsconfig.base.json"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    try { await access(path); dependencies.push(path); } catch { /* absent in a compiled installation */ }
  }
  // Normalize existing absolute path arguments (not code, flags or grants).
  // Node's ESM loader otherwise needs readlink permission on /var or /tmp,
  // which would reopen a broad host subtree under a deny-root read policy.
  const canonicalArgs = await Promise.all(args.map(async (arg) => {
    if (!isAbsolute(arg)) return arg;
    try { return await realpath(arg); } catch { return arg; }
  }));
  if (builtinName === "web-access") {
    let settings = "{}";
    try { settings = (await readRegularFile(join(await realpath(configRoot()), "mcp", "web-access", "config.json"), 64 * 1024)).toString("utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    environment = { ...environment, PI_SCIENCE_WEB_ACCESS_CONFIG_JSON: settings };
  }
  // Only this connector's explicitly bound environment is passed to its child.
  const prepared = await prepareSandbox(identifyPolicy({ ...policy, cwd }), [executable, ...canonicalArgs], dependencies, 86_400, undefined, undefined, environment);
  return new SandboxedMcpTransport(prepared, cwd);
}

class SandboxedMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private readonly buffer = new ReadBuffer();
  private closed?: Promise<void>;
  constructor(private readonly prepared: PreparedSandbox, private readonly cwd: string) {}
  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error("MCP transport already started or closed");
    const child = spawn(process.execPath, [launcherPath, this.prepared.manifest], { cwd: this.cwd, env: this.prepared.env, detached: true, shell: false, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    this.child = child;
    child.stdout!.on("data", (chunk: Buffer) => {
      try { this.buffer.append(chunk); for (;;) { const message = this.buffer.readMessage(); if (message === null) break; this.onmessage?.(message); } }
      catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); void this.close(); }
    });
    child.stderr!.resume();
    child.on("error", (error) => this.onerror?.(error));
    child.once("close", () => { this.buffer.clear(); void this.prepared.cleanup().catch(() => undefined); this.onclose?.(); });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child?.stdin || this.closed) throw new Error("MCP transport is not connected");
    await new Promise<void>((resolve, reject) => this.child!.stdin!.write(serializeMessage(message), (error) => error ? reject(error) : resolve()));
  }
  close(): Promise<void> {
    return this.closed ??= (async () => {
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        killSandboxGroup(child.pid);
        await exited;
      }
      await this.prepared.cleanup();
    })();
  }
}
