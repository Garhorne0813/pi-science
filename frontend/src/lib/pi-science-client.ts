/** PiScienceClient — HTTP+SSE client for the pi-science backend.
 *  Replaces open-science's OpenCodeClient. */

import type { ThreadBlock } from "../types/thread";

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
  name?: string;
}

// ── Session name helpers (localStorage) ──

const NAME_KEY = "pi-science.session-names";

function loadNames(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(NAME_KEY) || "{}"); } catch { return {}; }
}

function saveNames(names: Record<string, string>) {
  localStorage.setItem(NAME_KEY, JSON.stringify(names));
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
  timestamp?: string;
}

// ── Client ──

export class PiScienceClient {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  private listeners = new Set<(event: PiScienceEvent) => void>();
  private sessionId: string | null = null;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;  // Empty = use relative URLs (goes through Vite proxy in dev)
  }

  get isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }

  // ── REST ──

  async createSession(cwd: string, model?: string): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        config: { model: model ?? "anthropic/claude-sonnet-5-20250929", thinking: "high" },
      }),
    });
    if (!res.ok) throw new Error(`Create session failed: ${res.statusText}`);
    const data = await res.json();
    this.sessionId = data.id;
    return data;
  }

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    const params = new URLSearchParams({ cwd });
    const res = await fetch(`${this.baseUrl}/api/sessions?${params}`);
    if (!res.ok) return [];
    return res.json();
  }

  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages ?? [];
  }

  async sendPrompt(sessionId: string, message: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Send prompt failed: ${res.statusText}`);
  }

  async abort(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/sessions/${sessionId}/abort`, { method: "POST" });
  }

  async deleteSession(sessionId: string, cwd?: string): Promise<void> {
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    await fetch(`${this.baseUrl}/api/sessions/${sessionId}${params}`, { method: "DELETE" });
  }

  // ── SSE ──

  // Known event types from the backend (named SSE events)
  private static SSE_EVENTS = [
    "text.updated", "tool.updated", "session.idle", "error",
    "question.asked", "permission.asked", "compaction.updated",
  ];

  connect(sessionId: string): void {
    // If already connected to the same session, don't disrupt the stream
    if (this.sessionId === sessionId && this.eventSource?.readyState === EventSource.OPEN) {
      return;
    }
    // Close old connection only if switching sessions
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    // IMPORTANT: don't clear listeners here — they're registered once and persist.
    // _registerEventListener adds them; disconnect() is the only place that clears.
    this.sessionId = sessionId;

    const url = `${this.baseUrl}/api/sessions/${sessionId}/events`;
    this.eventSource = new EventSource(url);

    // Parse and forward a data payload to all listeners
    const forward = (data: string) => {
      if (!data || data === "undefined") return;
      try {
        const event = JSON.parse(data) as PiScienceEvent;
        this.listeners.forEach((fn) => {
          try { fn(event); } catch (err) {
            console.error("Event listener error:", err);
          }
        });
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    };

    for (const evt of PiScienceClient.SSE_EVENTS) {
      this.eventSource.addEventListener(evt, (e: MessageEvent) => forward(e.data));
    }

    this.eventSource.onmessage = (e) => forward(e.data);

    this.eventSource.onerror = () => {
      // EventSource auto-reconnects; no need to log every reconnect attempt
    };
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.sessionId = null;
    this.listeners.clear();
  }

  onEvent(fn: (event: PiScienceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
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
