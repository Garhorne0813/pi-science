import type { ProgressAppearance } from "@pi-science/contracts";

export type ProgressSlot = keyof ProgressAppearance["patterns"];

export interface ProgressPatternDefinition {
  id: ProgressAppearance["patterns"][ProgressSlot];
  labelKey: string;
  source: "aicss" | "generative-loaders" | "pi-science";
  kind: "inline" | "text" | "image" | "static";
  slots: ProgressSlot[];
}

export const PROGRESS_PATTERN_CATALOG: ProgressPatternDefinition[] = [
  { id: "static-check", labelKey: "settings.progress.pattern.static", source: "pi-science", kind: "static", slots: ["thinking", "waiting", "completed"] },
  { id: "inline-signal", labelKey: "settings.progress.pattern.signal", source: "generative-loaders", kind: "inline", slots: ["currentActivity", "waiting"] },
  { id: "inline-spark", labelKey: "settings.progress.pattern.spark", source: "generative-loaders", kind: "inline", slots: ["currentActivity", "thinking"] },
  { id: "inline-ripple", labelKey: "settings.progress.pattern.ripple", source: "generative-loaders", kind: "inline", slots: ["currentActivity", "waiting"] },
  { id: "text-decode", labelKey: "settings.progress.pattern.decode", source: "generative-loaders", kind: "text", slots: ["streamingAnswer"] },
  { id: "text-cascade", labelKey: "settings.progress.pattern.cascade", source: "generative-loaders", kind: "text", slots: ["streamingAnswer"] },
  { id: "text-skeleton", labelKey: "settings.progress.pattern.skeleton", source: "generative-loaders", kind: "text", slots: ["streamingAnswer"] },
  { id: "image-scan", labelKey: "settings.progress.pattern.scan", source: "generative-loaders", kind: "image", slots: ["imageGeneration"] },
  { id: "image-tiles", labelKey: "settings.progress.pattern.tiles", source: "generative-loaders", kind: "image", slots: ["imageGeneration"] },
];

export function patternsForSlot(slot: ProgressSlot): ProgressPatternDefinition[] {
  return PROGRESS_PATTERN_CATALOG.filter((pattern) => pattern.slots.includes(slot));
}

export function normalizeProgressAppearance(config: ProgressAppearance): ProgressAppearance {
  const next = structuredClone(config);
  for (const slot of Object.keys(next.patterns) as ProgressSlot[]) {
    const options = patternsForSlot(slot);
    if (!options.some((pattern) => pattern.id === next.patterns[slot])) next.patterns[slot] = options[0].id;
  }
  return next;
}
