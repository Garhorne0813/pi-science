export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export type SqliteRequest =
  | { id: number; type: "get"; sql: string; params: SqlValue[] }
  | { id: number; type: "all"; sql: string; params: SqlValue[] }
  | { id: number; type: "run"; sql: string; params: SqlValue[] }
  | { id: number; type: "batch"; statements: SqlStatement[] }
  | { id: number; type: "migrate"; migrations: Migration[] }
  | { id: number; type: "checkpoint" }
  | { id: number; type: "close" };

export type SqliteRequestInput =
  | Omit<Extract<SqliteRequest, { type: "get" }>, "id">
  | Omit<Extract<SqliteRequest, { type: "all" }>, "id">
  | Omit<Extract<SqliteRequest, { type: "run" }>, "id">
  | Omit<Extract<SqliteRequest, { type: "batch" }>, "id">
  | Omit<Extract<SqliteRequest, { type: "migrate" }>, "id">
  | Omit<Extract<SqliteRequest, { type: "checkpoint" }>, "id">
  | Omit<Extract<SqliteRequest, { type: "close" }>, "id">;

export interface SqliteReadyMessage {
  type: "ready";
  journalMode: string;
}

export interface SqliteResponse {
  type: "response";
  id: number;
  ok: true;
  value: unknown;
}

export interface SqliteErrorResponse {
  type: "response";
  id: number;
  ok: false;
  error: { name: string; message: string; code?: string; stack?: string };
}

export type SqliteWorkerMessage = SqliteReadyMessage | SqliteResponse | SqliteErrorResponse;
