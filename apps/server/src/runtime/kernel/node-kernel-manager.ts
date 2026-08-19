import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import {
  workspaceEnvironmentVariables,
  type WorkspaceEnvironmentStatus,
} from "../workspace/workspace-environment.js";

export type KernelLanguage = "python" | "r";

export interface KernelStreamEvent {
  type: "stream";
  stream: "stdout" | "stderr";
  text: string;
}

export interface KernelResult {
  ok: boolean;
  stdout: string;
  result?: string | null;
  error?: string | null;
  interrupted: boolean;
  mime: Record<string, string>;
}

export interface KernelExecuteOptions {
  language: KernelLanguage;
  code: string;
  cwd: string;
  environment: WorkspaceEnvironmentStatus;
  notebookId?: string | null;
  sessionId?: string | null;
  kernelInstanceId?: string | null;
  environmentRevisionId?: string | null;
  timeoutMs: number;
  onEvent?: (event: KernelStreamEvent) => void;
}

export interface KernelSessionSnapshot {
  notebookId: string | null;
  sessionId: string | null;
  kernelInstanceId: string | null;
  language: KernelLanguage;
  cwd: string;
  environmentRevisionId: string | null;
  alive: boolean;
}

export interface KernelManagerStatus {
  interpreters: { python: boolean; r: boolean };
  sessions: KernelSessionSnapshot[];
  active_count: number;
  native: boolean;
}

export interface NodeKernelManagerDependencies {
  workspaceEnvironmentVariables?: (status: WorkspaceEnvironmentStatus, inherited?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  interpreterAvailable?: (command: string) => boolean;
}

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const PYTHON_BRIDGE = fileURLToPath(new URL("../../../../../backend/services/kernel_bridge.py", import.meta.url));
const R_BRIDGE = fileURLToPath(new URL("../../../../../backend/services/kernel_bridge.R", import.meta.url));
const HEALTH_CHECK_CODE = "1+1";
const INTERRUPT_GRACE_MS = 2_000;

class KernelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelTimeoutError";
  }
}

interface PendingCell {
  resolve: (result: KernelResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: KernelStreamEvent) => void;
  promise: Promise<KernelResult>;
}

function sessionKey(options: KernelExecuteOptions): string {
  const identity = options.kernelInstanceId ?? options.sessionId ?? options.notebookId ?? "default";
  return [options.cwd, identity, options.environmentRevisionId ?? "legacy", options.language].join("\0");
}

function defaultInterpreterAvailable(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    return result.error === undefined && result.status !== null;
  } catch {
    return false;
  }
}

export class NodeKernelManager {
  private readonly sessions = new Map<string, NodeKernelSession>();
  private readonly deps: Required<NodeKernelManagerDependencies>;

  constructor(deps: NodeKernelManagerDependencies = {}) {
    this.deps = {
      workspaceEnvironmentVariables: deps.workspaceEnvironmentVariables ?? workspaceEnvironmentVariables,
      platform: deps.platform ?? process.platform,
      interpreterAvailable: deps.interpreterAvailable ?? defaultInterpreterAvailable,
    };
  }

  async execute(options: KernelExecuteOptions): Promise<KernelResult> {
    const key = sessionKey(options);
    let session = this.sessions.get(key);
    if (!session || session.exited) {
      if (session) await session.stop().catch(() => undefined);
      session = await NodeKernelSession.start(options, this.deps);
      this.sessions.set(key, session);
    }
    try {
      return await session.execute(options);
    } catch (error) {
      this.sessions.delete(key);
      await session.stop().catch(() => undefined);
      throw error;
    }
  }

  status(): KernelManagerStatus {
    const sessions = [...this.sessions.values()];
    const python = this.deps.interpreterAvailable(this.deps.platform === "win32" ? "python" : "python3");
    const r = this.deps.interpreterAvailable("Rscript");
    return {
      interpreters: { python, r },
      sessions: sessions.map((session) => session.snapshot()),
      active_count: sessions.filter((session) => !session.exited).length,
      native: true,
    };
  }

