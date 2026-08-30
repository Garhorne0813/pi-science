export type SqliteErrorCode =
  | "SQLITE_BUSY"
  | "SQLITE_CORRUPT"
  | "SQLITE_FULL"
  | "SQLITE_TIMEOUT"
  | "SQLITE_WORKER"
  | "SQLITE_NOT_READY"
  | "SQLITE_CLOSED"
  | "SQLITE_MIGRATION"
  | "SQLITE_EXPECT_CHANGES"
  | "SQLITE_UNKNOWN";

export class SqliteStateError extends Error {
  readonly code: SqliteErrorCode;
  readonly cause?: unknown;

  constructor(message: string, code: SqliteErrorCode = "SQLITE_UNKNOWN", cause?: unknown) {
    super(message, { cause });
    this.name = "SqliteStateError";
    this.code = code;
    this.cause = cause;
  }
}

export function classifySqliteError(error: unknown): SqliteErrorCode {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  const message = typeof value?.message === "string" ? value.message.toUpperCase() : String(error).toUpperCase();
  if (code.includes("BUSY") || message.includes("SQLITE_BUSY") || message.includes("DATABASE IS LOCKED")) return "SQLITE_BUSY";
  if (code.includes("CORRUPT") || message.includes("SQLITE_CORRUPT") || message.includes("MALFORMED")) return "SQLITE_CORRUPT";
  if (code.includes("FULL") || message.includes("SQLITE_FULL") || message.includes("DISK FULL")) return "SQLITE_FULL";
  if (code === "SQLITE_EXPECT_CHANGES") return "SQLITE_EXPECT_CHANGES";
  return "SQLITE_UNKNOWN";
}

export function errorFromWorker(value: { name?: string; message?: string; code?: string; stack?: string }): SqliteStateError {
  const error = new SqliteStateError(value.message ?? "SQLite worker request failed", isSqliteErrorCode(value.code) ? value.code : "SQLITE_WORKER");
  error.name = value.name ?? "SqliteWorkerError";
  if (value.stack) error.stack = value.stack;
  return error;
}

function isSqliteErrorCode(value: string | undefined): value is SqliteErrorCode {
  return value === "SQLITE_BUSY"
    || value === "SQLITE_CORRUPT"
    || value === "SQLITE_FULL"
    || value === "SQLITE_TIMEOUT"
    || value === "SQLITE_WORKER"
    || value === "SQLITE_NOT_READY"
    || value === "SQLITE_CLOSED"
    || value === "SQLITE_MIGRATION"
    || value === "SQLITE_EXPECT_CHANGES"
    || value === "SQLITE_UNKNOWN";
}
