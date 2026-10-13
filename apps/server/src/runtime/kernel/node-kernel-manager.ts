import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import { metadataRoot } from "../../storage/persistence.js";
import {
  environmentPythonExecutable,
  workspaceEnvironmentVariables,
  type WorkspaceEnvironmentStatus,
} from "../workspace/workspace-environment.js";
import {
  boundKernelHeadText,
  boundKernelPayload,
  boundKernelStreamText,
  KERNEL_TRUNCATION_MARKER,
  kernelOutputLimitArgs,
  kernelOutputLimits,
  kernelPayloadMarker,
  type KernelOutputLimits,
} from "./kernel-output-limits.js";

export type KernelLanguage = "python" | "r";

export interface KernelStreamEvent {
  type: "stream";
  stream: "stdout" | "stderr";
  text: string;
}

export interface KernelOutput {
  output_type: string;
  data: Record<string, string>;
}

/** Characters produced by the cell but not delivered; a key exists only above zero, so `{}` means intact. */
export interface KernelTruncationReport {
  stdout_chars?: number;
  stderr_chars?: number;
  result_chars?: number;
  rich_chars?: number;
  outputs_dropped?: number;
}

export interface KernelResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: string | null;
  error?: string | null;
  interrupted: boolean;
  mime: Record<string, string>;
  outputs?: KernelOutput[];
  truncated?: KernelTruncationReport;
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
  spawnProcess?: typeof spawn;
  killProcessTree?: (pid: number) => void;
  limits?: KernelOutputLimits;
}

const PYTHON_BRIDGE = fileURLToPath(new URL("./bridges/kernel_bridge.py", import.meta.url));
const R_BRIDGE = fileURLToPath(new URL("./bridges/kernel_bridge.R", import.meta.url));
const HEALTH_CHECK_CODE = "1+1";
const INTERRUPT_GRACE_MS = 2_000;

class KernelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelTimeoutError";
  }
}

/** The bridge wrote a protocol line the host refuses to parse or retain. */
export class KernelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelProtocolError";
  }
}

interface StreamBudget { spent: number; muted: boolean }
type StreamBudgets = Record<"stdout" | "stderr", StreamBudget>;

interface PendingCell {
  resolve: (result: KernelResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: KernelStreamEvent) => void;
  promise: Promise<KernelResult>;
  budgets: StreamBudgets;
}

interface KernelStartState { options: KernelExecuteOptions; controller: AbortController }
interface KernelShutdownScope { notebookId: string; cwd?: string; language?: string }

function kernelIdentity(options: KernelExecuteOptions): string {
  return options.kernelInstanceId ?? options.sessionId ?? options.notebookId ?? "default";
}

function sessionKey(options: KernelExecuteOptions): string {
  return [options.cwd, kernelIdentity(options), options.environmentRevisionId ?? "legacy", options.language].join("\0");
}

function matchesShutdown(options: KernelExecuteOptions, scope: KernelShutdownScope): boolean {
  const identity = options.kernelInstanceId ?? options.sessionId ?? options.notebookId;
  return (options.notebookId === scope.notebookId || identity === scope.notebookId)
    && (scope.cwd === undefined || resolve(options.cwd) === scope.cwd)
    && (scope.language === undefined || options.language === scope.language);
}

function kernelStartCancelledError(): Error { return new Error("Kernel start cancelled by shutdown"); }

function defaultInterpreterAvailable(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    return result.error === undefined && result.status !== null;
  } catch {
    return false;
  }
}

function defaultKillProcessTree(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("error", () => undefined);
}

export class NodeKernelManager {
  private readonly sessions = new Map<string, NodeKernelSession>();
  private readonly starting = new Map<string, { state: KernelStartState; promise: Promise<NodeKernelSession> }>();
  private readonly notebookShutdowns = new Set<KernelShutdownScope>();
  private stoppingAll: Promise<void> | null = null;
  private readonly deps: Required<NodeKernelManagerDependencies>;

  constructor(deps: NodeKernelManagerDependencies = {}) {
    this.deps = {
      workspaceEnvironmentVariables: deps.workspaceEnvironmentVariables ?? workspaceEnvironmentVariables,
      platform: deps.platform ?? process.platform,
      interpreterAvailable: deps.interpreterAvailable ?? defaultInterpreterAvailable,
      spawnProcess: deps.spawnProcess ?? spawn,
      killProcessTree: deps.killProcessTree ?? defaultKillProcessTree,
      limits: deps.limits ?? kernelOutputLimits(process.env),
    };
  }

  async execute(options: KernelExecuteOptions): Promise<KernelResult> {
    const key = sessionKey(options);
    const session = await this.ensureSession(key, options);
    try {
      return await session.execute(options);
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      await session.stop().catch(() => undefined);
      throw error;
    }
  }