  async shutdownNotebook(notebookId: string, cwd?: string, language?: string): Promise<void> {
    const resolved = cwd ? resolve(cwd) : undefined;
    const keys = [...this.sessions.keys()].filter((key) => {
      const session = this.sessions.get(key);
      if (!session) return false;
      const identity = session.kernelInstanceId ?? session.sessionId ?? session.notebookId;
      return (session.notebookId === notebookId || identity === notebookId)
        && (resolved === undefined || session.cwd === resolved)
        && (language === undefined || session.language === language);
    });
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (session) await session.stop().catch(() => undefined);
      this.sessions.delete(key);
    }
  }

  async interruptNotebook(notebookId: string, cwd: string, language?: string): Promise<boolean> {
    const resolved = resolve(cwd);
    let interrupted = false;
    for (const session of this.sessions.values()) {
      const identity = session.kernelInstanceId ?? session.sessionId ?? session.notebookId;
      if ((session.notebookId !== notebookId && identity !== notebookId) || session.cwd !== resolved) continue;
      if (language !== undefined && session.language !== language) continue;
      interrupted = session.interrupt() || interrupted;
    }
    return interrupted;
  }

  async shutdownAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.stop().catch(() => undefined)));
  }
}

class NodeKernelSession {
  exited = false;
  private child?: ChildProcess;
  private reader?: Interface;
  private readonly pending = new Map<string, PendingCell>();
  private readonly rCodeFile?: string;
  private readonly stderrTail: string[] = [];
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: KernelExecuteOptions,
    private readonly deps: Required<NodeKernelManagerDependencies>,
  ) {
    if (options.language === "r") {
      const hash = createHash("sha256").update([options.cwd, options.environmentRevisionId ?? "legacy", randomUUID()].join("\0")).digest("hex").slice(0, 20);
      this.rCodeFile = join(options.cwd, ".pi-science", "runtime", "kernels", `${hash}.R`);
    }
  }

  static async start(options: KernelExecuteOptions, deps: Required<NodeKernelManagerDependencies>): Promise<NodeKernelSession> {
    const session = new NodeKernelSession(options, deps);
    await session.start();
    return session;
  }

  execute(options: KernelExecuteOptions): Promise<KernelResult> {
    const run = this.tail.then(() => this.perform(options));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  get notebookId(): string | null { return this.options.notebookId ?? null; }
  get sessionId(): string | null { return this.options.sessionId ?? null; }
  get kernelInstanceId(): string | null { return this.options.kernelInstanceId ?? null; }
  get cwd(): string { return this.options.cwd; }
  get language(): KernelLanguage { return this.options.language; }
  get environmentRevisionId(): string | null { return this.options.environmentRevisionId ?? null; }

  snapshot(): KernelSessionSnapshot {
    return {
      notebookId: this.notebookId,
      sessionId: this.sessionId,
      kernelInstanceId: this.kernelInstanceId,
      language: this.language,
      cwd: this.cwd,
      environmentRevisionId: this.environmentRevisionId,
      alive: !this.exited,
    };
  }

  interrupt(): boolean {
    const child = this.child;
    if (!child || child.exitCode !== null) return false;
    try {
      if (this.deps.platform === "win32") child.kill();
      else child.kill("SIGINT");
      return true;
    } catch {
      return false;
    }
  }


  async stop(): Promise<void> {
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Kernel process stopped"));
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        force.unref?.();
        child.once("exit", () => { clearTimeout(force); resolve(); });
      });
    }
    this.reader?.close();
    this.reader = undefined;
    if (this.rCodeFile) await rm(this.rCodeFile, { force: true }).catch(() => undefined);
  }

  private async start(): Promise<void> {
    const executable = this.executablePath();
    const args = this.options.language === "python"
      ? [PYTHON_BRIDGE]
      : [R_BRIDGE, this.rCodeFile!];
    if (this.rCodeFile) {
      await mkdir(join(this.options.cwd, ".pi-science", "runtime", "kernels"), { recursive: true });
      await writeFile(this.rCodeFile, "", "utf8");
    }
    const env = this.deps.workspaceEnvironmentVariables(this.options.environment);
    const child = spawn(executable, args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exited = false;
    this.reader = createInterface({ input: child.stdout! });
    this.reader.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      this.stderrTail.push(text);
      if (this.stderrTail.length > 50) this.stderrTail.splice(0, this.stderrTail.length - 50);
    });
    child.once("error", (error) => {
      this.exited = true;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.exited = true;
      const message = `Kernel process exited (code=${code ?? "none"}, signal=${signal ?? "none"})${this.stderrTail.length ? `: ${this.stderrTail.at(-1)?.trim()}` : ""}`;
      for (const pending of this.pending.values()) pending.reject(new Error(message));
      this.pending.clear();
      this.reader?.close();
      this.reader = undefined;
    });

    const health = await this.sendRequest(HEALTH_CHECK_CODE, undefined, 30_000);
    if (!health.ok) throw new Error(`Kernel health check failed: ${health.error ?? "unknown error"}`);
  }

  private executablePath(): string {
    const bin = this.deps.platform === "win32" ? "Scripts" : "bin";
    if (this.options.language === "python") {
      return join(this.options.environment.prefix, bin, this.deps.platform === "win32" ? "python.exe" : "python");
    }
    return join(this.options.environment.prefix, bin, this.deps.platform === "win32" ? "Rscript.exe" : "Rscript");
  }

  private async perform(options: KernelExecuteOptions): Promise<KernelResult> {
    if (!this.child || this.exited) throw new Error("Kernel process is not running");
    return this.sendRequest(options.code, options.onEvent, options.timeoutMs);
  }

  private async sendRequest(code: string, onEvent: KernelExecuteOptions["onEvent"], timeoutMs: number): Promise<KernelResult> {
    const child = this.child;
    if (!child || child.exitCode !== null || this.exited) throw new Error("Kernel process is not running");
    const id = randomUUID();
    let resolveResult!: (result: KernelResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<KernelResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.pending.set(id, { resolve: resolveResult, reject: rejectResult, onEvent, promise: result });
    try {
      if (this.options.language === "python") {
        child.stdin?.write(JSON.stringify({ id, code }) + "\n");
      } else {
        await writeFile(this.rCodeFile!, code, "utf8");
        child.stdin?.write(id + "\n");
      }
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new KernelTimeoutError(`Cell execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([result, timeout]);
    } catch (error) {
      if (error instanceof KernelTimeoutError) {
        const interrupted = await this.tryInterrupt(id);
        if (interrupted) return interrupted;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private async tryInterrupt(id: string): Promise<KernelResult | null> {
    const child = this.child;
    if (!child || child.exitCode !== null) return null;
    const pending = this.pending.get(id);
    if (!pending) return null;
    try {
      if (this.deps.platform === "win32") child.kill();
      else child.kill("SIGINT");
    } catch {
      return null;
    }
    const grace = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("interrupt grace expired")), INTERRUPT_GRACE_MS));
    try {
      const result = await Promise.race([pending.promise as unknown as Promise<KernelResult>, grace]);
      return result.interrupted ? result : null;
    } catch {
      return null;
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "string" ? message.id : undefined;
    if (message.type === "stream" && id) {
      const pending = this.pending.get(id);
      if (pending && typeof message.text === "string") {
        pending.onEvent?.({ type: "stream", stream: message.stream === "stderr" ? "stderr" : "stdout", text: message.text });
      }
      return;
    }
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(normalizeResult(message));
  }
}

function normalizeResult(message: Record<string, unknown>): KernelResult {
  return {
    ok: message.ok === true,
    stdout: typeof message.stdout === "string" ? message.stdout : "",
    result: message.result === null || message.result === undefined ? null : String(message.result),
    error: message.error === null || message.error === undefined ? null : String(message.error),
    interrupted: message.interrupted === true,
    mime: message.mime !== null && typeof message.mime === "object" && !Array.isArray(message.mime)
      ? message.mime as Record<string, string>
      : {},
  };
}