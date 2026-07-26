/** PiScienceClient — HTTP+SSE client for the pi-science backend.
 *  Replaces open-science's OpenCodeClient. */

// ── Types ──

export interface PiScienceEvent {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AvailableModel {
  id: string;
  provider: string;
  model: string;
  label: string;
  custom?: boolean;
  reasoning?: boolean;
  thinking_levels?: string[];
  context_window?: number | null;
  capability_source?: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Conversation model menus expose every configured provider, including custom providers. */
export function conversationModelOptions(models: AvailableModel[]): AvailableModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

/** Keep the current Think setting valid when the selected model changes. */
export function clampThinkingLevel(requested: string, supported: string[]): string {
  if (supported.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested as typeof THINKING_LEVELS[number]);
  const start = requestedIndex === -1 ? 0 : requestedIndex;
  return THINKING_LEVELS.slice(start).find((level) => supported.includes(level))
    || [...THINKING_LEVELS].slice(0, start).reverse().find((level) => supported.includes(level))
    || supported[0]
    || "off";
}

// ── Session name helpers (localStorage) ──

const NAME_KEY = "pi-science.session-names";

function loadNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NAME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function saveNames(names: Record<string, string>) {
  try {
    localStorage.setItem(NAME_KEY, JSON.stringify(names));
  } catch {
    // Session naming is optional metadata; storage failures must never prevent
    // the actual prompt from being sent.
  }
}

/** Read the display name for a session. On first read it migrates the v2
 *  single-key format (`names[sessionId]`) to the composite `(cwd, sessionId)`
 *  key, so upgrading does not silently drop every existing custom name.
 *  Corrupt values (objects, numbers, ...) are discarded and treated as "no
 *  name" so they can never be rendered as a React child. Always returns a
 *  string. */
function readName(cwd: string, sessionId: string): string {
  const names = loadNames();
  const compositeKey = sessionKey(cwd, sessionId);
  const composite = names[compositeKey];
  let changed = false;
  if (typeof composite === "string") return composite;
  if (composite !== undefined) {
    delete names[compositeKey];
    changed = true;
  }
  const legacy = names[sessionId];
  if (typeof legacy === "string") {
    names[compositeKey] = legacy;
    delete names[sessionId];
    saveNames(names);
    return legacy;
  }
  if (legacy !== undefined) {
    delete names[sessionId];
    changed = true;
  }
  if (changed) saveNames(names);
  return "";
}

/** Session names are scoped by (cwd, sessionId) so that two workspaces that
 *  happen to share a session id do not collide on a single global name. */
export function getSessionName(cwd: string, sessionId: string): string {
  const value = readName(cwd, sessionId);
  return typeof value === "string" ? value : "";
}

export function setSessionName(cwd: string, sessionId: string, name: string): void {
  const names = loadNames();
  names[sessionKey(cwd, sessionId)] = name.slice(0, 50);  // Cap length
  saveNames(names);
}

/** Remove the display name for a session (e.g. after deletion or when a
 *  missing session is recovered) so it cannot resurface on a reused id or
 *  linger in local storage as accumulated project metadata. */
export function clearSessionName(cwd: string, sessionId: string): void {
  const names = loadNames();
  const compositeKey = sessionKey(cwd, sessionId);
  let changed = false;
  if (names[compositeKey] !== undefined) {
    delete names[compositeKey];
    changed = true;
  }
  // Also clear any v2-era bare sessionId key that may still be present.
  if (names[sessionId] !== undefined) {
    delete names[sessionId];
    changed = true;
  }
  if (changed) saveNames(names);
}

export function moveSessionName(cwd: string, previousSessionId: string, nextSessionId: string): string {
  if (!cwd || !previousSessionId || !nextSessionId || previousSessionId === nextSessionId) {
    return getSessionName(cwd, nextSessionId || previousSessionId);
  }
  const previousKey = sessionKey(cwd, previousSessionId);
  const nextKey = sessionKey(cwd, nextSessionId);
  // readName may migrate a legacy key and persists a separately loaded map;
  // reload after it so that migration cannot be overwritten by this save.
  const previousName = getSessionName(cwd, previousSessionId);
  const names = loadNames();
  const existingNext = typeof names[nextKey] === "string" ? names[nextKey] : "";
  if (!existingNext && previousName) names[nextKey] = previousName;
  delete names[previousKey];
  delete names[previousSessionId];
  saveNames(names);
  return typeof names[nextKey] === "string" ? names[nextKey] : "";
}

/** Derive a display name from message text: first non-empty line, trimmed,
 *  internal whitespace collapsed, capped at 48 chars with "…" appended when
 *  truncated (CJK counts as chars). Returns "" for text with no visible
 *  content. */
export function deriveSessionName(text: string): string {
  const line = text.split("\n").map((candidate) => candidate.trim()).find(Boolean) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > 48 ? `${collapsed.slice(0, 48)}…` : collapsed;
}

// ── Message cache (localStorage) ──
// Stores the most recent message snapshot per (cwd, sessionId) so that
// switching back to a previously-viewed conversation renders instantly before
// the network response arrives. Each entry is capped to MESSAGE_CACHE_LIMIT
// items to keep localStorage usage bounded.
//
// IMPORTANT: The cache key MUST be a composite of (cwd, sessionId) because
// different workspaces can have sessions with the same ID. Using sessionId
// alone would cause cross-workspace content leakage.

const MESSAGE_CACHE_KEY = "pi-science.msg-cache";
const MESSAGE_CACHE_LIMIT = 200;
const MESSAGE_CACHE_PER_SESSION_BYTES = 256 * 1024;  // 256 KB
const MESSAGE_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const MESSAGE_CACHE_MAX_ENTRIES = 20;

/** Build a composite cache key that uniquely identifies a session within
 *  a specific workspace. */
function sessionKey(cwd: string, sessionId: string): string {
  return `${cwd}\0${sessionId}`;
}

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

function cacheMessages(cwd: string, sessionId: string, messages: HistoryMessage[]): void {
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

function readCachedMessages(cwd: string, sessionId: string): HistoryMessage[] | null {
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

export interface HistoryMessage {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: string;
}

export interface SessionState {
  id: string;
  cwd: string;
  is_streaming: boolean;
  is_compacting: boolean;
  pending_message_count: number;
  model?: string;
  thinking?: string;
  context_tokens?: number | null;
  context_window?: number | null;
  context_percent?: number | null;
  compaction_enabled?: boolean;
  compaction_threshold_percent?: number | null;
}

export interface InteractionResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

const REQUEST_TIMEOUT_MS = 45_000;

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Request timed out while contacting the Pi-Science backend");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function responseError(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const payload = data as { error?: unknown; detail?: unknown };
    if (typeof payload.error === "string" && payload.error) return payload.error;
    if (typeof payload.detail === "string" && payload.detail) return payload.detail;
  }
  return fallback;
}

// ── Client ──

export class PiScienceClient {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  private listeners = new Set<(event: PiScienceEvent) => void>();
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private connectionGeneration = 0;
  private connectionWatchdog: ReturnType<typeof setTimeout> | null = null;
  // Track the last SSE event id per (cwd, sessionId) so that switching back
  // to a previously-viewed conversation can resume from the cursor instead of
  // forcing the backend to replay the entire event log. Uses a composite key
  // because different workspaces can have sessions with the same ID.
  private lastEventIds = new Map<string, string>();

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;  // Empty = use relative URLs (goes through Vite proxy in dev)
  }