  /** Cold starts are deduplicated per session key so concurrent cells share one kernel spawn. */
  private ensureSession(key: string, options: KernelExecuteOptions): Promise<NodeKernelSession> {
    if (this.stoppingAll || [...this.notebookShutdowns].some((scope) => matchesShutdown(options, scope))) return Promise.reject(new Error("Kernel shutdown is in progress"));
    const existing = this.sessions.get(key);
    if (existing && !existing.exited) return Promise.resolve(existing);
    const pending = this.starting.get(key);
    if (pending) return pending.promise;
    const state: KernelStartState = { options: { ...options }, controller: new AbortController() };
    const started = this.startSession(key, options, state).finally(() => {
      if (this.starting.get(key)?.state === state) this.starting.delete(key);
    });
    this.starting.set(key, { state, promise: started });
    return started;
  }

  private async startSession(key: string, options: KernelExecuteOptions, state: KernelStartState): Promise<NodeKernelSession> {
    const stale = this.sessions.get(key);
    if (stale) {
      await stale.stop().catch(() => undefined);
      if (this.sessions.get(key) === stale) this.sessions.delete(key);
    }
    if (state.controller.signal.aborted) throw kernelStartCancelledError();
    const session = await NodeKernelSession.start(options, this.deps, state.controller.signal);
    if (state.controller.signal.aborted || this.starting.get(key)?.state !== state) {
      await session.stop().catch(() => undefined);
      throw kernelStartCancelledError();
    }
    this.sessions.set(key, session);
    return session;
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
    const scope: KernelShutdownScope = { notebookId, ...(cwd ? { cwd: resolve(cwd) } : {}), ...(language ? { language } : {}) };
    this.notebookShutdowns.add(scope);
    try {
      const starts = [...this.starting.values()].filter(({ state }) => matchesShutdown(state.options, scope));
      for (const { state } of starts) state.controller.abort();
      const sessions: NodeKernelSession[] = [];
      for (const [key, session] of this.sessions) {
        const identity = session.kernelInstanceId ?? session.sessionId ?? session.notebookId;
        if ((session.notebookId !== notebookId && identity !== notebookId) || (scope.cwd !== undefined && session.cwd !== scope.cwd) || (language !== undefined && session.language !== language)) continue;
        this.sessions.delete(key);
        sessions.push(session);
      }
      await Promise.all([...sessions.map((session) => session.stop().catch(() => undefined)), ...starts.map(({ promise }) => promise.then(() => undefined, () => undefined))]);
    } finally {
      this.notebookShutdowns.delete(scope);
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

  shutdownAll(): Promise<void> {
    if (this.stoppingAll) return this.stoppingAll;
    const stopping = this.stopAll().finally(() => {
      if (this.stoppingAll === stopping) this.stoppingAll = null;
    });
    this.stoppingAll = stopping;
    return stopping;
  }

  private async stopAll(): Promise<void> {
    const starts = [...this.starting.values()];
    for (const { state } of starts) state.controller.abort();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all([...sessions.map((session) => session.stop().catch(() => undefined)), ...starts.map(({ promise }) => promise.then(() => undefined, () => undefined))]);
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
  private stopPromise?: Promise<void>;

  private constructor(
    private readonly options: KernelExecuteOptions,
    private readonly deps: Required<NodeKernelManagerDependencies>,
  ) {
    if (options.language === "r") {
      const hash = createHash("sha256").update([options.cwd, options.environmentRevisionId ?? "legacy", randomUUID()].join("\0")).digest("hex").slice(0, 20);
      this.rCodeFile = join(metadataRoot(options.cwd), "runtime", "kernels", `${hash}.R`);
    }
  }

  static async start(options: KernelExecuteOptions, deps: Required<NodeKernelManagerDependencies>, signal?: AbortSignal): Promise<NodeKernelSession> {
    const session = new NodeKernelSession(options, deps);
    const stopOnAbort = () => { void session.stop().catch(() => undefined); };
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (signal?.aborted) throw kernelStartCancelledError();
      await session.start(signal);
      if (signal?.aborted) throw kernelStartCancelledError();
      return session;
    } catch (error) {
      await session.stop().catch(() => undefined);
      throw signal?.aborted ? kernelStartCancelledError() : error;
    } finally {
      signal?.removeEventListener("abort", stopOnAbort);
    }
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
    // An idle kernel has no cell in flight; signalling it would tear down a
    // healthy process and its namespace for nothing.
    if (this.pending.size === 0) return false;
    try {
      child.kill(this.interruptSignal());
      return true;
    } catch {
      return false;
    }
  }

  private interruptSignal(): NodeJS.Signals {
    // With a detached Windows spawn, SIGBREAK arrives as CTRL_BREAK_EVENT and
    // kernel_bridge.py converts it into an in-cell KeyboardInterrupt; POSIX
    // keeps the plain SIGINT path.
    return this.deps.platform === "win32" ? "SIGBREAK" : "SIGINT";
  }


  stop(): Promise<void> {
    this.stopPromise ??= this.stopUnlocked();
    return this.stopPromise;
  }

  private async stopUnlocked(): Promise<void> {
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Kernel process stopped"));
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      if (this.deps.platform === "win32" && child.pid !== undefined) {
        // Detached Windows kernels form their own process group; killing only
        // the direct child (TerminateProcess) would orphan grandchildren, so
        // tear down the whole tree and wait for the pipes to close.
        this.deps.killProcessTree?.(child.pid);
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          child.once("exit", finish);
          child.once("close", finish);
          const failsafe = setTimeout(finish, 2_000);
          failsafe.unref?.();
        });
      } else {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          let settled = false;
          const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(force);
            resolve();
          };
          force.unref?.();
          child.once("exit", finish);
          child.once("close", finish);
        });
      }
    }
    this.reader?.close();
    this.reader = undefined;
    if (this.rCodeFile) await rm(this.rCodeFile, { force: true }).catch(() => undefined);
  }

  private async start(signal?: AbortSignal): Promise<void> {
    const executable = this.executablePath();
    const args = this.options.language === "python"
      ? [PYTHON_BRIDGE, ...kernelOutputLimitArgs(this.deps.limits)]
      : [R_BRIDGE, this.rCodeFile!, ...kernelOutputLimitArgs(this.deps.limits)];
    if (this.rCodeFile) {
      await mkdir(join(metadataRoot(this.options.cwd), "runtime", "kernels"), { recursive: true });
      await writeFile(this.rCodeFile, "", "utf8");
    }
    if (signal?.aborted) throw kernelStartCancelledError();
    const env = this.deps.workspaceEnvironmentVariables(this.options.environment);
    const child = this.deps.spawnProcess(executable, args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // A new process group lets Windows deliver CTRL_BREAK_EVENT (SIGBREAK)
      // to the kernel alone instead of terminating the whole tree.
      ...(this.deps.platform === "win32" ? { detached: true } : {}),
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
    child.once("exit", (code, exitSignal) => {
      if (this.child !== child) return;
      this.exited = true;
      const message = `Kernel process exited (code=${code ?? "none"}, signal=${exitSignal ?? "none"})${this.stderrTail.length ? `: ${this.stderrTail.at(-1)?.trim()}` : ""}`;
      for (const pending of this.pending.values()) pending.reject(new Error(message));
      this.pending.clear();
      this.reader?.close();
      this.reader = undefined;
    });
    if (signal?.aborted) throw kernelStartCancelledError();

    const health = await this.sendRequest(HEALTH_CHECK_CODE, undefined, 30_000);
    if (!health.ok) throw new Error(`Kernel health check failed: ${health.error ?? "unknown error"}`);
  }

  private executablePath(): string {
    const bin = this.deps.platform === "win32" ? "Scripts" : "bin";
    if (this.options.language === "python") {
      return environmentPythonExecutable(this.options.environment.prefix, this.deps.platform);
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
    this.pending.set(id, { resolve: resolveResult, reject: rejectResult, onEvent, promise: result, budgets: { stdout: { spent: 0, muted: false }, stderr: { spent: 0, muted: false } } });
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
      child.kill(this.interruptSignal());
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
    const frameLimit = this.deps.limits.frameChars;
    if (line.length > frameLimit) {
      // Parsing or retaining a line this large is the failure mode this guard
      // exists to prevent, so the session dies instead of clamping it.
      const error = new KernelProtocolError(`Kernel protocol line exceeded ${frameLimit} characters`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.exited = true;
      this.child?.kill();
      return;
    }
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
        this.forwardStream(pending, message.stream === "stderr" ? "stderr" : "stdout", message.text);
      }
      return;
    }
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(normalizeResult(message, this.deps.limits));
  }

  private forwardStream(pending: PendingCell, stream: "stdout" | "stderr", text: string): void {
    const cap = stream === "stderr" ? this.deps.limits.stderrChars : this.deps.limits.stdoutChars;
    const budget = pending.budgets[stream];
    if (budget.muted) return;
    const room = cap - budget.spent;
    if (text.length <= room) {
      budget.spent += text.length;
      pending.onEvent?.({ type: "stream", stream, text });
      return;
    }
    const head = room > 0 ? text.slice(0, room) : "";
    budget.spent += head.length;
    if (head) pending.onEvent?.({ type: "stream", stream, text: head });
    // The marker replaces every character past the cap, and the channel then
    // stays silent; the protocol already carries the same text in the result
    // line, so a stream drop is not a payload the cell failed to deliver.
    budget.muted = true;
    pending.onEvent?.({ type: "stream", stream, text: KERNEL_TRUNCATION_MARKER });
  }
}

