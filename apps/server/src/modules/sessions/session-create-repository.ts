/** Durable map from a caller's create idempotency key to the session that the
 *  first attempt created. A per-key file lock serializes the lookup-create-
 *  remember window across requests and server processes, so a page that
 *  replays `POST /api/sessions` adopts the first session instead of starting a
 *  second runtime and worker. */
import { createHash } from "node:crypto";
import {
  appendJsonLineUnlocked,
  readJsonLines,
  withFileWriteLock,
  workspaceFile,
} from "../../storage/persistence.js";

export const SESSION_CREATE_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const RECORDS_FILE = "session-creates.jsonl";

interface SessionCreateRecord {
  idempotency_key: string;
  session_id: string;
  created_at: string;
}

function keyLockFile(cwd: string, key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return workspaceFile(cwd, `session-creates/${digest}`);
}

export class SessionCreateRepository {
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SESSION_CREATE_RECORD_TTL_MS,
  ) {}

  /** Serialize one key's lookup-create-remember window; different keys do not block each other. */
  async withKeyLock<T>(cwd: string, key: string, operation: () => Promise<T>): Promise<T> {
    return withFileWriteLock(keyLockFile(cwd, key), operation);
  }

  /** Latest unique session for a live key, or null once the key expired. */
  async find(cwd: string, key: string): Promise<string | null> {
    const records = await readJsonLines<SessionCreateRecord>(workspaceFile(cwd, RECORDS_FILE));
    const cutoff = this.now() - this.ttlMs;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (!record || record.idempotency_key !== key) continue;
      if (Date.parse(record.created_at) >= cutoff) return record.session_id;
    }
    return null;
  }

  async remember(cwd: string, key: string, sessionId: string): Promise<void> {
    await appendJsonLineUnlocked(workspaceFile(cwd, RECORDS_FILE), {
      idempotency_key: key,
      session_id: sessionId,
      created_at: new Date(this.now()).toISOString(),
    } satisfies SessionCreateRecord);
  }
}
