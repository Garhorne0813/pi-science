import { resolve } from "node:path";

export interface ResearchEvent { type: string; loop_id?: string; record_type?: string }

const listeners = new Map<string, Set<(event: ResearchEvent) => void>>();

export function emitResearchEvent(cwd: string, event: ResearchEvent): void {
  for (const listener of [...(listeners.get(resolve(cwd)) ?? [])]) {
    try { listener(event); } catch { /* a broken subscriber must never break the append path */ }
  }
}

export function subscribeResearchEvents(cwd: string, listener: (event: ResearchEvent) => void): () => void {
  const key = resolve(cwd);
  const set = listeners.get(key) ?? new Set<(event: ResearchEvent) => void>();
  listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}
