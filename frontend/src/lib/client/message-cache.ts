/** Message cache (localStorage).
 *  Stores the most recent message snapshot per (cwd, sessionId) so that
 *  switching back to a previously-viewed conversation renders instantly before
 *  the network response arrives. Each entry is capped to MESSAGE_CACHE_LIMIT
 *  items to keep localStorage usage bounded.
 *
 *  IMPORTANT: The cache key MUST be a composite of (cwd, sessionId) because
 *  different workspaces can have sessions with the same ID. Using sessionId
 *  alone would cause cross-workspace content leakage. */

import { sessionKey } from "./session-key";
import type { HistoryMessage } from "./types";

const MESSAGE_CACHE_KEY = "pi-science.msg-cache";
const MESSAGE_CACHE_LIMIT = 200;
const MESSAGE_CACHE_PER_SESSION_BYTES = 256 * 1024;  // 256 KB
const MESSAGE_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const MESSAGE_CACHE_MAX_ENTRIES = 20;

interface CachedMessageEntry {
  messages: HistoryMessage[];
  cachedAt: number;
}

type MessageCache = Record<string, CachedMessageEntry>;

/** Validate and normalise a single cached entry. Returns null when the entry
 *  must be dropped: `cachedAt` must be a finite number (a missing/string/NaN
 *  value means it was never subject to TTL eviction), `messages` must be an
 *  array, and every message must have string `id`/`role` and an array
 *  `content` with no null elements — otherwise `convertHistoryToBlocks`
 *  (which reads `msg.role` / `msg.content.filter`) would throw. */
function sanitizeMessageEntry(raw: unknown): CachedMessageEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (!Number.isFinite(entry.cachedAt)) return null;
  const messages = entry.messages;
  if (!Array.isArray(messages)) return null;
  const clean: HistoryMessage[] = [];
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const msg = item as Record<string, unknown>;
    if (typeof msg.id !== "string" || typeof msg.role !== "string") continue;
    const content = Array.isArray(msg.content)
      ? msg.content.filter((part) => part !== null && typeof part === "object")
      : [];
    clean.push({
      id: msg.id,
      role: msg.role,
      content: content as Array<{ type: string; text?: string; [key: string]: unknown }>,
      toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
      toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
      isError: msg.isError === true,
      timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
    });
  }
  if (clean.length === 0) return null;
  return { messages: clean, cachedAt: entry.cachedAt as number };
}

function loadMessageCache(): MessageCache {
  try {
    const raw = localStorage.getItem(MESSAGE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // A corrupt or unexpected value (e.g. the literal "null", a string, or an
    // array) must never crash the caller. Drop individual entries that fail
    // schema validation so a single bad message cannot poison the whole cache
    // nor crash the render path.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: MessageCache = {};
    let mutated = false;
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = sanitizeMessageEntry(value);
      if (entry && entry.cachedAt <= now && now - entry.cachedAt <= MESSAGE_CACHE_TTL_MS) result[key] = entry;
      else mutated = true;
    }
    if (mutated) saveMessageCache(result);
    return result;
  } catch {
    return {};
  }
}

function saveMessageCache(cache: MessageCache): void {
  try {
    // Enforce a max entry count with simple LRU eviction (by cachedAt).
    const entries = Object.entries(cache);
    if (entries.length > MESSAGE_CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => (a[1].cachedAt ?? 0) - (b[1].cachedAt ?? 0));
      for (let i = 0; i < entries.length - MESSAGE_CACHE_MAX_ENTRIES; i++) {
        delete cache[entries[i][0]];
      }
    }
    localStorage.setItem(MESSAGE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage quota exceeded — drop the entire cache rather than silently
    // serving stale data.
    try {
      localStorage.removeItem(MESSAGE_CACHE_KEY);
    } catch { /* ignore */ }
  }
}

export function cacheMessages(cwd: string, sessionId: string, messages: HistoryMessage[]): void {
  if (!sessionId || !cwd) return;
  // Empty history must overwrite (not skip) so stale cache from a deleted
  // session doesn't resurface.
  const cache = loadMessageCache();
  const key = sessionKey(cwd, sessionId);
  if (messages.length === 0) {
    if (cache[key]) {
      delete cache[key];
      saveMessageCache(cache);
    }
    return;
  }
  const trimmed = messages.slice(-MESSAGE_CACHE_LIMIT);
  const entry: CachedMessageEntry = { messages: trimmed, cachedAt: Date.now() };
  // Guard against excessively large entries that would blow past the quota.
  try {
    if (JSON.stringify(entry).length > MESSAGE_CACHE_PER_SESSION_BYTES) return;
  } catch {
    return;
  }
  cache[key] = entry;
  saveMessageCache(cache);
}

export function readCachedMessages(cwd: string, sessionId: string): HistoryMessage[] | null {
  const cache = loadMessageCache();
  const key = sessionKey(cwd, sessionId);
  const entry = cache[key];
  if (!entry || !Array.isArray(entry.messages) || entry.messages.length === 0) return null;
  // TTL check: drop the stale entry outright instead of leaving it to linger
  // in localStorage. `cachedAt` is guaranteed finite by sanitizeMessageEntry.
  if (Date.now() - entry.cachedAt > MESSAGE_CACHE_TTL_MS) {
    delete cache[key];
    saveMessageCache(cache);
    return null;
  }
  return entry.messages;
}

/** Remove the cached message snapshot for a session (e.g. after deletion). */
export function clearCachedMessages(cwd: string, sessionId: string): void {
  const cache = loadMessageCache();
  const key = sessionKey(cwd, sessionId);
  if (cache[key]) {
    delete cache[key];
    saveMessageCache(cache);
  }
}
