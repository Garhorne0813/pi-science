/** SSE transport: EventSource lifecycle, connection watchdog, resume cursors
 *  and listener fan-out. Owned by PiScienceClient, which delegates its
 *  connection API to this object. */

import { REQUEST_TIMEOUT_MS } from "./http";
import { sessionKey } from "./session-key";
import type { PiScienceEvent } from "./types";

/** Reconnect attribution travels with the transport events so a watcher can
 *  tell a foreground attach from background repair. Duplicated as a literal
 *  type to keep the client layer free of runtime-store imports. */
export type TransportReason =
  | "initial_attach"
  | "session_switch"
  | "late_stream_probe"
  | "turn_watchdog"
  | "stream_gap"
  | "transport_error"
  | "recovery"
  | "manual";

/** A recovery reconnect with no applied cursor must never become a future-only
 *  subscription. This deliberately missing cursor forces the server to answer
 *  with stream.gap, which establishes a live subscriber before recovery runs. */
const RECOVERY_REPLAY_SENTINEL = "pi-recovery-sentinel:0";

export class SseTransport {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  private listeners = new Set<(event: PiScienceEvent) => unknown>();
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private connectionGeneration = 0;
  private connectionWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Why the current subscription exists. Reported with every lifecycle event
   *  of that subscription so a reconnect storm is attributable. */
  private connectionReason: TransportReason = "initial_attach";
  // Track the last SSE event id per (cwd, sessionId) so that switching back
  // to a previously-viewed conversation can resume from the cursor instead of
  // forcing the backend to replay the entire event log. Uses a composite key
  // because different workspaces can have sessions with the same ID.
  private lastEventIds = new Map<string, string>();
  /** Diagnostic/flow-control cursor. It is intentionally separate from the
   * applied cursor used for reconnect URLs: receiving an event is not proof
   * that the reducer accepted it. */
  private receivedEventIds = new Map<string, string>();
  /** A server-declared gap is delivered only after the backend has already
   * registered this EventSource as a live subscriber. Keep that exact stream
   * alive until a normal event is successfully applied; closing it during the
   * REST rebase would recreate a subscribe-registration blind spot. */
  private gapFencedKey: string | null = null;
  private pausedForVisibility = false;
  private listeningForVisibility = false;
  private readonly onVisibilityChange = () => {
    if (document.hidden) {
      if (!this.sessionId) return;
      this.pausedForVisibility = true;
      ++this.connectionGeneration;
      this.gapFencedKey = null;
      this.closeEventSource();
    } else if (this.pausedForVisibility && this.sessionId) {
      this.connect(this.sessionId, this.cwd ?? undefined, "recovery");
    }
  };

