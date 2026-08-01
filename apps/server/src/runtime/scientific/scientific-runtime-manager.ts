import { spawn, type ChildProcess } from "node:child_process";

export type ScientificRuntimeState =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "failed"
  | "external";

export interface ScientificRuntimeSnapshot {
  state: ScientificRuntimeState;
  managed: boolean;
  pid?: number;
  activeRequests: number;
  lastError?: string;
}

export interface ScientificRuntimeController {
  acquire(): Promise<() => void>;
  snapshot(): ScientificRuntimeSnapshot;
  shutdown(): Promise<void>;
}

export interface ScientificRuntimeOptions {
  origin: string;
  managed?: boolean;
  pythonExecutable?: string;
  pythonCwd?: string;
  internalToken?: string;
  idleTimeoutMs?: number;
  startupTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface ScientificRuntimeDependencies {
  spawnWorker?: typeof spawn;
  checkHealth?: (origin: string, internalToken?: string) => Promise<boolean>;
  delay?: (milliseconds: number) => Promise<void>;
}

const defaultDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function defaultCheckHealth(origin: string, internalToken?: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, {
      headers: internalToken ? { "x-pi-science-internal-token": internalToken } : undefined,
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class ScientificRuntimeManager implements ScientificRuntimeController {
  private readonly managed: boolean;
  private readonly spawnWorker: typeof spawn;
  private readonly checkHealth: (origin: string, internalToken?: string) => Promise<boolean>;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private state: ScientificRuntimeState;
  private child?: ChildProcess;
  private startup?: Promise<void>;
  private stopping?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private activeRequests = 0;
  private lastError?: string;
  private closing = false;

  constructor(
    private readonly options: ScientificRuntimeOptions,
    dependencies: ScientificRuntimeDependencies = {},
  ) {
    this.managed = options.managed ?? false;
    this.state = this.managed ? "idle" : "external";
    this.spawnWorker = dependencies.spawnWorker ?? spawn;
    this.checkHealth = dependencies.checkHealth ?? defaultCheckHealth;
    this.delay = dependencies.delay ?? defaultDelay;
  }

  snapshot(): ScientificRuntimeSnapshot {
    return {
      state: this.state,
      managed: this.managed,
      pid: this.child?.pid,
      activeRequests: this.activeRequests,
      lastError: this.lastError,
    };
  }

  async acquire(): Promise<() => void> {
    this.clearIdleTimer();
    await this.ensureReady();
    this.activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.scheduleIdleShutdown();
    };
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.clearIdleTimer();
    await this.beginStop();
  }

  private async ensureReady(): Promise<void> {
    if (this.closing) throw new Error("scientific runtime is shutting down");
    if (!this.managed) {
      if (!(await this.checkHealth(this.options.origin, this.options.internalToken))) {
        throw new Error(`scientific runtime is unavailable at ${this.options.origin}`);
      }
      return;
    }
    if (this.stopping) await this.stopping;
    if (this.closing) throw new Error("scientific runtime is shutting down");
    if (this.state === "ready" && this.child && this.child.exitCode === null) return;
    if (this.startup) return this.startup;
    this.startup = this.startWorker().finally(() => {
      this.startup = undefined;
    });
    return this.startup;
  }

  private async startWorker(): Promise<void> {
    const executable = this.options.pythonExecutable;
    const cwd = this.options.pythonCwd;
    if (!executable || !cwd) {
      this.state = "failed";
      this.lastError = "managed scientific runtime requires a Python executable and working directory";
      throw new Error(this.lastError);
    }

    const origin = new URL(this.options.origin);
    const port = origin.port || (origin.protocol === "https:" ? "443" : "80");
    this.state = "starting";
    this.lastError = undefined;
    const child = this.spawnWorker(
      executable,
      ["-m", "uvicorn", "main:app", "--host", origin.hostname, "--port", port],
      {
        cwd,
        env: {
          ...process.env,
          ...this.options.environment,
          PI_SCIENCE_PORT: port,
          PI_SCIENCE_INTERNAL_TOKEN: this.options.internalToken,
          PI_SCIENCE_REQUIRE_INTERNAL_TOKEN: this.options.internalToken ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout?.on("data", (data) => this.options.log?.("info", `[scientific-worker] ${String(data).trim()}`));
    child.stderr?.on("data", (data) => this.options.log?.("warn", `[scientific-worker] ${String(data).trim()}`));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.state === "stopping" || this.closing) {
        this.state = "idle";
        return;
      }
      this.state = "failed";
      this.lastError = `scientific worker exited (code=${code ?? "none"}, signal=${signal ?? "none"})`;
      this.options.log?.("error", this.lastError);
    });

    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await this.checkHealth(this.options.origin, this.options.internalToken)) {
        this.state = "ready";
        this.options.log?.("info", `scientific worker ready on ${this.options.origin}`);
        return;
      }
      await this.delay(100);
    }

    this.lastError = `scientific worker did not become ready within ${this.options.startupTimeoutMs ?? 30_000}ms`;
    this.state = "failed";
    await this.terminateChild(child);
    throw new Error(this.lastError);
  }

  private scheduleIdleShutdown(): void {
    if (!this.managed || this.closing || this.activeRequests > 0 || this.state !== "ready") return;
    const timeout = this.options.idleTimeoutMs ?? 5 * 60_000;
    this.idleTimer = setTimeout(() => {
      if (this.activeRequests === 0) void this.beginStop();
    }, timeout);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async stopWorker(): Promise<void> {
    if (!this.managed || !this.child) return;
    const child = this.child;
    this.state = "stopping";
    await this.terminateChild(child);
    if (this.child === child) this.child = undefined;
    this.state = "idle";
  }

  private beginStop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopWorker().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      forceTimer.unref();
      child.once("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
