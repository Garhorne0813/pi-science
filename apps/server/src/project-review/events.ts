import { resolve } from "node:path";

export interface ProjectKnowledgeEvent {
  type: "project-knowledge.changed";
  pending_count: number;
}

const listeners = new Map<string, Set<(event: ProjectKnowledgeEvent) => void>>();

export function emitProjectKnowledgeEvent(cwd: string, event: ProjectKnowledgeEvent): void {
  for (const listener of [...(listeners.get(resolve(cwd)) ?? [])]) {
    try { listener(event); } catch { /* a broken subscriber must never break the write path */ }
  }
}

export function subscribeProjectKnowledgeEvents(cwd: string, listener: (event: ProjectKnowledgeEvent) => void): () => void {
  const key = resolve(cwd);
  const set = listeners.get(key) ?? new Set<(event: ProjectKnowledgeEvent) => void>();
  listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}
