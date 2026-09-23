import type { PromptDeliveryState } from "./types";

const KEY = "pi-science.pending-prompt-requests.v1";
const MAX_RECORDS = 30;

export interface LocalPromptRequest {
  cwd: string;
  sessionId: string;
  clientMessageId: string;
  contentDigest: string;
  status: PromptDeliveryState;
}

function storage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; }
  catch { return null; }
}

function read(): LocalPromptRequest[] {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LocalPromptRequest => Boolean(item && typeof item === "object"
      && typeof item.cwd === "string" && typeof item.sessionId === "string"
      && typeof item.clientMessageId === "string" && typeof item.contentDigest === "string"
      && ["pending", "accepted", "persisted", "rejected", "indeterminate"].includes(String(item.status))));
  } catch { return []; }
}

function write(records: LocalPromptRequest[]): void {
  try { storage()?.setItem(KEY, JSON.stringify(records.slice(-MAX_RECORDS))); }
  catch { /* storage may be disabled; the active page still carries the ID */ }
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

export function saveLocalPromptRequest(record: LocalPromptRequest): void {
  const records = read().filter((item) => item.clientMessageId !== record.clientMessageId);
  records.push(record);
  write(records);
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
