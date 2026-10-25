import type { PiScienceEvent } from "../../client/pi-science-client";
import type { EventFoldState } from "./types";

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function eventHasIdentity(event: PiScienceEvent): boolean {
  return typeof event.itemId === "string" || typeof event.turnId === "string" || typeof event.runId === "string";
}

export function isVersionedEvent(event: PiScienceEvent): boolean {
  return event.schemaVersion === 3 && typeof event.eventId === "string" && typeof event.seq === "number";
}

export function eventItemKey(event: PiScienceEvent, state: EventFoldState): string {
  return stringValue(event.itemId) ?? stringValue(event.partId) ?? state.activeItemKey ?? "anonymous";
}

/** Text revisions belong to content parts, not their enclosing item. */
export function eventTextKey(event: PiScienceEvent, state: EventFoldState): string {
  const payload = recordValue(event.payload);
  return stringValue(payload.partId)
    ?? stringValue(event.partId)
    ?? stringValue(event.itemId)
    ?? state.activeItemKey
    ?? "anonymous";
}

export function turnIdentity(event: PiScienceEvent, state: EventFoldState): string {
  return stringValue(event.turnId) ?? state.activeTurnId ?? `turn-${Math.max(1, state.turnOrdinal)}`;
}

export function runIdentity(event: PiScienceEvent, state: EventFoldState): string | undefined {
  return stringValue(event.runId) ?? state.activeRunId;
}

export function roleOf(event: PiScienceEvent): "intermediate" | "final" | undefined {
  if (event.presentationRole === "intermediate" || event.presentationRole === "final") return event.presentationRole;
  const phase = event.phase;
  if (phase === "commentary") return "intermediate";
  if (phase === "final_answer") return "final";
  return undefined;
}

export function isTerminalRun(state: EventFoldState, runId: string | undefined, sequence?: number): boolean {
  if (!runId || !state.terminalRunIds.includes(runId)) return false;
  const terminalSequence = state.terminalRunSequences[runId];
  // A speculative terminal event can arrive before an earlier missing text
  // event. Sequence-aware checking lets that earlier event repair the visible
  // projection while still rejecting genuinely late events after terminal.
  return terminalSequence === undefined || sequence === undefined || sequence > terminalSequence;
}

export function markTerminalRun(state: EventFoldState, runId: string | undefined, sequence?: number): void {
  if (!runId) return;
  if (!state.terminalRunIds.includes(runId)) state.terminalRunIds = [...state.terminalRunIds, runId].slice(-256);
  if (sequence !== undefined && Number.isFinite(sequence)) {
    if (state.terminalRunSequences[runId] === undefined) state.terminalRunSequences[runId] = sequence;
    const activeRunIds = new Set(state.terminalRunIds);
    for (const terminalRunId of Object.keys(state.terminalRunSequences)) {
      if (!activeRunIds.has(terminalRunId)) delete state.terminalRunSequences[terminalRunId];
    }
  }
}
