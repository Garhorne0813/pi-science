import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { appendJsonLineUnlocked, readJson, readJsonLines, withFileWriteLock, writeJsonAtomic, workspaceFile } from "../../storage/persistence.js";
import type { SessionRepository } from "./session-repository.js";

export type PromptRequestState = "pending" | "accepted" | "persisted" | "rejected" | "indeterminate";

export interface PromptRequestStatus {
  status: PromptRequestState;
  client_message_id: string;
  durable_message_id?: string;
  error_code?: string;
}

interface PromptRequestRecord {
  session_id: string;
  client_message_id: string;
  content_sha256: string;
  status: PromptRequestState;
  updated_at: string;
  server_instance_id: string;
  durable_message_id?: string;
  error_code?: string;
}

interface PromptAssociationMarker {
  version: 1;
  session_id: string;
  client_message_id: string;
}

export type PreparePromptResult =
  | { dispatch: true; status: PromptRequestStatus }
  | { dispatch: false; status: PromptRequestStatus }
  | { busy: true; blocking_client_message_id: string }
  | { conflict: true };

const SERVER_INSTANCE_ID = randomUUID();

function requestFile(cwd: string): string {
  return workspaceFile(cwd, "prompt-requests.jsonl");
}

/** Must stay in sync with the Pi runtime extension's marker path. The hashed
 *  session component prevents path traversal and keeps identifiers out of
 *  filesystem names. */
export function promptAssociationPath(cwd: string, sessionId: string): string {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  return workspaceFile(cwd, `prompt-associations/${sessionKey}.json`);
}

function digestMessage(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

function latestRecord(records: PromptRequestRecord[], sessionId: string, clientMessageId: string): PromptRequestRecord | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const row = records[i];
    if (row?.session_id === sessionId && row.client_message_id === clientMessageId) return row;
  }
  return undefined;
}

function asStatus(record: PromptRequestRecord): PromptRequestStatus {
  return {
    status: record.status,
    client_message_id: record.client_message_id,
    ...(record.durable_message_id ? { durable_message_id: record.durable_message_id } : {}),
    ...(record.error_code ? { error_code: record.error_code } : {}),
  };
}

/** Durable idempotency ledger for a workspace. It stores only the content
 *  digest and delivery metadata; prompt text stays in Pi's normal transcript. */
export class PromptRequestRepository {
  constructor(
    private readonly sessions: Pick<SessionRepository, "messages">,
    private readonly serverInstanceId: string = SERVER_INSTANCE_ID,
  ) {}

  /** Serialize the sidecar association and Pi preflight for one session across
   *  server processes. Pi RPC acknowledges prompt preflight after the extension
   *  consumes the marker, so releasing here prevents a later request from
   *  replacing an association before that exact prompt reaches Pi. */
  async withSessionMutationLock<T>(cwd: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
    const sessionKey = createHash("sha256").update(sessionId).digest("hex");
    return withFileWriteLock(workspaceFile(cwd, `prompt-mutations/${sessionKey}`), operation);
  }

  async prepare(cwd: string, sessionId: string, clientMessageId: string, message: string): Promise<PreparePromptResult> {
    const file = requestFile(cwd);
    const contentSha256 = digestMessage(message);
    return withFileWriteLock(file, async () => {
      const records = await readJsonLines<PromptRequestRecord>(file);
      let prior = latestRecord(records, sessionId, clientMessageId);
      if (prior && prior.content_sha256 !== contentSha256) return { conflict: true };

      if (prior?.status === "persisted") return { dispatch: false, status: asStatus(prior) };
      if (prior && prior.status !== "rejected") {
        if (prior.server_instance_id !== this.serverInstanceId && prior.status !== "indeterminate") {
          prior = await this.appendState(file, prior, "indeterminate", { error_code: "server_restarted_before_confirmation" });
        }
        return { dispatch: false, status: asStatus(prior) };
      }

      // A different unresolved ID may still have a Pi prompt in preflight or
      // in flight. Never replace its marker or dispatch around it. First
      // reconcile against authoritative message metadata so a completed write
      // does not unnecessarily block the next prompt.
      const latestForSession = new Map<string, PromptRequestRecord>();
      for (const row of records) {
        if (row.session_id === sessionId) latestForSession.set(row.client_message_id, row);
      }
      for (const other of latestForSession.values()) {
        if (other.client_message_id === clientMessageId || !["pending", "accepted", "indeterminate"].includes(other.status)) continue;
        const matches = (await this.sessions.messages(cwd, sessionId))
          .filter((message) => message.role === "user" && message.client_message_id === other.client_message_id);
        if (matches.length === 1) {
          await this.appendState(file, other, "persisted", { durable_message_id: matches[0]!.id });
          continue;
        }
        if (matches.length > 1 && other.status !== "indeterminate") {
          await this.appendState(file, other, "indeterminate", { error_code: "multiple_durable_messages" });
        } else if (other.server_instance_id !== this.serverInstanceId && other.status !== "indeterminate") {
          await this.appendState(file, other, "indeterminate", { error_code: "server_restarted_before_confirmation" });
        }
        return { busy: true, blocking_client_message_id: other.client_message_id };
      }

      const pending = this.newRecord(sessionId, clientMessageId, contentSha256, "pending");
      // Write intent first. If the process dies before the sidecar or before
      // Pi accepts the operation, a retry sees an unresolved ID and will not
      // issue a duplicate prompt.
      await appendJsonLineUnlocked(file, pending);
      try {
        await writeJsonAtomic(promptAssociationPath(cwd, sessionId), {
          version: 1,
          session_id: sessionId,
          client_message_id: clientMessageId,
        } satisfies PromptAssociationMarker);
      } catch {
        const rejected = await this.appendState(file, pending, "rejected", { error_code: "association_marker_write_failed" });
        return { dispatch: false, status: asStatus(rejected) };
      }
      return { dispatch: true, status: asStatus(pending) };
    });
  }

