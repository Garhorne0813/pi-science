import { createHash } from "node:crypto";
import { join } from "node:path";
import type { QueuedMessage, SessionQueue } from "@pi-science/contracts";
import {
  readJson,
  withFileWriteLock,
  workspaceFile,
  writeJsonAtomic,
} from "../../storage/persistence.js";

/** Terminal entries stay readable after they settle so a refresh still shows
 *  what happened, but the document must not grow without bound. */
const TERMINAL_ENTRY_LIMIT = 20;
const TERMINAL_STATUSES = new Set<QueuedMessage["status"]>(["dispatched", "cancelled"]);

export type QueueEditResult =
  | { ok: true; entry: QueuedMessage }
  | { ok: false; code: "not_found" | "not_editable" };

export type QueueEnqueueResult =
  | { ok: true; created: boolean; entry: QueuedMessage }
  | { ok: false; code: "conflict" };

export type DispatchOutcome =
  | { status: "dispatched"; delivered_message_id?: string }
  | { status: "failed"; error_code: string }
  | { status: "queued"; error_code?: string };

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function emptyQueue(sessionId: string): SessionQueue {
  return {
    session_id: sessionId,
    paused: false,
    entries: [],
    updated_at: new Date().toISOString(),
  };
}

function trim(doc: SessionQueue): SessionQueue {
  const terminal = doc.entries.filter((entry) => TERMINAL_STATUSES.has(entry.status));
  if (terminal.length <= TERMINAL_ENTRY_LIMIT) return doc;
  const drop = new Set(
    terminal.slice(0, terminal.length - TERMINAL_ENTRY_LIMIT).map((entry) => entry.id),
  );
  return { ...doc, entries: doc.entries.filter((entry) => !drop.has(entry.id)) };
}

/** Durable follow-up queue for one session. Every mutation runs under the
 *  workspace file lock and rewrites the document atomically, so a crash leaves
 *  either the previous state or the next one, never a half-written queue. */
export class SessionQueueRepository {
  file(cwd: string, sessionId: string): string {
    return workspaceFile(cwd, join("session-queue", `${sessionKey(sessionId)}.json`));
  }

  async read(cwd: string, sessionId: string): Promise<SessionQueue> {
    const stored = await readJson<SessionQueue | null>(this.file(cwd, sessionId), null);
    if (!stored || stored.session_id !== sessionId || !Array.isArray(stored.entries))
      return emptyQueue(sessionId);
    return trim({ ...stored, paused: stored.paused === true });
  }

  async enqueue(
    cwd: string,
    sessionId: string,
    input: { id: string; text: string },
  ): Promise<QueueEnqueueResult> {
    const file = this.file(cwd, sessionId);
    return withFileWriteLock(file, async () => {
      const doc = await this.readLocked(file, sessionId);
      const existing = doc.entries.find((entry) => entry.id === input.id);
      if (existing) {
        // Replaying the same request ID is safe only with the same content; a
        // different body under a used ID is a client bug, not a new message.
        return existing.text === input.text
          ? { ok: true, created: false, entry: existing }
          : { ok: false, code: "conflict" };
      }
      const now = new Date().toISOString();
      const entry: QueuedMessage = {
        id: input.id,
        text: input.text,
        status: "queued",
        created_at: now,
        updated_at: now,
      };
      await writeJsonAtomic(
        file,
        trim({ ...doc, entries: [...doc.entries, entry], updated_at: now }),
      );
      return { ok: true, created: true, entry };
    });
  }

  async edit(
    cwd: string,
    sessionId: string,
    entryId: string,
    text: string,
  ): Promise<QueueEditResult> {
    const file = this.file(cwd, sessionId);
    return withFileWriteLock(file, async () => {
      const doc = await this.readLocked(file, sessionId);
      const entry = doc.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return { ok: false, code: "not_found" };
      if (entry.status !== "queued") return { ok: false, code: "not_editable" };
      const updated: QueuedMessage = { ...entry, text, updated_at: new Date().toISOString() };
      await this.replace(file, doc, updated);
      return { ok: true, entry: updated };
    });
  }

