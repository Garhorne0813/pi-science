import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { PiOrbitHost, PiOrbitRuntimeDescriptor } from "./pi-orbit-host.js";

export interface PiOrbitRuntimeRequest {
  cwd: string;
  sessionDir: string;
  sessionPath?: string;
  model?: string;
  thinking?: string;
  runtimeEnv?: Record<string, string | null>;
  skillPolicy?: RuntimeSkillPolicy;
}

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
  web?: {
    baseUrl: string;
    authToken: string;
    runtime: PiOrbitRuntimeRequest;
  };
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

/** Total time budget for disposing a busy web runtime; configurable for tests.
 *  Defaults above the 45s prompt reconciliation deadline so a long turn that
 *  does not abort promptly still fits inside the budget. */
function disposeBudgetMs(): number {
  const configured = Number(process.env.PI_SCIENCE_DISPOSE_TIMEOUT_MS ?? 0);
  return configured > 0 ? configured : 60_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PiProcess extends EventEmitter {
  readonly child: ChildProcess;
  readonly runtimeIdentity: PiOrbitRuntimeDescriptor | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly webHost: PiOrbitHost | undefined;

  /** True when this process is a runtime inside the shared Pi Orbit host
   *  (as opposed to a standalone RPC process). */
  get attachedToHost(): boolean {
    return this.webHost !== undefined;
  }
  private readonly runtimeId: string | undefined;
  private eventAbort: AbortController | undefined;
  /** Highest Pi Orbit event sequence consumed for this runtime. Kept on the
   *  process (rather than inside one response reader) so watchdog-driven
   *  replacement streams resume from the correct cursor. */
  private lastEventSequence = 0;
  private closed = false;
  private exitEmitted = false;
  private removeHostListeners: (() => void) | undefined;

  /** Wall-clock time of the last frame received from the Pi Orbit event
   *  stream (0 when nothing has ever arrived). A live stream keeps this
   *  fresh; the watchdog uses it to detect a silently dead connection. */
  lastEventAt = 0;

  /** True while the event stream connection is established. Set false when
   *  the stream fails (consumeEventStream rejects); a later reconnect (EOF
   *  re-request or reconnectEventStream) sets it true again. */
  eventStreamAlive = false;

  private constructor(options: PiProcessOptions, webHost?: PiOrbitHost, descriptor?: PiOrbitRuntimeDescriptor) {
    super();
    const environmentTimeout = Number(process.env.PI_SCIENCE_RUNTIME_TIMEOUT_MS ?? process.env.PI_SCIENCE_RPC_TIMEOUT_MS ?? 0);
    this.requestTimeoutMs = options.requestTimeoutMs ?? (environmentTimeout > 0 ? environmentTimeout : 30_000);
    this.webHost = webHost;
    this.runtimeId = descriptor?.runtimeId;
    this.runtimeIdentity = descriptor;
    if (webHost) {
      this.child = webHost.child;
      const onStderr = (text: string) => this.emit("stderr", text);
      const onExit = ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
        this.closed = true;
        this.emitExit(code, signal);
      };
      webHost.on("stderr", onStderr);
      webHost.on("exit", onExit);
      this.removeHostListeners = () => {
        webHost.off("stderr", onStderr);
        webHost.off("exit", onExit);
      };
      return;
    }

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
    this.child.once("error", (error) => this.failPending(`pi process error: ${error.message}`));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.failPending(`pi process exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
      this.emitExit(code, signal);
    });
  }

  static start(options: PiProcessOptions): PiProcess {
    if (options.web) throw new Error("Pi Orbit runtimes must be created through PiManager");
    return new PiProcess(options);
  }

  static async attachWeb(host: PiOrbitHost, options: PiProcessOptions): Promise<PiProcess> {
    if (!options.web) throw new Error("Pi Orbit runtime options are required");
    const desiredPolicy = options.web.runtime.skillPolicy ?? { mode: "inherit" };
    // Named policies may contain skills that only exist in other workspaces.
    // Create first with a universally valid policy, then intersect the global
    // preference with this runtime's own discovered catalog below.
    const initialPolicy = desiredPolicy.mode === "allowlist" || desiredPolicy.mode === "denylist"
      ? { mode: "inherit" as const }
      : desiredPolicy;
    const descriptor = await host.createRuntime({ ...options.web.runtime, skillPolicy: initialPolicy }, options.requestTimeoutMs);
    const process = new PiProcess(options, host, descriptor);
    try {
      if (desiredPolicy !== initialPolicy) {
        const applied = await process.setRuntimeSkillPolicy(desiredPolicy);
        if (!applied.success) throw Object.assign(new Error(String(applied.error ?? "Unable to apply runtime skill policy")), { code: applied.code });
      }
      await process.startEventStream();
      return process;
    } catch (error) {
      await process.shutdown().catch(() => undefined);
      throw error;
    }
  }

  async sendCommand(type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    if (this.webHost) return this.sendWebCommand(type, params);
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
    if (this.webHost) {
      if (type !== "extension_ui_response") throw new Error(`unsupported Pi Orbit notification: ${type}`);
      const result = await this.webRequest("POST", `${this.runtimePath()}/ui-response`, { type, ...params });
      if (!result.success) throw new Error(String(result.error ?? "Pi Orbit notification failed"));
      return;
    }
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) throw new Error("pi runtime stdin is unavailable");
    const stdin = this.child.stdin;
    const command = `${JSON.stringify({ type, ...params })}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(command, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  async runtimeSkills(): Promise<PiResult> {
    if (!this.webHost) return { success: false, code: "runtime_skill_control_unavailable", error: "Runtime skill control requires Pi Orbit Web Mode" };
    return this.webRequest("GET", `${this.runtimePath()}/skills`);
  }

  async setRuntimeSkillPolicy(policy: RuntimeSkillPolicy): Promise<PiResult> {
    if (!this.webHost) return { success: false, code: "runtime_skill_control_unavailable", error: "Runtime skill control requires Pi Orbit Web Mode" };
    let effective = policy;
    if (policy.mode === "allowlist" || policy.mode === "denylist") {
      const state = await this.runtimeSkills();
      if (!state.success || !state.data || typeof state.data !== "object") return state;
      const skills = (state.data as Partial<RuntimeSkillsState>).skills;
      const discovered = new Set(Array.isArray(skills) ? skills.map((skill) => skill.name) : []);
      effective = { mode: policy.mode, skills: policy.skills.filter((name) => discovered.has(name)) };
    }
    return this.webRequest("PUT", `${this.runtimePath()}/skills`, effective);
  }

  async refreshRuntimeSkills(): Promise<PiResult> {
    if (!this.webHost) return { success: false, code: "runtime_skill_control_unavailable", error: "Runtime skill control requires Pi Orbit Web Mode" };
    return this.webRequest("POST", `${this.runtimePath()}/skills/refresh`);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.detachFromHost();
    if (this.webHost) {
      await this.disposeWebRuntime();
      return;
    }
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

  private async sendWebCommand(type: string, params: Record<string, unknown>): Promise<PiResult> {
    if (this.closed) return { success: false, code: "process_closed", error: "Pi Orbit runtime is unavailable" };
    try {
      const runtimePath = this.runtimePath();
      const sessionPath = `/api/sessions/${encodeURIComponent(this.runtimeId!)}`;
      switch (type) {
        case "get_state": {
          const result = await this.webRequest("GET", `${runtimePath}/state`);
          if (!result.success || !result.data || typeof result.data !== "object") return result;
          const data = result.data as Record<string, unknown>;
          return {
            success: true,
            data: {
              ...data,
              sessionId: typeof data.sessionId === "string" ? data.sessionId : data.piSessionId,
            },
          };
        }
        case "get_session_stats": return this.asData(await this.webRequest("GET", `${sessionPath}/stats`));
        case "get_available_models": {
          const result = await this.webRequest("GET", `/api/models?session_id=${encodeURIComponent(this.runtimeId!)}`);
          return result.success ? { success: true, data: { models: result.data } } : result;
        }
        case "get_available_thinking_levels": return this.asData(await this.webRequest("GET", `${sessionPath}/thinking-levels`));
        case "get_commands": return this.asData(await this.webRequest("GET", `${runtimePath}/commands`));
        case "get_messages": return this.asData(await this.webRequest("GET", `${sessionPath}/messages`));
        case "get_fork_messages": return this.asData(await this.webRequest("GET", `${sessionPath}/fork-messages`));
        case "get_entries": {
          const since = typeof params.since === "string" ? `?since=${encodeURIComponent(params.since)}` : "";
          return this.asData(await this.webRequest("GET", `${sessionPath}/entries${since}`));
        }
        case "get_tree": return this.asData(await this.webRequest("GET", `${sessionPath}/tree`));
        case "get_last_assistant_text": return this.asData(await this.webRequest("GET", `${sessionPath}/last-assistant-text`));
        case "switch_session": {
          const result = await this.webRequest("POST", `${runtimePath}/resume`, { sessionPath: params.sessionPath });
          if (result.success) {
            await this.refreshRuntimeIdentity();
            await this.replaceEventStream();
          }
          return result;
        }
        case "prompt":
        case "abort":
        case "compact":
          return this.webRequest("POST", `${runtimePath}/${type}`, type === "prompt" ? { message: params.message } : undefined);
        case "steer":
        case "follow_up":
          return this.webRequest("POST", `${runtimePath}/${type === "follow_up" ? "follow-up" : type}`, params);
        case "fork": {
          const result = await this.webRequest("POST", `${runtimePath}/fork`, params.entryId ? { entryId: params.entryId } : {});
          if (result.success) {
            await this.refreshRuntimeIdentity();
            await this.replaceEventStream();
          }
          return result;
        }
        case "clone": {
          const result = await this.webRequest("POST", `${sessionPath}/clone`);
          if (result.success) {
            await this.refreshRuntimeIdentity();
            await this.replaceEventStream();
          }
          return result;
        }
        case "set_model": return this.webRequest("POST", `${runtimePath}/model`, { provider: params.provider, modelId: params.modelId });
        case "set_thinking_level": return this.webRequest("POST", `${runtimePath}/thinking`, { level: params.level });
        case "bash": return this.webRequest("POST", `${sessionPath}/bash`, { command: params.command });
        case "abort_bash":
        case "abort_retry": return this.webRequest("POST", `${sessionPath}/${type.replaceAll("_", "-")}`);
        case "set_session_name": return this.webRequest("PATCH", sessionPath, { name: params.name });
        case "export_html": return this.asData(await this.webRequest("POST", `${sessionPath}/export`, { outputPath: params.outputPath }));
        default: return { success: false, code: "unsupported_command", error: `Pi Orbit Web Mode does not support command: ${type}` };
      }
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        success: false,
        code: timedOut ? "timeout" : "transport_error",
        error: timedOut ? `request timeout after ${this.requestTimeoutMs}ms` : error instanceof Error ? error.message : String(error),
      };
    }
  }

  private asData(result: PiResult): PiResult {
    return result.success ? { success: true, data: result.data } : result;
  }

  private async startEventStream(): Promise<void> {
    const controller = new AbortController();
    this.eventAbort = controller;
    const response = await this.openEventStream(controller);
    this.eventStreamAlive = true;
    void this.consumeEventStream(response, controller).catch((error: unknown) => {
      this.eventStreamAlive = false;
      if (!this.closed && !controller.signal.aborted) this.emit("stderr", `Pi Orbit event stream failed: ${String(error)}\n`);
    });
  }

  private async openEventStream(controller: AbortController): Promise<Response> {
    let response = await this.requestEventStream(this.lastEventSequence, controller);
    if (!response.ok) {
      // A silent connection can outlive Orbit's bounded replay buffer. In
      // that case the missing lifecycle is reconciled by get_state + the
      // persisted session JSONL, but we must still reattach at the live edge
      // to receive subsequent events instead of retrying a stale cursor.
      const replayGap = await this.replayGap(response);
      if (replayGap) {
        this.lastEventSequence = replayGap.latestSequence;
        this.emit(
          "stderr",
          `Pi Orbit event replay gap (${replayGap.oldestSequence}-${replayGap.latestSequence}); resuming from the live edge\n`,
        );
        response = await this.requestEventStream(this.lastEventSequence, controller);
      }
    }
    if (!response.ok || !response.body) throw new Error(await this.webHost!.responseError(response));
    return response;
  }

  private async replaceEventStream(): Promise<void> {
    this.eventAbort?.abort();
    this.eventStreamAlive = false;
    await this.startEventStream();
  }

  /** Re-establish the event stream from the last seen sequence. Public so the
   *  runtime watchdog can revive a silently dead connection without tearing
   *  down the runtime. Fire-and-forget from locked contexts: the underlying
   *  request has no timeout and would otherwise hold the lock forever. */
  async reconnectEventStream(): Promise<void> {
    if (this.closed) return;
    await this.replaceEventStream();
  }

  private async consumeEventStream(initialResponse: Response, controller: AbortController): Promise<void> {
    let response = initialResponse;
    while (!this.closed && !controller.signal.aborted) {
      if (!response.body) throw new Error("Pi Orbit event stream has no response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r", "");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try {
            const payload = JSON.parse(data) as Record<string, unknown>;
            if (typeof payload.sequence === "number") this.lastEventSequence = payload.sequence;
            this.lastEventAt = Date.now();
            const event = payload.event && typeof payload.event === "object" ? payload.event as PiEvent : undefined;
            if (event?.type) {
              this.emit("event", event);
              if (event.type === "runtime_evicted") {
                this.closed = true;
                this.emitExit(null, null);
                return;
              }
            }
          } catch {
            this.emit("malformed", data.slice(0, 500));
          }
        }
      }
      if (this.closed || controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.closed || controller.signal.aborted) return;
      response = await this.openEventStream(controller);
      this.eventStreamAlive = true;
    }
  }

  private requestEventStream(afterSequence: number, controller: AbortController): Promise<Response> {
    return this.webHost!.request(
      "GET",
      `${this.runtimePath()}/events?after=${afterSequence}`,
      undefined,
      0,
      controller.signal,
    );
  }

  private async replayGap(response: Response): Promise<{ oldestSequence: number; latestSequence: number } | null> {
    if (response.status !== 409) return null;
    try {
      const payload = await response.clone().json() as Record<string, unknown>;
      if (
        payload.code === "event_replay_gap"
        && typeof payload.oldestSequence === "number"
        && typeof payload.latestSequence === "number"
      ) {
        return { oldestSequence: payload.oldestSequence, latestSequence: payload.latestSequence };
      }
    } catch {
      // Preserve the original response body for the normal error path.
    }
    return null;
  }

  private async webRequest(method: string, path: string, body?: Record<string, unknown>): Promise<PiResult> {
    const response = await this.webHost!.request(method, path, body, this.requestTimeoutMs);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { payload = {}; }
    const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (!response.ok || data.success === false || data.cancelled === true) {
      return {
        ...data,
        success: false,
        code: String(data.code ?? (data.cancelled === true ? "cancelled" : `http_${response.status}`)),
        error: String(data.error ?? data.details ?? `Pi Orbit request failed with HTTP ${response.status}`),
      };
    }
    return { ...data, success: true, data: payload };
  }

  private runtimePath(): string {
    if (!this.runtimeId) throw new Error("Pi Orbit runtime is not initialized");
    return `/api/runtimes/${encodeURIComponent(this.runtimeId)}`;
  }

  private async refreshRuntimeIdentity(): Promise<void> {
    if (!this.runtimeIdentity) return;
    const result = await this.webRequest("GET", this.runtimePath());
    if (!result.success || !result.data || typeof result.data !== "object") return;
    const descriptor = result.data as Partial<PiOrbitRuntimeDescriptor>;
    if (descriptor.runtimeId === this.runtimeId && typeof descriptor.piSessionId === "string") {
      Object.assign(this.runtimeIdentity, descriptor);
    }
  }

  /** Mark the process closed and stop its event stream without disposing the
   *  web runtime. Used when the host itself is being torn down (shutdownAll),
   *  where per-runtime dispose would just burn the budget waiting on a process
   *  that is about to die anyway. */
  detachFromHost(): void {
    if (this.closed) return;
    this.closed = true;
    this.eventAbort?.abort();
    this.removeHostListeners?.();
    this.removeHostListeners = undefined;
  }

  private async disposeWebRuntime(): Promise<void> {
    const path = this.runtimePath();
    const budget = disposeBudgetMs();
    const deadline = Date.now() + Math.max(budget, 250);
    let delay = 250;
    try {
      // Abort is best-effort: a busy host may reject it, but the poll below
      // still observes the state and retries DELETE until the budget runs out.
      await this.webHost!.request("POST", `${path}/abort`, undefined, Math.min(this.requestTimeoutMs, 2_000)).catch(() => undefined);
      do {
        if (this.webHost!.isClosed) return;
        const state = await this.webHost!.request("GET", path, undefined, Math.min(this.requestTimeoutMs, 1_000)).catch(() => undefined);
        if (state) {
          if (state.status === 404) return;
          if (state.ok) {
            const descriptor = await state.json().catch(() => ({})) as { busy?: unknown };
            if (descriptor.busy !== true) {
              const deleted = await this.webHost!.request("DELETE", path, undefined, Math.min(this.requestTimeoutMs, 2_000)).catch(() => undefined);
              if (!deleted) { await sleep(delay); delay = Math.min(delay * 2, 1_000); continue; }
              if (deleted.ok || deleted.status === 404) return;
              if (deleted.status === 409) { await sleep(delay); delay = Math.min(delay * 2, 1_000); continue; }
              if (!this.webHost!.isClosed) this.emit("stderr", `Unable to dispose Pi Orbit runtime: ${await this.webHost!.responseError(deleted)}\n`);
              return;
            }
          }
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 1_000);
      } while (Date.now() < deadline);
      if (!this.webHost!.isClosed) this.emit("stderr", `Unable to dispose Pi Orbit runtime within ${budget}ms: runtime stayed busy\n`);
    } catch (error) {
      if (!this.webHost!.isClosed) this.emit("stderr", `Unable to dispose Pi Orbit runtime: ${String(error)}\n`);
    }
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
