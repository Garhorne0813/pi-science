import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

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
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private closed = false;

  private constructor(private readonly options: PiProcessOptions) {
    super();
    const environmentTimeout = Number(process.env.PI_SCIENCE_RPC_TIMEOUT_MS ?? 0);
    this.requestTimeoutMs = options.requestTimeoutMs ?? (environmentTimeout > 0 ? environmentTimeout : 30_000);
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.once("error", (error) => this.failPending(`pi process error: ${error.message}`));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.failPending(`pi process exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
      this.emit("exit", { code, signal });
    });
  }

  static start(options: PiProcessOptions): PiProcess {
    return new PiProcess(options);
  }

  async sendCommand(type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    if (this.closed || this.child.stdin.destroyed) {
      return { success: false, code: "process_closed", error: "pi runtime stdin is unavailable" };
    }
    const id = randomUUID();
    const command = `${JSON.stringify({ id, type, ...params })}\n`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ success: false, code: "timeout", error: `request timeout after ${this.requestTimeoutMs}ms` });
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(command, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ success: false, code: "write_failed", error: error.message });
      });
    });
  }

  async sendNotification(type: string, params: Record<string, unknown> = {}): Promise<void> {
    if (this.closed || this.child.stdin.destroyed) throw new Error("pi runtime stdin is unavailable");
    const command = `${JSON.stringify({ type, ...params })}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(command, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("malformed", line.slice(0, 500));
      return;
    }
    const id = typeof payload.id === "string" ? payload.id : undefined;
    const pending = id ? this.pending.get(id) : undefined;
    if (pending && id) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : undefined;
      if (data?.cancelled === true) {
        pending.resolve({
          ...payload,
          success: false,
          code: "cancelled",
          error: typeof payload.error === "string" ? payload.error : "request was cancelled by the Pi runtime",
        });
      } else {
        pending.resolve(payload as PiResult);
      }
      return;
    }
    if (typeof payload.type === "string") this.emit("event", payload as PiEvent);
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, code: "process_exit", error: message });
      this.pending.delete(id);
    }
  }
}
