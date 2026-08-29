import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AutoResearchSnapshot, ResearchSseEvent } from "@pi-science/contracts";

const listeners = new Map<string, Set<(event: ResearchSseEvent) => void>>();

export function emitResearchEvent(cwd: string, snapshot: AutoResearchSnapshot, type: ResearchSseEvent["type"], data: Record<string, unknown> = {}, extra: Partial<ResearchSseEvent> = {}): void {
  const event: ResearchSseEvent = {
    id: `sse-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    type,
    timestamp: new Date().toISOString(),
    project_id: snapshot.project_id,
    ...(snapshot.origin_session_id ? { session_id: snapshot.origin_session_id } : {}),
    ...(snapshot.origin_message_id ? { message_id: snapshot.origin_message_id } : {}),
    research_id: snapshot.research_id,
    revision: snapshot.revision,
    data,
    ...extra,
  };
  for (const listener of [...(listeners.get(resolve(cwd)) ?? [])]) {
    try { listener(event); } catch { /* listener isolation */ }
  }
}

export function subscribeResearchEvents(cwd: string, listener: (event: ResearchSseEvent) => void): () => void {
  const key = resolve(cwd);
  const set = listeners.get(key) ?? new Set<(event: ResearchSseEvent) => void>();
  listeners.set(key, set); set.add(listener);
  return () => { set.delete(listener); if (set.size === 0) listeners.delete(key); };
}