  async cancel(cwd: string, sessionId: string, entryId: string): Promise<QueueEditResult> {
    const file = this.file(cwd, sessionId);
    return withFileWriteLock(file, async () => {
      const doc = await this.readLocked(file, sessionId);
      const entry = doc.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return { ok: false, code: "not_found" };
      if (entry.status === "cancelled") return { ok: true, entry };
      // A dispatched or dispatching entry belongs to a turn that may already be
      // running; the queue cannot retract it, so do not pretend otherwise.
      if (entry.status !== "queued" && entry.status !== "failed")
        return { ok: false, code: "not_editable" };
      const updated: QueuedMessage = {
        ...entry,
        status: "cancelled",
        error_code: undefined,
        updated_at: new Date().toISOString(),
      };
      await this.replace(file, doc, updated);
      return { ok: true, entry: updated };
    });
  }

  /** Claim the head of the queue for dispatch. The `dispatching` write lands
   *  before the agent command, so a crash mid-dispatch is visible afterwards. */
  async claimNext(cwd: string, sessionId: string): Promise<QueuedMessage | null> {
    const file = this.file(cwd, sessionId);
    return withFileWriteLock(file, async () => {
      const doc = await this.readLocked(file, sessionId);
      if (doc.paused) return null;
      const entry = doc.entries.find((candidate) => candidate.status === "queued");
      if (!entry) return null;
      const claimed: QueuedMessage = {
        ...entry,
        status: "dispatching",
        updated_at: new Date().toISOString(),
      };
      await this.replace(file, doc, claimed);
      return claimed;
    });
  }

  async settle(
    cwd: string,
    sessionId: string,
    entryId: string,
    outcome: DispatchOutcome,
  ): Promise<QueuedMessage | null> {
    const file = this.file(cwd, sessionId);
    return withFileWriteLock(file, async () => {
      const doc = await this.readLocked(file, sessionId);
      const entry = doc.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return null;
      const updated: QueuedMessage = {
        ...entry,
        status: outcome.status,
        updated_at: new Date().toISOString(),
        ...(outcome.status === "dispatched" && outcome.delivered_message_id
          ? { delivered_message_id: outcome.delivered_message_id }
          : {}),
        ...("error_code" in outcome && outcome.error_code
          ? { error_code: outcome.error_code }
          : {}),
      };
      if (!("error_code" in outcome) || !outcome.error_code) delete updated.error_code;
      if (outcome.status !== "dispatched") delete updated.delivered_message_id;
      await this.replace(file, doc, updated);
      return updated;
    });
  }

  /** Stop pauses the queue only when there is something left to protect. */
  async pauseAfterStop(cwd: string, sessionId: string): Promise<SessionQueue | null> {
    const file = this.file(cwd, sessionId);
    return withFileWriteLock(file, async () => {
      const doc = await this.readLocked(file, sessionId);
      if (!doc.entries.some((entry) => entry.status === "queued")) return null;
      if (doc.paused) return doc;
      const paused: SessionQueue = {
        ...doc,
        paused: true,
        paused_reason: "stop",
        updated_at: new Date().toISOString(),
      };
      await writeJsonAtomic(file, paused);
      return paused;
    });
  }

  async resume(cwd: string, sessionId: string): Promise<SessionQueue> {
    const file = this.file(cwd, sessionId);
    return withFileWriteLock(file, async () => {
      const doc = await this.readLocked(file, sessionId);
      const resumed: SessionQueue = {
        ...doc,
        paused: false,
        paused_reason: undefined,
        updated_at: new Date().toISOString(),
      };
      delete resumed.paused_reason;
      await writeJsonAtomic(file, resumed);
      return resumed;
    });
  }

  private async readLocked(file: string, sessionId: string): Promise<SessionQueue> {
    const stored = await readJson<SessionQueue | null>(file, null);
    if (!stored || stored.session_id !== sessionId || !Array.isArray(stored.entries))
      return emptyQueue(sessionId);
    return trim({ ...stored, paused: stored.paused === true });
  }

  private async replace(file: string, doc: SessionQueue, entry: QueuedMessage): Promise<void> {
    await writeJsonAtomic(file, {
      ...doc,
      entries: doc.entries.map((candidate) => (candidate.id === entry.id ? entry : candidate)),
      updated_at: entry.updated_at,
    });
  }
}
