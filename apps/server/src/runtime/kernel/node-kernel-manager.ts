import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import { metadataRoot } from "../../storage/persistence.js";
import { toolEnvironment } from "../agent/agent-runtime-environment.js";
import { workspacePolicy, type SandboxPolicy } from "../sandbox/policy.js";
import { bindRuntimeReadPolicy } from "../sandbox/read-grants.js";
import {
  killSandboxGroup,
  retireSandboxGroup,
  launcherPath,
  prepareSandbox,
  type PreparedSandbox,
} from "../sandbox/process.js";
import {
  environmentPythonExecutable,
  workspaceEnvironmentVariables,
  type WorkspaceEnvironmentStatus,
} from "../workspace/workspace-environment.js";

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

export interface KernelResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: string | null;
  error?: string | null;
  interrupted: boolean;
  mime: Record<string, string>;
  outputs?: KernelOutput[];
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
  /** Trusted internal binding, never accepted from the HTTP request body. */
  sandboxPolicy?: SandboxPolicy;
  /** Re-resolve signed authority after queueing and immediately before dispatch. */
  authorize?: () => Promise<SandboxPolicy>;
  abortSignal?: AbortSignal;
}

export interface KernelSessionSnapshot {
  notebookId: string | null;
  sessionId: string | null;
  kernelInstanceId: string | null;
  language: KernelLanguage;
  cwd: string;
  environmentRevisionId: string | null;
  alive: boolean;
  sandboxPolicyId: string | null;
}

export interface KernelManagerStatus {
  interpreters: { python: boolean; r: boolean };
  sessions: KernelSessionSnapshot[];
  active_count: number;
  native: boolean;
}

export interface NodeKernelManagerDependencies {
  workspaceEnvironmentVariables?: (
    status: WorkspaceEnvironmentStatus,
    inherited?: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  interpreterAvailable?: (command: string) => boolean;
  spawnProcess?: typeof spawn;
  killProcessTree?: (pid: number) => void;
}

const PYTHON_BRIDGE = fileURLToPath(new URL("./bridges/kernel_bridge.py", import.meta.url));
const R_BRIDGE = fileURLToPath(new URL("./bridges/kernel_bridge.R", import.meta.url));
const HEALTH_CHECK_CODE = "1+1";
const INTERRUPT_GRACE_MS = 2_000;
const MAX_KERNEL_OUTPUT_BYTES = 16 * 1024 * 1024;

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

interface KernelStartState {
  options: KernelExecuteOptions;
  controller: AbortController;
}
interface KernelShutdownScope {
  notebookId: string;
  cwd?: string;
  language?: string;
}

function kernelIdentity(options: KernelExecuteOptions): string {
  return options.kernelInstanceId ?? options.sessionId ?? options.notebookId ?? "default";
}

function sessionKey(options: KernelExecuteOptions): string {
  return [
    options.cwd,
    kernelIdentity(options),
    options.environmentRevisionId ?? "legacy",
    options.language,
    options.sandboxPolicy!.id,
  ].join("\0");
}

function matchesShutdown(options: KernelExecuteOptions, scope: KernelShutdownScope): boolean {
  const identity = options.kernelInstanceId ?? options.sessionId ?? options.notebookId;
  return (
    (options.notebookId === scope.notebookId || identity === scope.notebookId) &&
    (scope.cwd === undefined || resolve(options.cwd) === scope.cwd) &&
    (scope.language === undefined || options.language === scope.language)
  );
}

function kernelStartCancelledError(): Error {
  return new Error("Kernel start cancelled by shutdown");
}

function defaultInterpreterAvailable(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    return result.error === undefined && result.status !== null;
  } catch {
    return false;
  }
}

function defaultKillProcessTree(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once(
    "error",
    () => undefined,
  );
}

export class NodeKernelManager {
  private readonly admissionTails = new Map<string, Promise<void>>();
  private readonly requests = new Set<KernelStartState>();
  private readonly sessions = new Map<string, NodeKernelSession>();
  private readonly retirements = new Map<NodeKernelSession, string>();
  private readonly starting = new Map<
    string,
    { state: KernelStartState; promise: Promise<NodeKernelSession> }
  >();
  private readonly notebookShutdowns = new Set<KernelShutdownScope>();
  private stoppingAll: Promise<void> | null = null;
  private readonly deps: Required<NodeKernelManagerDependencies>;

