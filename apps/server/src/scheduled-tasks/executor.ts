// Executor abstraction for scheduled tasks (docs §6 architecture: the
// dispatcher runs executors outside any SQLite transaction; the scheduler never
// awaits them). Phase 4 ships only the contract, a test FakeExecutor and the
// registry; the production LiteratureDigestExecutor registers in Phase 5.
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunAttempt,
} from "./types.js";
import type { ScheduledTaskExecutor as ScheduledTaskExecutorConfig, ScheduledTaskRunOutcome, ScheduledTaskRunSummary } from "@pi-science/contracts";

export interface ExecutorContext {
  task: ScheduledTask;
  run: ScheduledTaskRun;
  attempt: ScheduledTaskRunAttempt;
  workspacePath: string;
  cwd: string;
  signal: AbortSignal;
  now(): number;
  log: (message: string, details?: Record<string, unknown>) => void;
}

export interface ExecutorResult {
  status: "succeeded" | "failed" | "timed_out";
  retryable?: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  outputPaths?: string[];
  usage?: Record<string, unknown>;
  outcome?: ScheduledTaskRunOutcome;
  summary?: ScheduledTaskRunSummary;
  recommendNotify?: boolean;
}

/** Runtime executor for one attempt. Named after docs §6 `LiteratureDigestExecutor`;
 * distinct from the wire-level executor config in @pi-science/contracts. */
export interface ScheduledTaskExecutor {
  readonly kind: ScheduledTaskExecutorConfig["kind"];
  execute(ctx: ExecutorContext): Promise<ExecutorResult>;
}

export interface FakeExecutorOptions {
  /** Fixed result returned by every execution. */
  result?: ExecutorResult;
  /** Resolve only once this abort signal fires (simulates a hung Pi runtime). */
  hangUntilAbort?: boolean;
  /** Artificial execution delay in milliseconds (test-injectable; never a real long sleep). */
  delayMs?: number;
  /** Throw instead of resolving; `retryable` classifies the failure for backoff. */
  throwAfterAttempts?: number;
  thrownError?: Error;
  /** Observability hooks for tests. */
  onExecute?: (ctx: ExecutorContext) => void;
  onAborted?: (ctx: ExecutorContext) => void;
}

/** Deterministic test double: injectable delay/result/failure counting
 * (docs §14.2 Timer/Attempt rows). Not registered in production. */
export class FakeExecutor implements ScheduledTaskExecutor {
  readonly kind = "literature_digest" as const;
  readonly calls: ExecutorContext[] = [];

  constructor(private readonly options: FakeExecutorOptions = {}) {}

  async execute(ctx: ExecutorContext): Promise<ExecutorResult> {
    this.calls.push(ctx);
    this.options.onExecute?.(ctx);
    if (this.options.delayMs && this.options.delayMs > 0) await sleep(ctx.signal, this.options.delayMs);
    if (ctx.signal.aborted) {
      this.options.onAborted?.(ctx);
      return { status: "failed", retryable: false, errorCode: "ABORTED", errorMessage: "execution aborted before completion" };
    }
    if (this.options.throwAfterAttempts !== undefined && this.calls.length <= this.options.throwAfterAttempts) {
      throw this.options.thrownError ?? new Error("fake executor failure");
    }
    if (this.options.hangUntilAbort) {
      await new Promise<never>((_, reject) => {
        ctx.signal.addEventListener("abort", () => {
          this.options.onAborted?.(ctx);
          reject(abortError());
        }, { once: true });
      });
    }
    return this.options.result ?? { status: "succeeded", outputPaths: [], usage: {} };
  }
}

function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    const timer = setTimeout(() => resolveSleep(), ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      rejectSleep(abortError());
    }, { once: true });
  });
}

/** Sentinel used to unwind hung executions when the dispatcher aborts them. */
export function abortError(): Error {
  const error = new Error("executor aborted");
  (error as Error & { retryable?: boolean }).retryable = false;
  error.name = "AbortError";
  return error;
}

/** Registry keyed by executor kind (docs §11.1 module graph position between
 * LiteratureDigestExecutor and the dispatcher). v1 registers only the fake for
 * internal testing; Phase 5 wires the production literature_digest executor. */
export class ExecutorRegistry {
  private readonly executors = new Map<string, ScheduledTaskExecutor>();

  register(executor: ScheduledTaskExecutor): void {
    this.executors.set(executor.kind, executor);
  }

  get(kind: string): ScheduledTaskExecutor | undefined {
    return this.executors.get(kind);
  }
}
