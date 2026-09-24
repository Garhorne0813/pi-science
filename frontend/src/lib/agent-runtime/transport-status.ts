/** Transport diagnostics, kept apart from the user-facing availability status.
 *
 *  `status` answers "can the user keep working in this session?". An EventSource
 *  being rebuilt right now answers a different question, and a healthy session
 *  repairs its stream routinely (late-stream probe, turn watchdog, gap
 *  recovery). Mirroring every transport transition into the foreground status
 *  made a working conversation oscillate `ready → connecting → ready`, so the
 *  low-level lifecycle is recorded here instead and only foreground attach,
 *  offline, and exhausted recovery may change the foreground status. */

import type { RuntimeStatus } from "./types";
import { useRuntimeStore } from "./store";

export type TransportStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "recovering"
  | "error"
  | "closed";

/** Why the stream is being (re)built. Attribution is what turns "the status
 *  flickered" into a fixable report. */
export type ReconnectReason =
  | "initial_attach"
  | "session_switch"
  | "late_stream_probe"
  | "turn_watchdog"
  | "stream_gap"
  | "transport_error"
  | "recovery"
  | "manual";

export const RECONNECT_REASONS: readonly ReconnectReason[] = [
  "initial_attach",
  "session_switch",
  "late_stream_probe",
  "turn_watchdog",
  "stream_gap",
  "transport_error",
  "recovery",
  "manual",
];

export interface TransportTransition {
  sessionId: string | null;
  reason: ReconnectReason;
  previousTransport: TransportStatus;
  nextTransport: TransportStatus;
  previousForeground: RuntimeStatus;
  nextForeground: RuntimeStatus;
  detail?: string;
  at: number;
}

const DIAGNOSTIC_LOG_LIMIT = 64;

/** Counters described by the connection-stability requirements. Read them
 *  before/after a change to prove the foreground stopped churning: after the
 *  fix `foregroundDemotions` must stay at zero for background reconnects while
 *  `transitions` keeps growing. */
export interface TransportDiagnostics {
  transitions: number;
  /** Stream rebuilds after a stream existed before — the number the
   *  connection-stability requirement must NOT reduce. */
  reconnects: number;
  /** Transport transitions that demoted a previously ready foreground status. */
  foregroundDemotions: number;
  byReason: Partial<Record<ReconnectReason, number>>;
}

const counters: TransportDiagnostics = {
  transitions: 0,
  reconnects: 0,
  foregroundDemotions: 0,
  byReason: {},
};

const log: TransportTransition[] = [];

export function transportDiagnostics(): { counters: TransportDiagnostics; log: TransportTransition[] } {
  return { counters: { ...counters, byReason: { ...counters.byReason } }, log: [...log] };
}

/** Test helper: counters are module state, so suites that assert on them must
 *  start from a known zero. */
export function resetTransportDiagnostics(): void {
  counters.transitions = 0;
  counters.reconnects = 0;
  counters.foregroundDemotions = 0;
  counters.byReason = {};
  log.length = 0;
}

export interface TransportEvent {
  /** Low-level lifecycle to record. */
  transport: TransportStatus;
  reason: ReconnectReason;
  /** Foreground status this event is allowed to set. Omitted means the event
   *  carries no availability information and the foreground is untouched. */
  foreground?: RuntimeStatus;
  /** Keep an already-ready foreground status. A background repair of the
   *  session the user is looking at must not look like a fresh attach. */
  keepReady?: boolean;
  sessionId?: string | null;
  detail?: string;
}

/** Apply one transport lifecycle event to the store and record it. Returns the
 *  transition when something changed. */
export function applyTransportEvent(event: TransportEvent): TransportTransition | null {
  const current = useRuntimeStore.getState();
  const previousTransport = current.transportStatus;
  const previousForeground = current.status;
  const foreground = event.foreground === undefined
    ? previousForeground
    : event.keepReady && previousForeground === "ready"
      ? "ready"
      : event.foreground;
  if (previousTransport === event.transport && previousForeground === foreground) return null;
  if (previousTransport !== event.transport) {
    counters.transitions += 1;
    const rebuilding = event.transport === "connecting" || event.transport === "reconnecting";
    if (rebuilding) {
      if (previousTransport !== "idle") counters.reconnects += 1;
      counters.byReason[event.reason] = (counters.byReason[event.reason] ?? 0) + 1;
    }
  }
  if (previousForeground === "ready" && foreground === "connecting") counters.foregroundDemotions += 1;
  const transition: TransportTransition = {
    sessionId: event.sessionId ?? current.activeSessionId,
    reason: event.reason,
    previousTransport,
    nextTransport: event.transport,
    previousForeground,
    nextForeground: foreground,
    ...(event.detail ? { detail: event.detail } : {}),
    at: Date.now(),
  };
  log.push(transition);
  if (log.length > DIAGNOSTIC_LOG_LIMIT) log.splice(0, log.length - DIAGNOSTIC_LOG_LIMIT);
  useRuntimeStore.setState({
    ...(previousTransport !== event.transport ? { transportStatus: event.transport } : {}),
    ...(previousForeground !== foreground ? { status: foreground } : {}),
  });
  return transition;
}

/** Expose the counters to a live probe (a browser session or an in-page
 *  automation) without shipping a debug UI. */
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as unknown as Record<string, unknown>).__piScienceTransportDiagnostics = transportDiagnostics;
}
