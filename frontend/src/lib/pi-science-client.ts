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
}

// ── Session name helpers (localStorage) ──

const NAME_KEY = "pi-science.session-names";

function loadNames(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(NAME_KEY) || "{}"); } catch { return {}; }
}

function saveNames(names: Record<string, string>) {
  try {
    localStorage.setItem(NAME_KEY, JSON.stringify(names));
  } catch {
    // Session naming is optional metadata; storage failures must never prevent
    // the actual prompt from being sent.
  }
}

export function getSessionName(sessionId: string): string {
  return loadNames()[sessionId] || "";
}

export function setSessionName(sessionId: string, name: string) {
  const names = loadNames();
  names[sessionId] = name.slice(0, 50);  // Cap length
  saveNames(names);
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

// ── Client ──

export class PiScienceClient {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  private listeners = new Set<(event: PiScienceEvent) => void>();
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private connectionGeneration = 0;
  private connectionWatchdog: ReturnType<typeof setTimeout> | null = null;

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
      throw new Error(data.error || `Create session failed: ${res.statusText}`);
    }
    return data;
  }

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    const params = new URLSearchParams({ cwd });
    const res = await request(`${this.baseUrl}/api/sessions?${params}`);
    const data = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(`List sessions failed: ${res.statusText}`);
    return Array.isArray(data) ? data : [];
  }

  async getMessages(sessionId: string, cwd?: string): Promise<HistoryMessage[]> {
    const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/messages${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Load messages failed: ${res.statusText}`);
    }
    return data.messages ?? [];
  }

  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    const params = new URLSearchParams({ cwd });
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/resume?${params}`, {
      method: "POST",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Resume session failed: ${res.statusText}`);
    }
  }

  async getSessionState(sessionId: string, cwd: string): Promise<SessionState> {
    const params = new URLSearchParams({ cwd });
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}/state?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Read session state failed: ${res.statusText}`);
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
      throw new Error(data.error || `Fork session failed: ${res.statusText}`);
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
      const error = new Error(data.error || `Send prompt failed: ${res.statusText}`) as Error & {
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
      throw new Error(data.error || `Set model failed: ${res.statusText}`);
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
      throw new Error(data.error || `Abort failed: ${res.statusText}`);
    }
  }

  async deleteSession(sessionId: string, cwd?: string): Promise<void> {
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const res = await request(`${this.baseUrl}/api/sessions/${sessionId}${params}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Delete session failed: ${res.statusText}`);
    }
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
      throw new Error(data.error || `Interaction response failed: ${res.statusText}`);
    }
  }

  // ── SSE ──

  // Known event types from the backend (named SSE events)
  private static SSE_EVENTS = [
    "text.updated", "tool.updated", "session.idle", "error",
    "question.asked", "permission.asked", "compaction.updated",
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

    const params = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    const url = `${this.baseUrl}/api/sessions/${sessionId}/events${params}`;
    const source = new EventSource(url);
    this.eventSource = source;
    this.emit({ type: "connection.connecting", sessionId });
    this.armConnectionWatchdog(source, generation, sessionId);

    // Parse and forward a data payload to all listeners
    const forward = (data: string) => {
      if (generation !== this.connectionGeneration || source !== this.eventSource) return;
      if (!data || data === "undefined") return;
      try {
        const event = JSON.parse(data) as PiScienceEvent;
        if (event.sessionId && event.sessionId !== sessionId) {
          console.error(`Discarded event for ${event.sessionId}; active stream is ${sessionId}`);
          return;
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
        if ("data" in event) forward(String((event as MessageEvent).data ?? ""));
      });
    }

    // Also catch any unnamed events as fallback
    source.onmessage = (event) => forward(event.data);
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
