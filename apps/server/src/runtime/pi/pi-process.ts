import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

/** Options for one Pi runtime process (stdio RPC mode). */
export interface PiRuntimeRequest {
  cwd: string;
  sessionDir: string;
  sessionPath?: string;
  model?: string;
  thinking?: string;
  runtimeEnv?: Record<string, string | null>;
}

/** Skill policy persisted in settings. A runtime receives its skill set as
 *  spawn arguments, so a policy change is applied by restarting the runtime. */
export type RuntimeSkillPolicy =
  | { mode: "inherit" }
  | { mode: "none" }
  | { mode: "allowlist"; skills: string[] }
  | { mode: "denylist"; skills: string[] };

export interface RuntimeSkillsState {
  policy: RuntimeSkillPolicy;
  skills: Array<{ name: string; description: string; enabled: boolean; [key: string]: unknown }>;
  diagnostics: unknown[];
}

export interface PiProcessOptions {
  cwd: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiResult {
  success?: boolean;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (result: PiResult) => void;
  timer: NodeJS.Timeout;
}

export class PiProcess extends EventEmitter {
  readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private closed = false;
  private exitEmitted = false;

  /** True while the runtime process is alive. Events arrive on the process's
   *  own stdout, so the stream shares the process lifetime: a silent runtime
   *  shows up as an exit, not as a dead connection. */
  readonly eventStreamAlive = true;

  /** Wall-clock time of the last event received from the runtime. */
  lastEventAt = 0;

  private constructor(options: PiProcessOptions) {
    super();
    const environmentTimeout = Number(process.env.PI_SCIENCE_RUNTIME_TIMEOUT_MS ?? process.env.PI_SCIENCE_RPC_TIMEOUT_MS ?? 0);
    this.requestTimeoutMs = options.requestTimeoutMs ?? (environmentTimeout > 0 ? environmentTimeout : 30_000);
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.child.stdout) {
      const lines = createInterface({ input: this.child.stdout });
      lines.on("line", (line) => this.handleLine(line));
    }
    this.child.stderr?.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.once("error", (error) => this.failPending(`pi runtime process error: ${error.message}`));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.failPending(`pi runtime exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
      this.emitExit(code, signal);
    });
  }

  static start(options: PiProcessOptions): PiProcess {
    return new PiProcess(options);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async sendCommand(type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      return { success: false, code: "process_closed", error: "pi runtime stdin is unavailable" };
    }
    const stdin = this.child.stdin;
    const id = randomUUID();
    const command = `${JSON.stringify({ id, type, ...params })}\n`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ success: false, code: "timeout", error: `request timeout after ${this.requestTimeoutMs}ms` });
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      stdin.write(command, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ success: false, code: "write_failed", error: error.message });
      });
    });
  }

  async sendNotification(type: string, params: Record<string, unknown> = {}): Promise<void> {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) throw new Error("pi runtime stdin is unavailable");
    const stdin = this.child.stdin;
    const command = `${JSON.stringify({ type, ...params })}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(command, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failPending("pi runtime is shutting down");
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.emitExit(child.exitCode, child.signalCode);
      return;
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.emit("exit", { code, signal });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(line) as Record<string, unknown>; }
    catch { this.emit("malformed", line.slice(0, 500)); return; }
    const id = typeof payload.id === "string" ? payload.id : undefined;
    const pending = id ? this.pending.get(id) : undefined;
    if (pending && id) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : undefined;
      pending.resolve(data?.cancelled === true
        ? { ...payload, success: false, code: "cancelled", error: typeof payload.error === "string" ? payload.error : "request was cancelled by the Pi runtime" }
        : payload as PiResult);
      return;
    }
    if (typeof payload.type === "string") {
      this.lastEventAt = Date.now();
      this.emit("event", payload as PiEvent);
    }
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, code: "process_exit", error: message });
      this.pending.delete(id);
    }
  }
}
