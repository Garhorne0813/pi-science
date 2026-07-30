import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PiProcessOptions, PiWebRuntimeRequest } from "./pi-process.js";

type RuntimeDescriptor = {
  runtimeId: string;
  piSessionId: string;
};

export class PiWebHost extends EventEmitter {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly authToken: string;
  private readonly requestTimeoutMs: number;
  private readonly readyPromise: Promise<void>;
  private closed = false;
  private stderrTail = "";

  constructor(options: PiProcessOptions) {
    super();
    if (!options.web) throw new Error("Pi Web host options are required");
    this.baseUrl = options.web.baseUrl;
    this.authToken = options.web.authToken;
    const environmentTimeout = Number(process.env.PI_SCIENCE_RUNTIME_TIMEOUT_MS ?? process.env.PI_SCIENCE_RPC_TIMEOUT_MS ?? 0);
    this.requestTimeoutMs = options.requestTimeoutMs ?? (environmentTimeout > 0 ? environmentTimeout : 30_000);
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      // Web mode reads piped stdin before starting its server.
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-16_000);
      this.emit("stderr", text);
    });
    this.child.once("error", (error) => {
      const text = `Pi Web host process error: ${error.message}\n`;
      this.stderrTail = `${this.stderrTail}${text}`.slice(-16_000);
      this.emit("stderr", text);
    });
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.emit("exit", { code, signal });
    });
    this.readyPromise = this.waitUntilReady();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async ready(): Promise<void> {
    return this.readyPromise;
  }

  async createRuntime(request: PiWebRuntimeRequest, timeoutMs = this.requestTimeoutMs): Promise<RuntimeDescriptor> {
    await this.ready();
    const response = await this.request("POST", "/api/runtimes", request as unknown as Record<string, unknown>, timeoutMs);
    if (!response.ok) throw new Error(await this.responseError(response));
    const descriptor = await response.json() as Partial<RuntimeDescriptor>;
    if (typeof descriptor.runtimeId !== "string" || typeof descriptor.piSessionId !== "string") {
      throw new Error("Pi Web host returned an invalid runtime descriptor");
    }
    return descriptor as RuntimeDescriptor;
  }

  request(method: string, path: string, body?: Record<string, unknown>, timeoutMs = this.requestTimeoutMs, signal?: AbortSignal): Promise<Response> {
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combinedSignal = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.authToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: combinedSignal,
    });
  }

  async responseError(response: Response): Promise<string> {
    try {
      const payload = await response.json() as { error?: unknown; details?: unknown; code?: unknown };
      const detail = payload.details ? `: ${String(payload.details)}` : "";
      return `${String(payload.error ?? payload.code ?? `HTTP ${response.status}`)}${detail}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 5_000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.requestTimeoutMs;
    let lastError = "Pi Web host did not become ready";
    while (!this.closed && Date.now() < deadline) {
      try {
        const health = await this.request("GET", "/api/health", undefined, Math.min(1_000, this.requestTimeoutMs));
        if (health.ok) {
          const capabilities = await this.request("GET", "/api/capabilities", undefined, this.requestTimeoutMs);
          if (!capabilities.ok) throw new Error(await this.responseError(capabilities));
          const payload = await capabilities.json() as { protocolVersion?: unknown; features?: { runtimeApi?: unknown; eventReplay?: unknown } };
          if (payload.protocolVersion !== 1 || payload.features?.runtimeApi !== true || payload.features?.eventReplay !== true) {
            throw new Error("Pi Web host does not provide the required runtime API and event replay capabilities");
          }
          return;
        }
        lastError = await this.responseError(health);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stderr = this.stderrTail.trim();
    throw new Error(stderr ? `${lastError}\n${stderr}` : lastError);
  }
}
