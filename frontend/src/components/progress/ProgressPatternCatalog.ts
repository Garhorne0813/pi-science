import type { ProgressAppearance } from "@pi-science/contracts";

export type ProgressSlot = keyof ProgressAppearance["patterns"];

export interface ProgressPatternDefinition {
  id: ProgressAppearance["patterns"][ProgressSlot];
  labelKey: string;
  source: "aicss" | "generative-loaders" | "pi-science";
  kind: "orb" | "inline" | "text" | "image" | "static";
  slots: ProgressSlot[];
}

const INLINE_SLOTS: ProgressSlot[] = ["thinking", "currentActivity", "waiting"];
const TEXT_SLOTS: ProgressSlot[] = ["streamingAnswer"];
const IMAGE_SLOTS: ProgressSlot[] = ["imageGeneration"];
const AICSS_ORB_NAMES = ["S1", "S2", "S3", "S4", "S5", "B1", "B2", "B3", "B4", "B5", "C1", "C2", "C3", "C4", "C5", "G1", "G2", "G3", "G4", "G5", "M1", "M2", "M3", "M4", "M5"] as const;

export const PROGRESS_PATTERN_CATALOG: ProgressPatternDefinition[] = [
  { id: "static-check", labelKey: "settings.progress.pattern.static", source: "pi-science", kind: "static", slots: ["thinking", "waiting", "completed"] },
  ...AICSS_ORB_NAMES.map((name): ProgressPatternDefinition => ({ id: `aicss-orb-${name}` as ProgressPatternDefinition["id"], labelKey: `settings.progress.pattern.aicss.${name}`, source: "aicss", kind: "orb", slots: INLINE_SLOTS })),
  ...(["glyph", "matrix", "orbit", "ripple", "signal", "spark", "rotor", "pixel-drift", "chomp", "snake", "fold", "gravity", "domino", "aperture"] as const).map((name): ProgressPatternDefinition => ({ id: `inline-${name}` as ProgressPatternDefinition["id"], labelKey: `settings.progress.pattern.${name}`, source: "generative-loaders", kind: "inline", slots: INLINE_SLOTS })),
  ...(["decode", "typewriter", "skeleton", "cascade", "focus", "wipe", "flip", "redact", "line", "terminal", "wave", "dissolve", "slice", "tracking", "coalesce", "fragments"] as const).map((name): ProgressPatternDefinition => ({ id: `text-${name}` as ProgressPatternDefinition["id"], labelKey: `settings.progress.pattern.${name}`, source: "generative-loaders", kind: "text", slots: TEXT_SLOTS })),
  ...(["skeleton", "bands", "tiles", "scan", "pixel-grid", "resolution", "focus", "shutter", "contour"] as const).map((name): ProgressPatternDefinition => ({ id: `image-${name}` as ProgressPatternDefinition["id"], labelKey: `settings.progress.pattern.${name}`, source: "generative-loaders", kind: "image", slots: IMAGE_SLOTS })),
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