  get isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState !== EventSource.CLOSED;
  }

  get connectedSessionId(): string | null {
    return this.isConnected ? this.sessionId : null;
  }

  isConnectedTo(sessionId: string, cwd?: string): boolean {
    return this.isConnected
      && this.sessionId === sessionId
      && (cwd === undefined || this.cwd === cwd);
  }

  isOpenTo(sessionId: string, cwd?: string): boolean {
    return this.eventSource !== null
      && this.eventSource.readyState === EventSource.OPEN
      && this.sessionId === sessionId
      && (cwd === undefined || this.cwd === cwd);
  }

  // ── REST ──

  async createSession(cwd: string, model?: string): Promise<{ id: string }> {
    const config = model ? { model } : {};
    const res = await request(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        config,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Create session failed: ${res.statusText}`));
    }
    return data;
  }

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    const params = new URLSearchParams({ cwd });
    const res = await request(`${this.baseUrl}/api/sessions?${params}`);
    const data = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(responseError(data, `List sessions failed: ${res.statusText}`));
    return Array.isArray(data) ? data : [];
  }

  async getMessages(sessionId: string, cwd?: string): Promise<HistoryMessage[]> {
    const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/messages${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Load messages failed: ${res.statusText}`));
    }
    const messages = data.messages ?? [];
    // Persist to the local cache so the next switch to this session can
    // render instantly before the network response arrives.
    if (cwd) cacheMessages(cwd, sessionId, messages);
    return messages;
  }

  /** Return the most recently cached message snapshot for a session, or null.
   *  Used to render the conversation instantly on switch before the network
   *  response arrives. */
  getCachedMessages(sessionId: string, cwd?: string): HistoryMessage[] | null {
    if (!cwd) return null;
    return readCachedMessages(cwd, sessionId);
  }

  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    const params = new URLSearchParams({ cwd });
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/resume?${params}`, {
      method: "POST",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Resume session failed: ${res.statusText}`));
    }
  }

  async getSessionState(sessionId: string, cwd: string): Promise<SessionState> {
    const params = new URLSearchParams({ cwd });
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/state?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Read session state failed: ${res.statusText}`));
    }
    return data as SessionState;
  }

  async forkSession(sessionId: string, cwd: string, entryId?: string): Promise<{ id: string }> {
    const params = new URLSearchParams({ cwd });
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/fork?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entryId ? { entry_id: entryId } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Fork session failed: ${res.statusText}`));
    }
    return { id: data.id };
  }

  async sendPrompt(sessionId: string, message: string, cwd?: string): Promise<void> {
    const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/prompt${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const error = new Error(responseError(data, `Send prompt failed: ${res.statusText}`)) as Error & {
        code?: string;
        status?: number;
      };
      error.code = typeof data.code === "string" ? data.code : undefined;
      error.status = res.status;
      throw error;
    }
  }

  async setModel(
    sessionId: string,
    model: string,
    cwd?: string,
    thinking?: string,
  ): Promise<{ id?: string; restarted: boolean; replacedBlank?: boolean; model?: string; thinking?: string }> {
    const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/model${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, thinking }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Set model failed: ${res.statusText}`));
    }
    return {
      id: data.id,
      restarted: data.restarted === true,
      replacedBlank: data.replaced_blank === true,
      model: data.model,
      thinking: data.thinking,
    };
  }

  async abort(sessionId: string, cwd?: string): Promise<void> {
    const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/abort${params}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Abort failed: ${res.statusText}`));
    }
  }

  async deleteSession(sessionId: string, cwd?: string): Promise<void> {
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}${params}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Delete session failed: ${res.statusText}`));
    }
    if (cwd) {
      this.lastEventIds.delete(sessionKey(cwd, sessionId));
      clearCachedMessages(cwd, sessionId);
      clearSessionName(cwd, sessionId);
    }
  }

  /** Remove the SSE resume cursor for a session (e.g. after it is replaced or
   *  detected missing) so a later connect() does a full replay rather than
   *  resuming from a cursor that no longer belongs to this session. */
  clearCursor(cwd: string, sessionId: string): void {
    if (cwd && sessionId) this.lastEventIds.delete(sessionKey(cwd, sessionId));
  }

  async respondToInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
    cwd?: string,
  ): Promise<void> {
    const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    const res = await request(
      `${this.baseUrl}/api/sessions/${sessionId}/interactions/${encodeURIComponent(requestId)}${params}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(responseError(data, `Interaction response failed: ${res.statusText}`));
    }
  }

  // ── SSE ──

  // Known event types from the backend (named SSE events)
  private static SSE_EVENTS = [
    "text.updated", "tool.updated", "session.idle", "error",
    "question.asked", "permission.asked", "compaction.updated", "artifact.published",
    "agent_start", "agent_end", "status.updated", "session.replaced", "stream.gap",
  ];

  connect(sessionId: string, cwd?: string): void {
    const targetCwd = cwd ?? null;
    if (this.isConnectedTo(sessionId, targetCwd ?? undefined)) {
      return;
    }
    this.closeEventSource();
    const generation = ++this.connectionGeneration;
    this.sessionId = sessionId;
    this.cwd = targetCwd;

    // If we already have a cursor for this (cwd, sessionId) from a previous
    // view, pass it to the backend so it only replays events after the cursor
    // instead of the full event log. This is the key optimisation for
    // conversation switching speed.
    const cursorKey = targetCwd ? sessionKey(targetCwd, sessionId) : "";
    const lastEventId = cursorKey ? this.lastEventIds.get(cursorKey) : undefined;
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (lastEventId) params.set("lastEventId", lastEventId);
    const query = params.toString();
    const url = `${this.baseUrl}/api/sessions/${sessionId}/events${query ? `?${query}` : ""}`;
    const source = new EventSource(url);
    this.eventSource = source;
    this.emit({ type: "connection.connecting", sessionId });
    this.armConnectionWatchdog(source, generation, sessionId);

    // Parse and forward a data payload to all listeners
    const forward = (data: string, eventId?: string) => {
      if (generation !== this.connectionGeneration || source !== this.eventSource) return;
      if (!data || data === "undefined") return;
      try {
        const event = JSON.parse(data) as PiScienceEvent;
        // Validate session ownership BEFORE updating the cursor. A foreign
        // event (from a different session on the same stream) must never
        // advance our cursor — otherwise reconnecting would skip events that
        // belong to us.
        if (event.sessionId && event.sessionId !== sessionId) {
          console.error(`Discarded event for ${event.sessionId}; active stream is ${sessionId}`);
          return;
        }
        // Only advance the cursor after the event has passed all validation.
        if (eventId && cursorKey) this.lastEventIds.set(cursorKey, eventId);
        // On stream.gap the stored cursor is stale (the backend no longer
        // retains events that far back). Clear it, then proactively rebuild
        // the connection WITHOUT the cursor so the new subscription only
        // carries FUTURE events. The authoritative conversation snapshot is
        // restored separately by the runtime store (which re-reads messages
        // and the authoritative session state over REST), so this rebuild is
        // purely the live-event transport — not a "full replay" of the log.
        // Rebuilding now also avoids the browser's native EventSource
        // auto-reconnect reusing the same ?lastEventId= URL, which the backend
        // can no longer satisfy and would re-emit the gap in a loop.
        if (event.type === "stream.gap" && cursorKey) {
          this.lastEventIds.delete(cursorKey);
          const reconnectSession = this.sessionId;
          const reconnectCwd = this.cwd;
          if (reconnectSession && generation === this.connectionGeneration && source === this.eventSource) {
            // Surface the gap to listeners, then rebuild the transport WITHOUT
            // the cursor. Close the current socket first so connect() isn't
            // short-circuited by its own isConnectedTo() guard.
            this.emit(event);
            // A listener may have reacted to the gap by disconnecting or
            // switching sessions. Re-verify the connection is still for this
            // session before reconnecting, otherwise we would forcibly
            // reconnect to a session the user just left.
            if (
              generation !== this.connectionGeneration
              || source !== this.eventSource
              || this.sessionId !== reconnectSession
              || this.cwd !== reconnectCwd
            ) {
              return;
            }
            this.closeEventSource();
            this.connect(reconnectSession, reconnectCwd ?? undefined);
            return;
          }
        }
        this.emit(event);
        // The backend marks unrecoverable stream errors (for example a
        // session that no longer exists in the workspace) as terminal. A
        // native EventSource automatically retries after the server closes
        // the response, so explicitly invalidate and close this source to
        // prevent an infinite error/reconnect loop.
        if (
          event.type === "error"
          && event.terminal === true
          && generation === this.connectionGeneration
          && source === this.eventSource
        ) {
          ++this.connectionGeneration;
          this.closeEventSource();
          this.sessionId = null;
          this.cwd = null;
        }
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    };

    // Backend sends NAMED events (event: text.updated, event: session.idle, etc.)
    // EventSource.onmessage only fires for unnamed events, so we use addEventListener
    for (const evt of PiScienceClient.SSE_EVENTS) {
      source.addEventListener(evt, (event: Event) => {
        const messageEvent = event as MessageEvent;
        forward(String(messageEvent.data ?? ""), messageEvent.lastEventId || undefined);
      });
    }

    // Also catch any unnamed events as fallback
    source.onmessage = (event) => forward(event.data, event.lastEventId || undefined);
    source.onopen = () => {
      if (generation === this.connectionGeneration && source === this.eventSource) {
        this.clearConnectionWatchdog();
        this.emit({ type: "connection.open", sessionId });
      }
    };

    source.onerror = (event) => {
      if (generation !== this.connectionGeneration || source !== this.eventSource) return;
      // A server-sent `event: error` is a MessageEvent and is already handled
      // by the named listener above. Only native EventSource transport errors
      // should change the connection state.
      if ("data" in event) return;
      if (source.readyState === EventSource.CLOSED) this.clearConnectionWatchdog();
      else this.armConnectionWatchdog(source, generation, sessionId);
      this.emit({
        type: source.readyState === EventSource.CLOSED ? "connection.error" : "connection.reconnecting",
        sessionId,
        message: source.readyState === EventSource.CLOSED
          ? "Conversation stream closed"
          : "Reconnecting conversation stream",
      });
    };
  }

  disconnect(): void {
    const sessionId = this.sessionId;
    ++this.connectionGeneration;
    this.closeEventSource();
    this.sessionId = null;
    this.cwd = null;
    if (sessionId) this.emit({ type: "connection.closed", sessionId });
  }

  onEvent(fn: (event: PiScienceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private closeEventSource(): void {
    this.clearConnectionWatchdog();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private armConnectionWatchdog(
    source: EventSource,
    generation: number,
    sessionId: string,
  ): void {
    this.clearConnectionWatchdog();
    this.connectionWatchdog = globalThis.setTimeout(() => {
      if (
        generation === this.connectionGeneration
        && source === this.eventSource
        && source.readyState === EventSource.CONNECTING
      ) {
        this.emit({
          type: "connection.error",
          sessionId,
          message: "Conversation stream connection timed out; the backend state is being checked.",
        });
      }
    }, REQUEST_TIMEOUT_MS);
  }

  private clearConnectionWatchdog(): void {
    if (this.connectionWatchdog !== null) {
      globalThis.clearTimeout(this.connectionWatchdog);
      this.connectionWatchdog = null;
    }
  }

  private emit(event: PiScienceEvent): void {
    this.listeners.forEach((fn) => {
      try {
        fn(event);
      } catch (err) {
        console.error("Event listener error:", err);
      }
    });
  }
}

// ── Singleton ──

let clientInstance: PiScienceClient | null = null;

export function getClient(): PiScienceClient {
  if (!clientInstance) {
    clientInstance = new PiScienceClient();
  }
  return clientInstance;
}

export function createClient(baseUrl: string): PiScienceClient {
  clientInstance = new PiScienceClient(baseUrl);
  return clientInstance;
}
