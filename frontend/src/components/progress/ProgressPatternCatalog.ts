import { PROGRESS_PATTERNS, defaultProgressAppearance, type ProgressAppearance, type ProgressPatternFamily } from "@pi-science/contracts";

export type ProgressSlot = keyof ProgressAppearance["patterns"];

export interface ProgressPatternDefinition {
  id: ProgressAppearance["patterns"][ProgressSlot];
  labelKey: string;
  source: "aicss" | "generative-loaders" | "pi-science";
  kind: "orb" | "inline" | "text" | "image" | "static";
  slots: ProgressSlot[];
}

const FAMILY_SOURCE: Record<ProgressPatternFamily, ProgressPatternDefinition["source"]> = {
  static: "pi-science",
  orb: "aicss",
  inline: "generative-loaders",
  text: "generative-loaders",
  image: "generative-loaders",
};

function labelKeyFor(id: string): string {
  if (id === "static-check") return "settings.progress.pattern.static";
  const suffix = id.replace(/^(?:aicss-orb-|inline-|text-|image-)/, "");
  if (id.startsWith("aicss")) return `settings.progress.pattern.aicss.${suffix}`;
  return `settings.progress.pattern.${suffix}`;
}

/** Derived from the contracts pattern table — the same source the server
 *  validates slot values against. Display metadata (labels, adapters) stays
 *  here in the frontend. */
export const PROGRESS_PATTERN_CATALOG: ProgressPatternDefinition[] = PROGRESS_PATTERNS.map((pattern) => ({
  id: pattern.id as ProgressPatternDefinition["id"],
  labelKey: labelKeyFor(pattern.id),
  source: FAMILY_SOURCE[pattern.family],
  kind: pattern.family,
  slots: [...pattern.slots],
}));

export function patternsForSlot(slot: ProgressSlot): ProgressPatternDefinition[] {
  return PROGRESS_PATTERN_CATALOG.filter((pattern) => pattern.slots.includes(slot));
}

/** Input validation only: an illegal slot value falls back to the slot
 *  default. Legal explicit choices are never rewritten — migration of old
 *  shapes is a separate, versioned concern, not a guess from a legal value. */
export function normalizeProgressAppearance(config: ProgressAppearance): ProgressAppearance {
  const next = structuredClone(config);
  for (const slot of Object.keys(next.patterns) as ProgressSlot[]) {
    const options = patternsForSlot(slot);
    if (!options.some((pattern) => pattern.id === next.patterns[slot])) next.patterns[slot] = defaultProgressAppearance.patterns[slot];
  }
  return next;
}
