import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { errorFromWorker, classifySqliteError, SqliteStateError } from "./errors.js";
import { loadMigrations, validateMigrations } from "./migrations.js";
import type { Migration, SqlRunResult, SqlStatement, SqlValue, SqliteRequest, SqliteRequestInput, SqliteWorkerMessage } from "./protocol.js";

export interface SqliteStateStoreOptions {
  path: string;
  migrations?: Migration[];
  queryTimeoutMs?: number;
  migrationTimeoutMs?: number;
  workerPath?: URL | string;
  logger?: (level: "debug" | "warn" | "error", message: string, details?: Record<string, unknown>) => void;
}

export interface SqliteDiagnostics {
  status: "starting" | "ready" | "failed" | "closing" | "closed";
  schema_version: number | null;
  journal_mode: string | null;
  pending_requests: number;
  error?: string;
  error_code?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  type: SqliteRequest["type"];
}

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_MIGRATION_TIMEOUT_MS = 5 * 60_000;

export class SqliteStateStore {
  private readonly queryTimeoutMs: number;
  private readonly migrationTimeoutMs: number;
  private readonly logger?: SqliteStateStoreOptions["logger"];
  private readonly migrations?: Migration[];
  private readonly workerPath?: URL | string;
  private worker?: Worker;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private state: SqliteDiagnostics["status"] = "closed";
  private schemaVersion: number | null = null;
  private journalMode: string | null = null;
  private failure?: SqliteStateError;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(private readonly options: SqliteStateStoreOptions) {
    this.queryTimeoutMs = Math.max(1, options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    this.migrationTimeoutMs = Math.max(1, options.migrationTimeoutMs ?? DEFAULT_MIGRATION_TIMEOUT_MS);
    this.logger = options.logger;
    this.migrations = options.migrations;
    this.workerPath = options.workerPath;
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.startPromise) return this.startPromise;
    if (this.state === "failed") throw this.failure;
    this.startPromise = this.startWorker().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  async get<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return this.request<T | null>({ type: "get", sql, params });
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.request<T[]>({ type: "all", sql, params });
  }

  async run(sql: string, params: SqlValue[] = []): Promise<SqlRunResult> {
    return this.request<SqlRunResult>({ type: "run", sql, params });
  }

  async batch(statements: SqlStatement[]): Promise<SqlRunResult[]> {
    return this.request<SqlRunResult[]>({ type: "batch", statements });
  }

  async close(): Promise<void> {
    if (!this.worker || this.state === "closed") {
      this.state = "closed";
      return;
    }
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeWorker().finally(() => { this.closePromise = undefined; });
    return this.closePromise;
  }

  diagnostics(): SqliteDiagnostics {
    return {
      status: this.state,
      schema_version: this.schemaVersion,
      journal_mode: this.journalMode,
      pending_requests: this.pending.size,
      ...(this.failure ? { error: this.failure.message, error_code: this.failure.code } : {}),
    };
  }

  private async startWorker(): Promise<void> {
    this.state = "starting";
    this.failure = undefined;
    const worker = new Worker(this.resolveWorkerPath(), {
      workerData: { databasePath: this.options.path },
      execArgv: this.workerExecArgv(),
    });
    this.worker = worker;
    worker.on("message", (message: SqliteWorkerMessage) => this.handleMessage(message));
    worker.on("error", (error) => this.handleWorkerFailure(error));
    worker.on("exit", (code) => {
      if (this.state === "closing" || this.state === "closed") return;
      if (code !== 0 || this.state === "ready" || this.state === "starting") this.handleWorkerFailure(new Error(`SQLite worker exited with code ${code}`));
    });

    await new Promise<void>((resolve, reject) => {
      const onReady = (message: SqliteWorkerMessage) => {
        if (message.type !== "ready") return;
        cleanup();
        this.journalMode = message.journalMode;
        resolve();
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { worker.off("message", onReady); worker.off("error", onError); };
      worker.on("message", onReady);
      worker.on("error", onError);
    });

    try {
      const migrations = this.migrations ?? await loadMigrations();
      validateMigrations(migrations);
      const result = await this.request<{ schemaVersion: number; journalMode: string }>({ type: "migrate", migrations }, this.migrationTimeoutMs);
      this.schemaVersion = result.schemaVersion;
      this.journalMode = result.journalMode;
      this.state = "ready";
    } catch (error) {
      const wrapped = error instanceof SqliteStateError ? error : new SqliteStateError(String(error), "SQLITE_MIGRATION", error);
      this.handleWorkerFailure(wrapped);
      throw wrapped;
    }
  }

  private async closeWorker(): Promise<void> {
    this.state = "closing";
    try {
      await this.request({ type: "checkpoint" });
      await this.request({ type: "close" });
    } catch (error) {
      this.logger?.("warn", "SQLite worker close failed", { error: String(error) });
    } finally {
      const worker = this.worker;
      this.worker = undefined;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new SqliteStateError("SQLite store closed", "SQLITE_CLOSED")); }
      this.pending.clear();
      if (worker) await worker.terminate();
      this.state = "closed";
    }
  }

  private request<T>(request: SqliteRequestInput, timeoutMs = this.queryTimeoutMs): Promise<T> {
    if (!this.worker || (this.state !== "ready" && this.state !== "starting" && this.state !== "closing")) {
      return Promise.reject(this.failure ?? new SqliteStateError("SQLite state store is not ready", this.state === "closed" ? "SQLITE_CLOSED" : "SQLITE_NOT_READY"));
    }
    const id = this.nextRequestId++;
    const message = { ...request, id } as SqliteRequest;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new SqliteStateError(`SQLite ${request.type} request timed out after ${timeoutMs}ms`, "SQLITE_TIMEOUT");
        this.handleWorkerFailure(error);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, type: request.type });
      try { this.worker!.postMessage(message); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private handleMessage(message: SqliteWorkerMessage): void {
    if (message.type === "ready") {
      this.journalMode = message.journalMode;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(errorFromWorker(message.error));
  }

  private handleWorkerFailure(error: unknown): void {
    if (this.state === "closed" || this.state === "closing") return;
    const classified = error instanceof SqliteStateError ? error : new SqliteStateError(String(error), classifySqliteError(error), error);
    this.failure = classified;
    this.state = "failed";
    this.logger?.("error", "SQLite worker failed", { code: classified.code, error: classified.message });
    const worker = this.worker;
    this.worker = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(classified); }
    this.pending.clear();
    void worker?.terminate();
  }

  private resolveWorkerPath(): URL | string {
    if (this.workerPath) return this.workerPath;
    const compiled = new URL("./sqlite-worker.js", import.meta.url);
    if (existsSync(fileURLToPath(compiled))) return compiled;
    return new URL("./sqlite-worker.ts", import.meta.url);
  }

  private isTypeScriptWorker(): boolean {
    const path = this.workerPath ?? this.resolveWorkerPath();
    return String(path).endsWith(".ts");
  }

  private workerExecArgv(): string[] {
    const args: string[] = [];
    for (let index = 0; index < process.execArgv.length; index += 1) {
      const value = process.execArgv[index]!;
      if (value === "--input-type") { index += 1; continue; }
      if (value.startsWith("--input-type=")) continue;
      args.push(value);
    }
    if (this.isTypeScriptWorker()) args.push("--import", "tsx/esm");
    return args;
  }
}

/** A worker-backed `:memory:` store for repository tests. */
export class InMemorySqliteStateStore extends SqliteStateStore {
  constructor(options: Omit<SqliteStateStoreOptions, "path"> = {}) {
    super({ ...options, path: ":memory:" });
  }
}