const TRUNCATION_KEYS = ["stdout_chars", "stderr_chars", "result_chars", "rich_chars", "outputs_dropped"] as const;
type TruncationKey = typeof TRUNCATION_KEYS[number];

/** Counts arrive from the bridge, so a value that is not a positive integer is not a count. */
function mergedTruncationReport(...reports: unknown[]): KernelTruncationReport {
  const merged: KernelTruncationReport = {};
  for (const report of reports) {
    if (report === null || typeof report !== "object" || Array.isArray(report)) continue;
    const fields = report as Record<string, unknown>;
    for (const key of TRUNCATION_KEYS) {
      const value = fields[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) continue;
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}

function normalizeBundle(
  raw: Record<string, unknown>,
  limits: KernelOutputLimits,
  budget: { remaining: number },
  charge: (dropped: number) => void,
  notices: string[],
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [mime, item] of Object.entries(raw)) {
    if (typeof item !== "string") continue;
    const bounded = boundKernelPayload(item, mime, limits.mimeChars);
    if (bounded !== null && bounded.length <= budget.remaining) {
      budget.remaining -= bounded.length;
      charge(item.length - bounded.length);
      kept[mime] = bounded;
      continue;
    }
    charge(item.length);
    notices.push(kernelPayloadMarker(mime));
  }
  return kept;
}

function normalizeResult(message: Record<string, unknown>, limits: KernelOutputLimits): KernelResult {
  const report = mergedTruncationReport(message.truncated);
  const charge = (key: TruncationKey, dropped: number) => {
    if (dropped > 0) report[key] = (report[key] ?? 0) + dropped;
  };

  const rawStdout = typeof message.stdout === "string" ? message.stdout : "";
  const stdout = boundKernelStreamText(rawStdout, limits.stdoutChars);
  charge("stdout_chars", rawStdout.length - stdout.length);
  const rawStderr = typeof message.stderr === "string" ? message.stderr : "";
  const stderr = boundKernelStreamText(rawStderr, limits.stderrChars);
  charge("stderr_chars", rawStderr.length - stderr.length);
  // A traceback shares the stderr channel and its cap.
  const rawError = message.error === null || message.error === undefined ? null : String(message.error);
  const error = rawError === null ? null : boundKernelStreamText(rawError, limits.stderrChars);
  if (rawError !== null && error !== null) charge("stderr_chars", rawError.length - error.length);
  const rawResult = message.result === null || message.result === undefined ? null : String(message.result);
  const result = rawResult === null ? null : boundKernelHeadText(rawResult, limits.resultChars);
  if (rawResult !== null && result !== null) charge("result_chars", rawResult.length - result.length);

  const notices: string[] = [];
  const budget = { remaining: limits.outputsChars };
  const richCharge = (dropped: number) => charge("rich_chars", dropped);
  const mime = message.mime !== null && typeof message.mime === "object" && !Array.isArray(message.mime)
    ? normalizeBundle(message.mime as Record<string, unknown>, limits, budget, richCharge, notices)
    : {};
  const outputs: KernelOutput[] = [];
  for (const value of Array.isArray(message.outputs) ? message.outputs : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const output = value as Record<string, unknown>;
    if (typeof output.output_type !== "string" || !output.data || typeof output.data !== "object" || Array.isArray(output.data)) continue;
    if (outputs.length >= limits.displayOutputs) {
      charge("outputs_dropped", 1);
      notices.push(KERNEL_TRUNCATION_MARKER);
      continue;
    }
    outputs.push({ output_type: output.output_type, data: normalizeBundle(output.data as Record<string, unknown>, limits, budget, richCharge, notices) });
  }
  // One notice stands in for every dropped payload, in an output whose only key is
  // text/plain: a marker written next to a surviving payload is not rendered, and
  // it takes a display slot like any other output.
  if (notices.length > 0) {
    if (outputs.length >= limits.displayOutputs) {
      outputs.pop();
      charge("outputs_dropped", 1);
    }
    outputs.push({ output_type: "display_data", data: { "text/plain": notices.join("") } });
  }

  return {
    ok: message.ok === true,
    stdout,
    stderr,
    result,
    error,
    interrupted: message.interrupted === true,
    mime,
    outputs,
    ...(Object.keys(report).length > 0 ? { truncated: report } : {}),
  };
}