  async update(
    cwd: string,
    sessionId: string,
    clientMessageId: string,
    status: PromptRequestState,
    details: { durable_message_id?: string; error_code?: string } = {},
  ): Promise<PromptRequestStatus | null> {
    const file = requestFile(cwd);
    return withFileWriteLock(file, async () => {
      const records = await readJsonLines<PromptRequestRecord>(file);
      const prior = latestRecord(records, sessionId, clientMessageId);
      if (!prior) return null;
      if (prior.status === "persisted") return asStatus(prior);
      const updated = await this.appendState(file, prior, status, details);
      return asStatus(updated);
    });
  }

  /** Remove only this request's unused marker. Comparing under the request
   *  ledger lock prevents an old rejected command from clearing a newer send. */
  async clearAssociation(cwd: string, sessionId: string, clientMessageId: string): Promise<void> {
    const file = requestFile(cwd);
    await withFileWriteLock(file, async () => {
      const markerPath = promptAssociationPath(cwd, sessionId);
      const marker = await readJson<PromptAssociationMarker | null>(markerPath, null);
      if (marker?.session_id === sessionId && marker.client_message_id === clientMessageId) {
        await unlink(markerPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    });
  }

  async getStatus(cwd: string, sessionId: string, clientMessageId: string): Promise<PromptRequestStatus | null> {
    const file = requestFile(cwd);
    const records = await readJsonLines<PromptRequestRecord>(file);
    let record = latestRecord(records, sessionId, clientMessageId);
    if (!record) return null;

    // The durable message is the authority. Recover the mapping even if Pi
    // wrote the message and either process died before recording confirmation.
    const matches = (await this.sessions.messages(cwd, sessionId))
      .filter((message) => message.role === "user" && message.client_message_id === clientMessageId);
    if (matches.length === 1) {
      const persisted = await this.update(cwd, sessionId, clientMessageId, "persisted", { durable_message_id: matches[0]!.id });
      return persisted;
    }
    if (matches.length > 1) {
      const indeterminate = await this.update(cwd, sessionId, clientMessageId, "indeterminate", { error_code: "multiple_durable_messages" });
      return indeterminate;
    }

    if (record.server_instance_id !== this.serverInstanceId && record.status !== "persisted" && record.status !== "rejected" && record.status !== "indeterminate") {
      const indeterminate = await this.update(cwd, sessionId, clientMessageId, "indeterminate", { error_code: "server_restarted_before_confirmation" });
      return indeterminate;
    }
    return asStatus(record);
  }

  private newRecord(
    sessionId: string,
    clientMessageId: string,
    contentSha256: string,
    status: PromptRequestState,
  ): PromptRequestRecord {
    return {
      session_id: sessionId,
      client_message_id: clientMessageId,
      content_sha256: contentSha256,
      status,
      updated_at: new Date().toISOString(),
      server_instance_id: this.serverInstanceId,
    };
  }

  private async appendState(
    file: string,
    prior: PromptRequestRecord,
    status: PromptRequestState,
    details: { durable_message_id?: string; error_code?: string },
  ): Promise<PromptRequestRecord> {
    const next: PromptRequestRecord = {
      ...prior,
      ...details,
      status,
      updated_at: new Date().toISOString(),
      server_instance_id: this.serverInstanceId,
    };
    if (!details.durable_message_id) delete next.durable_message_id;
    if (!details.error_code) delete next.error_code;
    await appendJsonLineUnlocked(file, next);
    return next;
  }
}
