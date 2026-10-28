import { pathIsInside } from "../../../support/platform-utils.js";
import type { ProductInput } from "../product-input.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SseEventRecord } from "../event-store.js";
import type { TurnState } from "./types.js";
import { MAX_TEXT_CHUNK_BYTES } from "./limits.js";
import { splitUtf8, safeValue } from "./text.js";

export function streamKey(cwd: string, sessionId: string): string {
  return `${resolve(cwd)}\0${sessionId}`;
}

export function recordKey(record: SseEventRecord): string {
  return record.id ?? `${record.created_at}\0${record.event ?? ""}\0${record.data}`;
}

export function recordPayload(record: SseEventRecord): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(record.data) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function newConversationId(kind: "turn" | "run", sessionId: string, ordinal: number): string {
  // The ordinal is useful for diagnostics, but it is only in-memory and resets
  // when the control plane restarts. A UUID prevents a resumed session from
  // reusing an identity that the browser has already marked terminal.
  return `${kind}-${sessionId}-${ordinal}-${randomUUID()}`;
}

export function turnFields(turn: TurnState): Record<string, unknown> {
  return {
    turnId: turn.turnId ?? `turn-unknown-${Math.max(1, turn.turnOrdinal)}`,
    ...(turn.runId ? { runId: turn.runId } : {}),
    streamEpoch: turn.streamEpoch,
    ...(turn.turnOrdinal > 0 ? { turnOrdinal: turn.turnOrdinal } : {}),
  };
}

export function eventPhase(role: "intermediate" | "final" | undefined): "commentary" | "final_answer" | "unknown" {
  return role === "intermediate" ? "commentary" : role === "final" ? "final_answer" : "unknown";
}

/** Versioned product envelope. Body fields carry presentation data;
 * durable run identity, cursor and content revisions govern replay. */
export function versionedPayload(
  cwd: string,
  sessionId: string,
  payload: Record<string, unknown>,
  sequence: number,
  streamEpoch: string,
): Record<string, unknown> {
  const body = safeValue(payload);
  if (!body || typeof body !== "object" || Array.isArray(body)) return payload;
  const cleanBody = body as Record<string, unknown>;
  const turnId = typeof cleanBody.turnId === "string" && cleanBody.turnId ? cleanBody.turnId : null;
  const runId = typeof cleanBody.runId === "string" && cleanBody.runId ? cleanBody.runId : null;
  const authoritativeBody = { ...cleanBody, streamEpoch };
  const type = String(cleanBody.type ?? "runtime.event");
  // Every published record consumes a stream position, so every record carries
  // it. Records without turn/run identity (session stats, questionnaires) used
  // to ship a bare body; a consumer that cannot see their position then reads
  // each one as a hole in the sequence and answers with a full authoritative
  // rebase of a healthy stream.
  const envelope = {
    schemaVersion: 3,
    workspaceId: resolve(cwd),
    sessionId,
    streamEpoch,
    eventId: `${streamEpoch}:${sequence}`,
    seq: sequence,
    occurredAt: new Date().toISOString(),
    type,
  };
  if (!turnId || !runId) return { ...authoritativeBody, ...envelope };
  return {
    ...authoritativeBody,
    ...envelope,
    turnId,
    runId,
    payload: authoritativeBody,
  };
}

export function chunkTextPayload(payload: Record<string, unknown>): Record<string, unknown>[] {
  const type = String(payload.type ?? "");
  if (type !== "message.delta" && type !== "message.reasoning.delta") return [payload];
  if (typeof payload.text !== "string") return [payload];
  const chunks = splitUtf8(payload.text, MAX_TEXT_CHUNK_BYTES);
  if (chunks.length === 1) return [payload];
  return chunks.map((text, index) => {
    const chunk: Record<string, unknown> = { ...payload, text, chunkIndex: index, chunkCount: chunks.length };
    // A replacement applies only to the first chunk; following chunks append
    // to that replacement while retaining the original revision identity.
    if (index > 0 && chunk.replace === true) delete chunk.replace;
    return chunk;
  });
}

export function modelError(event: ProductInput): string | null {
  if (event.type !== "message.completed") return null;
  const message = (event.message && typeof event.message === "object" ? event.message : event) as Record<string, unknown>;
  const stopReason = String(message.stopReason ?? event.stopReason ?? "");
  const errorMessage = message.errorMessage ?? event.errorMessage;
  return stopReason === "error" || errorMessage ? String(errorMessage ?? "The model request failed") : null;
}

export function matchesWorkspace(key: string, cwd?: string): boolean {
  return !cwd || pathIsInside(resolve(cwd), key.split("\0")[0]!, true);
}
