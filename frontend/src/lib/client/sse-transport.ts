/** SSE transport: EventSource lifecycle, connection watchdog, resume cursors
 *  and listener fan-out. Owned by PiScienceClient, which delegates its
 *  connection API to this object. */

import { REQUEST_TIMEOUT_MS } from "./http";
import { sessionKey } from "./session-key";
import type { PiScienceEvent } from "./types";

export class SseTransport {
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

  // Known event types from the backend (named SSE events)
  private static SSE_EVENTS = [
    "text.updated", "tool.updated", "session.idle", "error",
    "question.asked", "permission.asked", "compaction.updated", "artifact.published",
    "questionnaire.asked", "questionnaire.finished",
    "agent_start", "agent_end", "status.updated", "session.replaced", "stream.gap",
    "turn.artifacts",
  ];

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
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
    for (const evt of SseTransport.SSE_EVENTS) {
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

  /** Remove the SSE resume cursor for a session (e.g. after it is replaced or
   *  detected missing) so a later connect() does a full replay rather than
   *  resuming from a cursor that no longer belongs to this session. */
  clearCursor(cwd: string, sessionId: string): void {
    if (cwd && sessionId) this.lastEventIds.delete(sessionKey(cwd, sessionId));
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
