import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PiOrbitRuntimeRequest, PiProcessOptions } from "./pi-process.js";

export type PiOrbitRuntimeDescriptor = {
  runtimeId: string;
  piSessionId: string;
  sessionPath: string | null;
  sessionDir: string | null;
  workspaceCwd: string;
  persisted: boolean;
  diagnostics: unknown[];
};

type PiOrbitErrorPayload = {
  error?: unknown;
  details?: unknown;
  code?: unknown;
  diagnostics?: unknown;
  [key: string]: unknown;
};

export class PiOrbitRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly payload: PiOrbitErrorPayload;

  constructor(status: number, payload: PiOrbitErrorPayload) {
    const detail = payload.details ? `: ${String(payload.details)}` : "";
    super(`${String(payload.error ?? payload.code ?? `HTTP ${status}`)}${detail}`);
    this.name = "PiOrbitRequestError";
    this.code = typeof payload.code === "string" ? payload.code : `http_${status}`;
    this.status = status;
    this.payload = payload;
  }
}

export class PiOrbitHost extends EventEmitter {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly authToken: string;
  private readonly requestTimeoutMs: number;
  private readonly readyPromise: Promise<void>;
  private closed = false;
  private stderrTail = "";

  constructor(options: PiProcessOptions) {
    super();
    if (!options.web) throw new Error("Pi Orbit host options are required");
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
      const text = `Pi Orbit host process error: ${error.message}\n`;
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

  async createRuntime(request: PiOrbitRuntimeRequest, timeoutMs = this.requestTimeoutMs): Promise<PiOrbitRuntimeDescriptor> {
    await this.ready();
    await this.trustRegisteredWorkspace(request.cwd, timeoutMs);
    const response = await this.request("POST", "/api/runtimes", request as unknown as Record<string, unknown>, timeoutMs);
    if (!response.ok) throw await this.requestError(response);
    const descriptor = await response.json() as Partial<PiOrbitRuntimeDescriptor>;
    if (
      typeof descriptor.runtimeId !== "string"
      || typeof descriptor.piSessionId !== "string"
      || typeof descriptor.workspaceCwd !== "string"
      || typeof descriptor.persisted !== "boolean"
      || !Array.isArray(descriptor.diagnostics)
    ) {
      throw new Error("Pi Orbit host returned an invalid runtime descriptor");
    }
    return descriptor as PiOrbitRuntimeDescriptor;
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
    return (await this.requestError(response)).message;
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
    let lastError = "Pi Orbit host did not become ready";
    while (!this.closed && Date.now() < deadline) {
      try {
        const health = await this.request("GET", "/api/health", undefined, Math.min(1_000, this.requestTimeoutMs));
        if (health.ok) {
          const capabilities = await this.request("GET", "/api/capabilities", undefined, this.requestTimeoutMs);
          if (!capabilities.ok) throw new Error(await this.responseError(capabilities));
          const payload = await capabilities.json() as {
            protocolVersion?: unknown;
            isolationModel?: unknown;
            features?: Record<string, unknown>;
          };
          const requiredFeatures = ["runtimeApi", "eventReplay", "runtimeSkillOverrides", "runtimeSkillRefresh", "browserSessionAuth", "workspaceBinding", "projectTrustApi", "legacySessionApi"];
          if (
            payload.protocolVersion !== 1
            || payload.isolationModel !== "single-user-shared-process"
            || requiredFeatures.some((feature) => payload.features?.[feature] !== true)
          ) {
            throw new Error("Pi Orbit host does not provide the required runtime, workspace, trust, and authentication capabilities");
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

  private async trustRegisteredWorkspace(cwd: string, timeoutMs: number): Promise<void> {
    const query = new URLSearchParams({ cwd });
    const statusResponse = await this.request("GET", `/api/project-trust?${query}`, undefined, timeoutMs);
    if (!statusResponse.ok) throw await this.requestError(statusResponse);
    const status = await statusResponse.json() as { cwd?: unknown; required?: unknown; decision?: unknown };
    // Managed Pi Science workspaces treat their .pi/skills/ directory as
    // builtin project assets, so an unset or legacy false decision is trusted
    // automatically. An existing true decision is already in the desired state.
    if (status.required !== true || status.decision === true) return;
    const canonicalCwd = typeof status.cwd === "string" ? status.cwd : cwd;
    const decisionResponse = await this.request("PUT", "/api/project-trust", { cwd: canonicalCwd, decision: true }, timeoutMs);
    if (!decisionResponse.ok) throw await this.requestError(decisionResponse);
  }

  private async requestError(response: Response): Promise<PiOrbitRequestError> {
    try {
      const payload = await response.json() as PiOrbitErrorPayload;
      return new PiOrbitRequestError(response.status, payload && typeof payload === "object" ? payload : {});
    } catch {
      return new PiOrbitRequestError(response.status, {});
    }
  }
}
