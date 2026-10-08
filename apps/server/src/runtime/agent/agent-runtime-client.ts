import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentRuntimeExitedError, AgentRuntimeTimeoutError } from "./agent-runtime-errors.js";
import type { AgentRuntime, RuntimeResult, RuntimeSkillPolicy } from "./agent-runtime-types.js";
import { workerEventSchema, type AgentRuntimeStartOptions, type WorkerCommand } from "./worker/protocol.js";
import { decodeCommand, decodeNotification, validResultData, type RuntimeCommand, type RuntimeNotification, type RuntimeCommandName, type CommandParams, type CommandResult } from "./worker/command-contract.js";

type Pending = {
  command: string;
  resolve: (value: RuntimeResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};
type WorkerRequest =
  | { type: "initialize"; options: AgentRuntimeStartOptions }
  | ({ type: "command" } & RuntimeCommand)
  | ({ type: "notification" } & RuntimeNotification);

const DEFAULT_TIMEOUT_MS = 30_000;
const SYSTEM_ENV_KEYS = ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PI_SCIENCE_HOME", "PI_SCIENCE_STATE_ROOT",
  // Trusted launch configuration for model networking; never accept workspace overrides.
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;
const WORKSPACE_ENV_KEYS = new Set([
  "PATH", "CONDA_PREFIX", "PI_SCIENCE_ENVIRONMENT_ID", "PI_SCIENCE_ENVIRONMENT_REVISION_ID",
  "PI_SCIENCE_ENVIRONMENT_PREFIX", "PYTHONNOUSERSITE", "PIP_USER", "npm_config_prefix",
  "NPM_CONFIG_PREFIX", "npm_config_cache", "NPM_CONFIG_CACHE", "npm_config_update_notifier",
  "PNPM_HOME", "COREPACK_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY",
  "MISTRAL_API_KEY", "XAI_API_KEY", "CEREBRAS_API_KEY", "ZAI_API_KEY",
  "PI_SCIENCE_BACKEND_URL", "PI_SCIENCE_INTERNAL_TOKEN",
]);

function workerEntry(): { path: string; execArgv: string[] } {
  const compiled = fileURLToPath(new URL("./worker/main.js", import.meta.url));
  if (existsSync(compiled)) return { path: compiled, execArgv: [] };
  return { path: fileURLToPath(new URL("./worker/main.ts", import.meta.url)), execArgv: ["--import", import.meta.resolve("tsx")] };
}

export function workerEnvironment(overrides: Record<string, string> = {}, credentialEnvNames: string[] = []): NodeJS.ProcessEnv {
  const system = Object.fromEntries(SYSTEM_ENV_KEYS.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  const allowed = new Set([...WORKSPACE_ENV_KEYS, ...credentialEnvNames]);
  const workspace = Object.fromEntries(Object.entries(overrides).filter(([name]) => allowed.has(name)));
  return { ...system, ...workspace };
}

/** One IPC connection and one OS child for an AgentHarness session. */
export class AgentCoreRuntimeClient extends EventEmitter implements AgentRuntime {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private closed = false;
  private currentSessionId = "";
  private stderrTail = "";

  private constructor(
    readonly child: ChildProcess,
    readonly cwd: string,
    timeoutMs: number,
  ) {
    super();
    this.timeoutMs = timeoutMs;
    child.on("message", (message: unknown) => this.handleMessage(message));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4_000);
      this.emit("stderr", text);
    });
    child.once("error", (error) => this.handleExit(null, null, error));
    child.once("exit", (code, signal) => this.handleExit(code, signal));
  }

  static async start(options: AgentRuntimeStartOptions, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AgentCoreRuntimeClient> {
    const entry = workerEntry();
    const env = workerEnvironment(options.env, options.credentialEnvNames);
    const child = fork(entry.path, [], {
      cwd: options.cwd,
      env,
      execArgv: entry.execArgv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const client = new AgentCoreRuntimeClient(child, options.cwd, timeoutMs);
    try {
      const result = await client.request({ type: "initialize", options: { ...options, env: env as Record<string, string> } }, "initialize");
      if (!result.success) throw new Error(result.error ?? "agent runtime initialization failed");
      const sessionId = result.data && typeof result.data === "object" ? (result.data as { sessionId?: unknown }).sessionId : undefined;
      if (typeof sessionId !== "string" || !sessionId) throw new Error("agent runtime returned no session ID");
      client.currentSessionId = sessionId;
      if (!options.deferActivation) {
        const activated = await client.sendCommand("activate");
        if (!activated.success) throw new Error(activated.error ?? "agent runtime activation failed");
      }
      return client;
    } catch (error) {
      await client.shutdown();
      throw error;
    }
  }

  get sessionId(): string { return this.currentSessionId; }
  get isClosed(): boolean { return this.closed; }

  sendCommand<K extends RuntimeCommandName>(type: K, params?: CommandParams<K>, timeoutMs?: number): Promise<CommandResult<K>>;
  sendCommand(type: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<RuntimeResult>;
  sendCommand(type: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<RuntimeResult> {
    const decoded = decodeCommand(type, params);
    return decoded.ok ? this.request({ type: "command", ...decoded.value }, type, timeoutMs) : Promise.resolve(decoded.result);
  }

  async sendNotification(type: string, params: Record<string, unknown> = {}): Promise<void> {
    const decoded = decodeNotification(type, params);
    if (!decoded.ok) throw new Error(decoded.result.error);
    const result = await this.request({ type: "notification", ...decoded.value }, type);
    if (!result.success) throw new Error(result.error ?? `agent notification ${type} failed`);
  }

  getSkills(): Promise<RuntimeResult> { return this.sendCommand("get_skills"); }
  setSkillPolicy(policy: RuntimeSkillPolicy): Promise<RuntimeResult> { return this.sendCommand("set_skill_policy", { policy }); }
  refreshSkills(): Promise<RuntimeResult> { return this.sendCommand("refresh_skills"); }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    const child = this.child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.send({ type: "shutdown" }).catch(() => child.kill("SIGTERM"));
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await exited; }
    finally { clearTimeout(timer); }
  }

  private request(command: WorkerRequest, label: string, timeoutMs = this.timeoutMs): Promise<RuntimeResult> {
    if (this.closed) return Promise.reject(new AgentRuntimeExitedError("agent worker is closed"));
    const requestId = randomUUID();
    return new Promise<RuntimeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AgentRuntimeTimeoutError(label, timeoutMs));
      }, timeoutMs);
      this.pending.set(requestId, { command: label, resolve, reject, timer });
      void this.send({ ...command, requestId } as WorkerCommand).catch((error: Error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  private send(message: WorkerCommand): Promise<void> {
    if (!this.child.connected) return Promise.reject(new AgentRuntimeExitedError("agent worker IPC is disconnected"));
    return new Promise((resolve, reject) => {
      this.child.send(message, (error) => error ? reject(error) : resolve());
    });
  }

  private handleMessage(message: unknown): void {
    const decoded = workerEventSchema.safeParse(message);
    if (!decoded.success) {
      if (message && typeof message === "object" && "requestId" in message && typeof message.requestId === "string") {
        const pending = this.pending.get(message.requestId);
        if (pending) { this.pending.delete(message.requestId); clearTimeout(pending.timer); pending.reject(new Error("invalid agent worker response")); }
      }
      this.emit("malformed", "invalid agent worker event");
      return;
    }
    const value = decoded.data;
    if (value.type === "runtime_event") this.emit("event", value.event);
    if (value.type === "fatal") this.emit("stderr", value.error);
    if (value.type === "ready") this.currentSessionId = value.sessionId;
    if (value.type !== "result") return;
    const pending = this.pending.get(value.requestId);
    if (!pending) return;
    this.pending.delete(value.requestId);
    clearTimeout(pending.timer);
    if (!validResultData(pending.command, value.result)) {
      this.emit("malformed", `invalid result for ${pending.command}`);
      pending.reject(new Error(`invalid agent worker result for ${pending.command}`));
    } else pending.resolve(value.result);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, cause?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const error = new AgentRuntimeExitedError(cause?.message ?? `agent worker exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", { code, signal });
  }
}