  constructor(deps: NodeKernelManagerDependencies = {}) {
    this.deps = {
      workspaceEnvironmentVariables:
        deps.workspaceEnvironmentVariables ?? workspaceEnvironmentVariables,
      platform: deps.platform ?? process.platform,
      interpreterAvailable: deps.interpreterAvailable ?? defaultInterpreterAvailable,
      spawnProcess: deps.spawnProcess ?? spawn,
      killProcessTree: deps.killProcessTree ?? defaultKillProcessTree,
    };
  }

  async execute(options: KernelExecuteOptions): Promise<KernelResult> {
    if (
      this.stoppingAll ||
      [...this.notebookShutdowns].some((scope) => matchesShutdown(options, scope))
    )
      throw new Error("Kernel shutdown is in progress");
    const request: KernelStartState = { options, controller: new AbortController() };
    this.requests.add(request);
    // Reserve submission order before any async policy or cold-start work.
    // Include policy/environment transitions in the same logical-kernel queue.
    const key = [resolve(options.cwd), kernelIdentity(options), options.language].join("\0");
    const run = (this.admissionTails.get(key) ?? Promise.resolve()).then(() =>
      this.executeAuthorized({
        ...options,
        abortSignal: options.abortSignal
          ? AbortSignal.any([options.abortSignal, request.controller.signal])
          : request.controller.signal,
      }),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.admissionTails.set(key, tail);
    try {
      return await run;
    } finally {
      this.requests.delete(request);
      if (this.admissionTails.get(key) === tail) this.admissionTails.delete(key);
    }
  }

  private async executeAuthorized(options: KernelExecuteOptions): Promise<KernelResult> {
    options.abortSignal?.throwIfAborted();
    if (options.authorize) options = { ...options, sandboxPolicy: await options.authorize() };
    options = {
      ...options,
      environmentRevisionId: options.environmentRevisionId ?? options.environment.revision_id,
      sandboxPolicy:
        options.sandboxPolicy ??
        (await workspacePolicy(
          options.cwd,
          options.environmentRevisionId ?? options.environment.revision_id,
        )),
    };
    options.sandboxPolicy = await bindRuntimeReadPolicy(options.sandboxPolicy!);
    options.abortSignal?.throwIfAborted();
    const key = sessionKey(options);
    // A changed authorization/environment must retire the old namespace and process.
    for (const [oldKey, old] of this.sessions)
      if (
        oldKey !== key &&
        old.cwd === options.cwd &&
        old.language === options.language &&
        (old.kernelInstanceId ?? old.sessionId ?? old.notebookId ?? "default") ===
          kernelIdentity(options)
      ) {
        await this.retireSession(oldKey, old);
      }
    for (const [oldKey, pending] of this.starting)
      if (
        oldKey !== key &&
        pending.state.options.cwd === options.cwd &&
        pending.state.options.language === options.language &&
        kernelIdentity(pending.state.options) === kernelIdentity(options)
      ) {
        pending.state.controller.abort();
        await pending.promise.catch(() => undefined);
      }
    options.abortSignal?.throwIfAborted();
    const session = await this.ensureSession(key, options);
    const abort = () => {
      void this.retireSession(key, session).catch(() => undefined);
    };
    options.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      options.abortSignal?.throwIfAborted();
      if (options.authorize && (await options.authorize()).id !== options.sandboxPolicy!.id)
        throw new Error("Kernel approval changed before dispatch");
      return await session.execute(options);
    } catch (error) {
      try {
        await this.retireSession(key, session);
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          "Kernel execution failed and retirement is incomplete",
        );
      }
      throw error;
    } finally {
      options.abortSignal?.removeEventListener("abort", abort);
    }
  }

  /** A reference is authority evidence until stop verifies exit and cleanup. */
  private managedSessions(): Array<readonly [string, NodeKernelSession]> {
    const all = new Map<NodeKernelSession, string>(this.retirements);
    for (const [key, session] of this.sessions) all.set(session, key);
    return [...all].map(([session, key]) => [key, session] as const);
  }

  private async retireSession(key: string, session: NodeKernelSession): Promise<void> {
    this.retirements.set(session, key);
    await session.stop();
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    this.retirements.delete(session);
  }

  /** Cold starts are deduplicated per session key so concurrent cells share one kernel spawn. */
  private ensureSession(key: string, options: KernelExecuteOptions): Promise<NodeKernelSession> {
    if (
      this.stoppingAll ||
      [...this.notebookShutdowns].some((scope) => matchesShutdown(options, scope))
    )
      return Promise.reject(new Error("Kernel shutdown is in progress"));
    const failed = [...this.retirements].filter(
      ([session]) =>
        session.cwd === options.cwd &&
        session.language === options.language &&
        (session.kernelInstanceId ?? session.sessionId ?? session.notebookId ?? "default") ===
          kernelIdentity(options),
    );
    if (failed.length)
      return Promise.all(
        failed.map(([session, oldKey]) => this.retireSession(oldKey, session)),
      ).then(() => this.ensureSession(key, options));
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

  private async startSession(
    key: string,
    options: KernelExecuteOptions,
    state: KernelStartState,
  ): Promise<NodeKernelSession> {
    const stale = this.sessions.get(key);
    if (stale) {
      await this.retireSession(key, stale);
    }
    if (state.controller.signal.aborted) throw kernelStartCancelledError();
    const session = await NodeKernelSession.start(
      options,
      this.deps,
      options.abortSignal
        ? AbortSignal.any([state.controller.signal, options.abortSignal])
        : state.controller.signal,
      (created) => {
        this.retirements.set(created, key);
        return () => {
          this.retirements.delete(created);
        };
      },
    );
    if (state.controller.signal.aborted || this.starting.get(key)?.state !== state) {
      await this.retireSession(key, session);
      throw kernelStartCancelledError();
    }
    this.sessions.set(key, session);
    this.retirements.delete(session);
    return session;
  }

  /** Health probes count managed processes without launching interpreter discovery. */
  get activeCount(): number {
    return this.managedSessions().filter(([, session]) => !session.exited).length;
  }

  status(): KernelManagerStatus {
    const sessions = this.managedSessions().map(([, session]) => session);
    const python = this.deps.interpreterAvailable(
      this.deps.platform === "win32" ? "python" : "python3",
    );
    const r = this.deps.interpreterAvailable("Rscript");
    return {
      interpreters: { python, r },
      sessions: sessions.map((session) => session.snapshot()),
      active_count: sessions.filter((session) => !session.exited).length,
      native: true,
    };
  }

  async shutdownNotebook(notebookId: string, cwd?: string, language?: string): Promise<void> {
    const scope: KernelShutdownScope = {
      notebookId,
      ...(cwd ? { cwd: resolve(cwd) } : {}),
      ...(language ? { language } : {}),
    };
    this.notebookShutdowns.add(scope);
    for (const request of this.requests)
      if (matchesShutdown(request.options, scope)) request.controller.abort();
    try {
      const starts = [...this.starting.values()].filter(({ state }) =>
        matchesShutdown(state.options, scope),
      );
      for (const { state } of starts) state.controller.abort();
      const sessions: Array<readonly [string, NodeKernelSession]> = [];
      for (const [key, session] of this.managedSessions()) {
        const identity = session.kernelInstanceId ?? session.sessionId ?? session.notebookId;
        if (
          (session.notebookId !== notebookId && identity !== notebookId) ||
          (scope.cwd !== undefined && session.cwd !== scope.cwd) ||
          (language !== undefined && session.language !== language)
        )
          continue;
        sessions.push([key, session]);
      }
      await Promise.all([
        ...sessions.map(([key, session]) => this.retireSession(key, session)),
        ...starts.map(({ promise }) =>
          promise.then(
            () => undefined,
            () => undefined,
          ),
        ),
      ]);
    } finally {
      this.notebookShutdowns.delete(scope);
    }
  }

  async interruptNotebook(notebookId: string, cwd: string, language?: string): Promise<boolean> {
    const resolved = resolve(cwd);
    let interrupted = false;
    for (const session of this.sessions.values()) {
      const identity = session.kernelInstanceId ?? session.sessionId ?? session.notebookId;
      if (
        (session.notebookId !== notebookId && identity !== notebookId) ||
        session.cwd !== resolved
      )
        continue;
      if (language !== undefined && session.language !== language) continue;
      interrupted = session.interrupt() || interrupted;
    }
    return interrupted;
  }

  /** Includes in-flight starts/requests, not just ready kernels. */
  hasOwner(cwd: string, owner: string): boolean {
    return (
      [...this.requests].some(
        ({ options }) => options.cwd === cwd && options.sandboxPolicy?.owner === owner,
      ) ||
      [...this.starting.values()].some(
        ({ state }) => state.options.cwd === cwd && state.options.sandboxPolicy?.owner === owner,
      ) ||
      this.managedSessions().some(([, session]) => session.cwd === cwd && session.owner === owner)
    );
  }

  async revokeOwner(cwd: string, owner: string): Promise<{ kernelRestartCount: number }> {
    const count = this.managedSessions().filter(
      ([, session]) => session.cwd === cwd && session.owner === owner,
    ).length;
    await this.shutdownOwner(cwd, owner);
    if (this.hasOwner(cwd, owner)) throw new Error("Kernel capability revocation is incomplete");
    return { kernelRestartCount: count };
  }

  /** Called by the owning server when a Worker exits, including unexpected death. */
  async shutdownOwner(cwd: string, owner: string): Promise<void> {
    for (const request of this.requests)
      if (request.options.cwd === cwd && request.options.sandboxPolicy?.owner === owner)
        request.controller.abort();
    const starts = [...this.starting.values()].filter(
      ({ state }) => state.options.cwd === cwd && state.options.sandboxPolicy?.owner === owner,
    );
    for (const { state } of starts) state.controller.abort();
    const sessions = this.managedSessions().filter(
      ([, session]) => session.cwd === cwd && session.owner === owner,
    );
    // Keep failed retirements visible to capability checks and subsequent retries.
    await Promise.all([
      ...sessions.map(([key, session]) => this.retireSession(key, session)),
      ...starts.map(({ promise }) =>
        promise.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ]);
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
    for (const request of this.requests) request.controller.abort();
    const starts = [...this.starting.values()];
    for (const { state } of starts) state.controller.abort();
    const sessions = this.managedSessions();
    await Promise.all([
      ...sessions.map(([key, session]) => this.retireSession(key, session)),
      ...starts.map(({ promise }) =>
        promise.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ]);
  }
}

class NodeKernelSession {
  exited = false;
  private child?: ChildProcess;
  private readonly closedChildren = new WeakSet<ChildProcess>();
  private reader?: Interface;
  private readonly pending = new Map<string, PendingCell>();
  private readonly rCodeFile?: string;
  private readonly stderrTail: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private stopPromise?: Promise<void>;
  private sandbox?: PreparedSandbox;
  private outputBytes = 0;

  private constructor(
    private readonly options: KernelExecuteOptions,
    private readonly deps: Required<NodeKernelManagerDependencies>,
  ) {
    if (options.language === "r") {
      const hash = createHash("sha256")
        .update([options.cwd, options.environmentRevisionId ?? "legacy", randomUUID()].join("\0"))
        .digest("hex")
        .slice(0, 20);
      this.rCodeFile = join(metadataRoot(options.cwd), "runtime", "kernels", `${hash}.R`);
    }
  }

  static async start(
    options: KernelExecuteOptions,
    deps: Required<NodeKernelManagerDependencies>,
    signal?: AbortSignal,
    onCreated?: (session: NodeKernelSession) => () => void,
  ): Promise<NodeKernelSession> {
    const session = new NodeKernelSession(options, deps);
    const retired = onCreated?.(session);
    const stopOnAbort = () => {
      void session.stop().catch(() => undefined);
    };
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (signal?.aborted) throw kernelStartCancelledError();
      await session.start(signal);
      if (signal?.aborted) throw kernelStartCancelledError();
      return session;
    } catch (error) {
      // An abort may have stopped before asynchronous setup finished allocating
      // files. Retry cleanup now that startup has settled, retaining failures.
      await session.stopPromise?.catch(() => undefined);
      session.stopPromise = undefined;
      try {
        await session.stop();
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          "Kernel startup failed and retirement is incomplete",
        );
      }
      retired?.();
      throw signal?.aborted ? kernelStartCancelledError() : error;
    } finally {
      signal?.removeEventListener("abort", stopOnAbort);
    }
  }

  execute(options: KernelExecuteOptions): Promise<KernelResult> {
    const run = this.tail.then(() => this.perform(options));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get notebookId(): string | null {
    return this.options.notebookId ?? null;
  }
  get sessionId(): string | null {
    return this.options.sessionId ?? null;
  }
  get kernelInstanceId(): string | null {
    return this.options.kernelInstanceId ?? null;
  }
  get cwd(): string {
    return this.options.cwd;
  }
  get language(): KernelLanguage {
    return this.options.language;
  }
  get environmentRevisionId(): string | null {
    return this.options.environmentRevisionId ?? null;
  }
  get owner(): string | undefined {
    return this.options.sandboxPolicy?.owner;
  }

  snapshot(): KernelSessionSnapshot {
    return {
      notebookId: this.notebookId,
      sessionId: this.sessionId,
      kernelInstanceId: this.kernelInstanceId,
      language: this.language,
      cwd: this.cwd,
      environmentRevisionId: this.environmentRevisionId,
      alive: !this.exited,
      sandboxPolicyId: this.options.sandboxPolicy?.id ?? null,
    };
  }

  interrupt(): boolean {
    const child = this.child;
    if (!child || child.exitCode !== null) return false;
    // An idle kernel has no cell in flight; signalling it would tear down a
    // healthy process and its namespace for nothing.
    if (this.pending.size === 0) return false;
    try {
      if (this.sandbox) child.send("interrupt");
      else child.kill(this.interruptSignal());
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
    this.stopPromise ??= this.stopUnlocked().catch((error) => {
      this.stopPromise = undefined;
      throw error;
    });
    return this.stopPromise;
  }

  private async stopUnlocked(): Promise<void> {
    this.exited = true;
    for (const pending of this.pending.values())
      pending.reject(new Error("Kernel process stopped"));
    this.pending.clear();
    const child = this.child;
    if (
      child &&
      !this.closedChildren.has(child) &&
      child.exitCode === null &&
      child.signalCode == null
    ) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let force: NodeJS.Timeout | undefined;
        let deadline: NodeJS.Timeout | undefined;
        const cleanup = () => {
          if (force) clearTimeout(force);
          if (deadline) clearTimeout(deadline);
          child.off("exit", finish);
          child.off("close", finish);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          this.closedChildren.add(child);
          cleanup();
          resolve();
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        child.once("exit", finish);
        child.once("close", finish);
        // A timeout is not proof of exit. Retain the process and retry later.
        deadline = setTimeout(
          () => fail(new Error("Kernel process exit was not confirmed")),
          5_000,
        );
        try {
          if (this.deps.platform === "win32" && child.pid !== undefined)
            this.deps.killProcessTree(child.pid);
          else if (this.sandbox) killSandboxGroup(child.pid);
          else {
            child.kill("SIGTERM");
            if (!settled)
              force = setTimeout(() => {
                try {
                  child.kill("SIGKILL");
                } catch (error) {
                  fail(error);
                }
              }, 2_000);
          }
        } catch (error) {
          fail(error);
        }
      });
    }
    // Leader exit does not prove its background descendants have stopped.
    // Keep both the process-group identity and sandbox until retirement is
    // verified, including when stop() is triggered by a spontaneous exit.
    if (child && this.sandbox && this.deps.platform !== "win32")
      await retireSandboxGroup(child.pid);
    if (this.child === child) this.child = undefined;
    this.reader?.close();
    this.reader = undefined;
    if (this.rCodeFile) await rm(this.rCodeFile, { force: true });
    await this.sandbox?.cleanup();
    this.sandbox = undefined;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    const executable = this.executablePath();
    const args = this.options.language === "python" ? [PYTHON_BRIDGE] : [R_BRIDGE, this.rCodeFile!];
    if (this.rCodeFile) {
      await mkdir(join(metadataRoot(this.options.cwd), "runtime", "kernels"), { recursive: true });
      await writeFile(this.rCodeFile, "", "utf8");
    }
    if (signal?.aborted) throw kernelStartCancelledError();
    if (this.options.sandboxPolicy!.mode === "required") {
      if (this.options.language !== "python")
        throw new Error("Sandboxed R kernels have not passed platform acceptance");
      const prepared = await prepareSandbox(
        this.options.sandboxPolicy!,
        [executable, "-I", "-B", PYTHON_BRIDGE],
        [this.options.environment.prefix, PYTHON_BRIDGE],
        86_400,
        PYTHON_BRIDGE,
        undefined,
        {},
        this.options.sandboxPolicy!.owner
          ? { cwd: this.options.cwd, sessionId: this.options.sandboxPolicy!.owner }
          : undefined,
      );
      if (signal?.aborted || this.stopPromise) {
        await this.stopPromise?.catch(() => undefined);
        this.sandbox = prepared;
        throw kernelStartCancelledError();
      }
      this.sandbox = prepared;
    }
    // Native compatibility still needs safe OS loader settings (SystemRoot/PATH
    // on Windows). Keep credentials excluded rather than passing an empty base.
    const env =
      this.sandbox?.env ??
      this.deps.workspaceEnvironmentVariables(
        this.options.environment,
        toolEnvironment(process.env),
      );
    const child = this.deps.spawnProcess(
      this.sandbox ? process.execPath : executable,
      this.sandbox ? [launcherPath, this.sandbox.manifest] : args,
      {
        cwd: this.options.sandboxPolicy!.cwd,
        env,
        stdio: this.sandbox ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
        // A new process group lets Windows deliver CTRL_BREAK_EVENT (SIGBREAK)
        // to the kernel alone instead of terminating the whole tree.
        ...(this.sandbox || this.deps.platform === "win32" ? { detached: true } : {}),
      },
    );
    this.child = child;
    child.once("close", () => {
      this.closedChildren.add(child);
    });
    this.exited = false;
    const accountOutput = (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes <= MAX_KERNEL_OUTPUT_BYTES) return;
      for (const pending of this.pending.values())
        pending.reject(new Error("Kernel output exceeds 16 MiB cell limit"));
      this.pending.clear();
      void this.stop().catch(() => undefined);
    };
    child.stdout!.on("data", accountOutput);
    child.stderr?.on("data", accountOutput);
    this.reader = createInterface({ input: child.stdout! });
    this.reader.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).slice(-4096);
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
      if (this.sandbox && !this.stopPromise) void this.stop().catch(() => undefined);
    });
    if (signal?.aborted) throw kernelStartCancelledError();

    const health = await this.sendRequest(HEALTH_CHECK_CODE, undefined, 30_000);
    if (!health.ok)
      throw new Error(`Kernel health check failed: ${health.error ?? "unknown error"}`);
  }

  private executablePath(): string {
    const bin = this.deps.platform === "win32" ? "Scripts" : "bin";
    if (this.options.language === "python") {
      return environmentPythonExecutable(this.options.environment.prefix, this.deps.platform);
    }
    return join(
      this.options.environment.prefix,
      bin,
      this.deps.platform === "win32" ? "Rscript.exe" : "Rscript",
    );
  }

  private async perform(options: KernelExecuteOptions): Promise<KernelResult> {
    if (!this.child || this.exited) throw new Error("Kernel process is not running");
    return this.sendRequest(options.code, options.onEvent, options.timeoutMs);
  }

  private async sendRequest(
    code: string,
    onEvent: KernelExecuteOptions["onEvent"],
    timeoutMs: number,
  ): Promise<KernelResult> {
    const child = this.child;
    if (!child || child.exitCode !== null || this.exited)
      throw new Error("Kernel process is not running");
    const id = randomUUID();
    this.outputBytes = 0;
    let resolveResult!: (result: KernelResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<KernelResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.pending.set(id, {
      resolve: resolveResult,
      reject: rejectResult,
      onEvent,
      promise: result,
    });
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
      timer = setTimeout(
        () => reject(new KernelTimeoutError(`Cell execution timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
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
      if (this.sandbox) child.send("interrupt");
      else child.kill(this.interruptSignal());
    } catch {
      return null;
    }
    const grace = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("interrupt grace expired")), INTERRUPT_GRACE_MS),
    );
    try {
      const result = await Promise.race([
        pending.promise as unknown as Promise<KernelResult>,
        grace,
      ]);
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
        pending.onEvent?.({
          type: "stream",
          stream: message.stream === "stderr" ? "stderr" : "stdout",
          text: message.text,
        });
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
  const outputs = Array.isArray(message.outputs)
    ? message.outputs.flatMap((value): KernelOutput[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const output = value as Record<string, unknown>;
        if (
          typeof output.output_type !== "string" ||
          !output.data ||
          typeof output.data !== "object" ||
          Array.isArray(output.data)
        )
          return [];
        const data: Record<string, string> = {};
        for (const [key, item] of Object.entries(output.data as Record<string, unknown>)) {
          if (typeof item === "string") data[key] = item;
        }
        return [{ output_type: output.output_type, data }];
      })
    : [];
  return {
    ok: message.ok === true,
    stdout: typeof message.stdout === "string" ? message.stdout : "",
    stderr: typeof message.stderr === "string" ? message.stderr : "",
    result: message.result === null || message.result === undefined ? null : String(message.result),
    error: message.error === null || message.error === undefined ? null : String(message.error),
    interrupted: message.interrupted === true,
    mime:
      message.mime !== null && typeof message.mime === "object" && !Array.isArray(message.mime)
        ? (message.mime as Record<string, string>)
        : {},
    outputs,
  };
}
