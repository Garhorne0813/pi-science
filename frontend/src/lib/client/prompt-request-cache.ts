import type { PromptDeliveryState } from "./types";

// v2 stores the prompt text and moves to localStorage. A refresh between the
// keystroke and `POST /api/sessions/<id>/prompt` used to strand the message:
// sessionStorage lost it when the tab closed, and the v1 record carried only a
// digest, so a reload could not replay what the user had typed.
const KEY = "pi-science.pending-prompt-requests.v2";
// v1 records live in sessionStorage under this key; they never held the text.
const LEGACY_KEY = "pi-science.pending-prompt-requests.v1";
const SCHEMA_VERSION = 2;
const MAX_RECORDS = 30;

export interface LocalPromptRequest {
  cwd: string;
  sessionId: string;
  clientMessageId: string;
  contentDigest: string;
  text: string;
  createdAt: number;
  status: PromptDeliveryState;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

function legacyStorage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; }
  catch { return null; }
}

function isRecord(item: unknown): item is LocalPromptRequest {
  if (!item || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  // The version stamp is what makes a bad or older payload safe to discard: a
  // record without it is not interpreted, it is dropped.
  return record.schemaVersion === SCHEMA_VERSION
    && typeof record.cwd === "string"
    && typeof record.sessionId === "string"
    && typeof record.clientMessageId === "string"
    && typeof record.contentDigest === "string"
    && typeof record.text === "string"
    && typeof record.createdAt === "number"
    && ["pending", "accepted", "persisted", "rejected", "indeterminate"].includes(String(record.status));
}

function dropLegacy(): void {
  try { legacyStorage()?.removeItem(LEGACY_KEY); } catch { /* storage may be disabled */ }
}

function read(): LocalPromptRequest[] {
  try {
    dropLegacy();
    const raw = storage()?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).map((record) => {
      const { schemaVersion: _version, ...rest } = record as LocalPromptRequest & { schemaVersion?: number };
      return rest;
    });
  } catch { return []; }
}

function write(records: LocalPromptRequest[]): void {
  try {
    const stamped = records.slice(-MAX_RECORDS).map((record) => ({ ...record, schemaVersion: SCHEMA_VERSION }));
    storage()?.setItem(KEY, JSON.stringify(stamped));
  } catch { /* storage may be disabled; the active page still carries the ID */ }
}

export function promptContentDigest(message: string): string {
  const bytes = new TextEncoder().encode(message);
  // This digest is only a local lookup key. The server always checks the full
  // SHA-256 digest before accepting an ID reuse, so collisions fail closed.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193);
    second = Math.imul(second ^ byte, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

export function findLocalPromptRequest(cwd: string, sessionId: string, contentDigest: string): LocalPromptRequest | null {
  return read().reverse().find((record) => record.cwd === cwd && record.sessionId === sessionId && record.contentDigest === contentDigest) ?? null;
}

export function localPromptRequests(cwd: string, sessionId: string): LocalPromptRequest[] {
  return read().filter((record) => record.cwd === cwd && record.sessionId === sessionId && record.status !== "persisted");
}

/** Every unfinished request for a workspace, whatever session it was scoped
 *  to. The replay entry point uses it to find a prompt whose create round trip
 *  never finished (sessionId "") or whose prompt POST never landed. */
export function pendingPromptRequests(cwd: string): LocalPromptRequest[] {
  return read().filter((record) => record.cwd === cwd && record.status !== "persisted");
}

export function saveLocalPromptRequest(record: LocalPromptRequest): void {
  const records = read();
  const existing = records.find((item) => item.clientMessageId === record.clientMessageId);
  // A replay re-saves the same record; keep the original creation time so the
  // age guard measures the user's first attempt, not the replay.
  const next = existing ? { ...existing, ...record, createdAt: existing.createdAt } : record;
  write([...records.filter((item) => item.clientMessageId !== record.clientMessageId), next]);
}

export function updateLocalPromptRequest(
  clientMessageId: string,
  update: Partial<Pick<LocalPromptRequest, "cwd" | "sessionId" | "status">>,
): LocalPromptRequest | null {
  const records = read();
  const index = records.findIndex((item) => item.clientMessageId === clientMessageId);
  if (index < 0) return null;
  const updated = { ...records[index]!, ...update };
  records[index] = updated;
  write(records);
  return updated;
}

export function removeLocalPromptRequest(clientMessageId: string): void {
  write(read().filter((item) => item.clientMessageId !== clientMessageId));
}