  // Known event types from the backend (named SSE events)
  private static SSE_EVENTS = [
    "text.updated", "thinking.updated", "tool.updated", "session.idle", "error",
    "question.asked", "permission.asked", "compaction.updated", "artifact.published",
    "questionnaire.asked", "questionnaire.finished",
    "agent_start", "agent_end", "status.updated", "session.replaced", "stream.gap",
    "turn.artifacts", "session.stats",
    // Presentation protocol v2 events use the same SSE transport. Keeping
    // these names explicit is important because EventSource only dispatches
    // named events to registered listeners.
    "run.started", "run.completed", "run.failed", "run.cancelled",
    "item.started", "item.text.delta", "item.snapshot", "item.completed",
    "plan.updated", "interaction.requested", "interaction.resolved", "artifact.updated",
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

  connect(sessionId: string, cwd?: string, reason?: TransportReason): void {
    const targetCwd = cwd ?? null;
    if (this.isConnectedTo(sessionId, targetCwd ?? undefined)) {
      return;
    }
    if (!this.listeningForVisibility && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      this.listeningForVisibility = true;
    }
    const resumingFromHidden = this.pausedForVisibility;
    const attachReason = reason
      ?? (this.sessionId !== null && this.sessionId !== sessionId ? "session_switch" : "initial_attach");
    this.connectionReason = attachReason;
    // A gap fence belongs to the currently registered EventSource only. A
    // real session switch/new attach must not suppress the new connection.
    this.gapFencedKey = null;
    this.closeEventSource();
    const generation = ++this.connectionGeneration;
    this.sessionId = sessionId;
    this.cwd = targetCwd;
    if (typeof document !== "undefined" && document.hidden) {
      this.pausedForVisibility = true;
      return;
    }

    // If we already have a cursor for this (cwd, sessionId) from a previous
    // view, pass it to the backend so it only replays events after the cursor
    // instead of the full event log. This is the key optimisation for
    // conversation switching speed.
    const cursorKey = targetCwd ? sessionKey(targetCwd, sessionId) : "";
    const lastEventId = cursorKey
      ? this.lastEventIds.get(cursorKey) ?? (resumingFromHidden ? RECOVERY_REPLAY_SENTINEL : undefined)
      : undefined;
    this.pausedForVisibility = false;
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (lastEventId) params.set("lastEventId", lastEventId);
    const query = params.toString();
    const url = `${this.baseUrl}/api/sessions/${sessionId}/events${query ? `?${query}` : ""}`;
    const source = new EventSource(url, { withCredentials: true });
    this.eventSource = source;
    this.emit({ type: "connection.connecting", sessionId, reason: attachReason });
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
        if (eventId && cursorKey) this.receivedEventIds.set(cursorKey, eventId);
        // ConversationEventHub registers a subscriber before it attempts the
        // cursor replay that may produce stream.gap. Therefore the EventSource
        // carrying this gap is already a lossless live fence for every event
        // published after the gap decision. Keep it open while REST recovery
        // rebases the projection. Reconnecting here would create a blind
        // interval between closing this subscriber and registering the next.
        // Keep the last APPLIED cursor as well: if the socket later has to be
        // rebuilt before a new event arrives, replaying that cursor may yield
        // another gap, but it cannot silently skip an unseen event.
        if (event.type === "stream.gap" && cursorKey) {
          this.gapFencedKey = cursorKey;
          this.emit(event);
          return;
        }
        const applied = this.emit(event);
        if (applied && eventId && cursorKey) {
          this.lastEventIds.set(cursorKey, eventId);
          if (this.gapFencedKey === cursorKey) this.gapFencedKey = null;
        }
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
          this.gapFencedKey = null;
          this.closeEventSource();
          this.sessionId = null;
          this.cwd = null;
          this.pausedForVisibility = false;
          this.stopVisibilityListening();
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
        this.emit({ type: "connection.open", sessionId, reason: this.connectionReason });
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
        reason: "transport_error",
        message: source.readyState === EventSource.CLOSED
          ? "Conversation stream closed"
          : "Reconnecting conversation stream",
      });
    };
  }

  /** Rebuild the current subscription even when EventSource still reports
   *  OPEN. A half-open connection can otherwise look healthy forever while
   *  silently missing a turn. The per-session cursor is intentionally kept,
   *  so the replacement stream replays only events that were missed.
   *
   *  Exception: after a server-declared stream.gap the current source itself
   *  is the recovery fence. Do not tear it down until a successfully applied
   *  event advances the cursor (or the source actually closes). */
  reconnect(sessionId: string, cwd?: string, reason?: TransportReason): void {
    if (typeof document !== "undefined" && document.hidden) return;
    const targetCwd = cwd ?? null;
    const cursorKey = targetCwd ? sessionKey(targetCwd, sessionId) : "";
    if (
      cursorKey
      && this.gapFencedKey === cursorKey
      && this.isConnectedTo(sessionId, targetCwd ?? undefined)
    ) return;
    if (this.sessionId !== sessionId || this.cwd !== targetCwd) {
      this.connect(sessionId, cwd, reason);
      return;
    }
    this.closeEventSource();
    this.connect(sessionId, cwd, reason);
  }

  disconnect(): void {
    const sessionId = this.sessionId;
    ++this.connectionGeneration;
    this.gapFencedKey = null;
    this.closeEventSource();
    this.sessionId = null;
    this.cwd = null;
    this.pausedForVisibility = false;
    this.stopVisibilityListening();
    if (sessionId) this.emit({ type: "connection.closed", sessionId, reason: "manual" });
  }

  private stopVisibilityListening(): void {
    if (this.listeningForVisibility) {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.listeningForVisibility = false;
    }
  }

  onEvent(fn: (event: PiScienceEvent) => unknown): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Remove the SSE resume cursor for a session (e.g. after it is replaced or
   *  detected missing) so a later connect() does a full replay rather than
   *  resuming from a cursor that no longer belongs to this session. */
  clearCursor(cwd: string, sessionId: string): void {
    if (cwd && sessionId) {
      const key = sessionKey(cwd, sessionId);
      this.lastEventIds.delete(key);
      this.receivedEventIds.delete(key);
    }
  }

  setResumeCursor(cwd: string, sessionId: string, cursor: string | null): void {
    if (!cwd || !sessionId) return;
    const key = sessionKey(cwd, sessionId);
    if (cursor) {
      this.lastEventIds.set(key, cursor);
      this.receivedEventIds.set(key, cursor);
    } else {
      this.clearCursor(cwd, sessionId);
    }
  }

  /** Recovery may only resume from an event the reducer has actually applied.
   * The server's newest durable cursor can be ahead of the REST snapshot and
   * would recreate the snapshot→cursor TOCTOU loss. When there is no applied
   * cursor, force a server-declared gap instead of opening a future-only SSE. */
  getRecoveryResumeCursor(cwd: string, sessionId: string): string {
    if (!cwd || !sessionId) return RECOVERY_REPLAY_SENTINEL;
    return this.lastEventIds.get(sessionKey(cwd, sessionId)) ?? RECOVERY_REPLAY_SENTINEL;
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
          reason: "transport_error",
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

  private emit(event: PiScienceEvent): boolean {
    let applied = true;
    this.listeners.forEach((fn) => {
      try {
        if (fn(event) === false) applied = false;
      } catch (err) {
        console.error("Event listener error:", err);
        applied = false;
      }
    });
    return applied;
  }
}
