import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { Migration, SqlStatement, SqliteErrorResponse, SqliteRequest, SqliteResponse } from "./protocol.js";

if (!parentPort) throw new Error("SQLite worker requires a parent port");
const port = parentPort;

const databasePath = String((workerData as { databasePath?: unknown } | undefined)?.databasePath ?? "");
if (!databasePath) throw new Error("SQLite worker database path is missing");

const database = new DatabaseSync(databasePath, { timeout: 5_000, allowExtension: false });
database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA temp_store = MEMORY;");
const journalMode = String((database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined)?.journal_mode ?? "unknown").toLowerCase();
port.postMessage({ type: "ready", journalMode });

let closing = false;

port.on("message", (request: SqliteRequest) => {
  if (closing && request.type !== "close") {
    respondError(request.id, new Error("SQLite worker is closing"), "SQLITE_CLOSED");
    return;
  }
  try {
    switch (request.type) {
      case "get": {
        const value = database.prepare(request.sql).get(...request.params);
        respond(request.id, value ?? null);
        break;
      }
      case "all":
        respond(request.id, database.prepare(request.sql).all(...request.params));
        break;
      case "run":
        respond(request.id, database.prepare(request.sql).run(...request.params));
        break;
      case "batch":
        respond(request.id, runBatch(request.statements));
        break;
      case "migrate":
        respond(request.id, runMigrations(request.migrations));
        break;
      case "checkpoint":
        respond(request.id, database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all());
        break;
      case "close":
        closing = true;
        database.close();
        respond(request.id, null);
        port.close();
        break;
    }
  } catch (error) {
    respondError(request.id, error);
  }
});

function runBatch(statements: SqlStatement[]) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const results = statements.map((statement) => database.prepare(statement.sql).run(...(statement.params ?? [])));
    database.exec("COMMIT");
    return results;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function runMigrations(migrations: Migration[]) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
  const applied = database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; checksum: string }>;
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  for (const row of applied) {
    const migration = migrations.find((item) => item.version === row.version);
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`SQLite migration checksum mismatch at version ${row.version} (${row.name})`);
    }
  }
  const latestApplied = applied.at(-1)?.version ?? 0;
  const latestSupported = migrations.at(-1)?.version ?? 0;
  if (latestApplied > latestSupported) throw new Error(`SQLite database schema version ${latestApplied} is newer than supported version ${latestSupported}`);
  const pending = migrations.filter((migration) => !appliedByVersion.has(migration.version));
  for (const migration of pending) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migration.checksum, Date.now());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }
  return { schemaVersion: migrations.at(-1)?.version ?? latestApplied, journalMode };
}

function respond(id: number, value: unknown): void {
  const message: SqliteResponse = { type: "response", id, ok: true, value };
  port.postMessage(message);
}

function respondError(id: number, error: unknown, forcedCode?: string): void {
  const value = error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  const message: SqliteErrorResponse = {
    type: "response",
    id,
    ok: false,
    error: {
      name: typeof value?.name === "string" ? value.name : "SqliteWorkerError",
      message: typeof value?.message === "string" ? value.message : String(error),
      ...(forcedCode || typeof value?.code === "string" ? { code: forcedCode ?? String(value.code) } : {}),
      ...(typeof value?.stack === "string" ? { stack: value.stack } : {}),
    },
  };
  port.postMessage(message);
}
