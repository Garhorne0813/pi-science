import { apiRequest } from "../../lib/client/api";
import { defaultProgressAppearance, type ProgressAppearance } from "@pi-science/contracts";

let current = defaultProgressAppearance;
let hydration: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function hydrateProgressAppearance(): Promise<void> {
  if (!hydration) {
    hydration = apiRequest<{ progress_appearance?: ProgressAppearance }>("/api/settings/config")
      .then((data) => { if (data.progress_appearance) setProgressAppearance(data.progress_appearance); })
      .catch(() => undefined);
  }
  return hydration;
}

export function getProgressAppearance(): ProgressAppearance { return current; }
export function setProgressAppearance(next: ProgressAppearance): void {
  current = structuredClone(next);
  listeners.forEach((listener) => listener());
}
export function subscribeProgressAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
