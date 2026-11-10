import { z } from "zod";

export const toolPresentationSchema = z.object({
  version: z.literal(1).default(1),
  kind: z.enum([
    "read",
    "search",
    "fetch",
    "edit",
    "execute",
    "compute",
    "verify",
    "artifact",
    "interaction",
    "system",
    "other",
  ]),
  title: z.string().min(1),
  description: z.string().optional(),
  importance: z.enum(["micro", "stage", "interrupt"]),
  domain: z.enum(["code", "research", "science", "document", "data", "generic"]),
  narrativeHint: z
    .object({
      state: z
        .enum(["explore", "research", "analyze", "implementation", "compute", "verify", "generate"])
        .optional(),
      finalVerification: z.boolean().optional(),
    })
    .optional(),
  locations: z
    .array(
      z.object({
        path: z.string().optional(),
        line: z.number().int().optional(),
        uri: z.string().optional(),
      }),
    )
    .optional(),
});
export type ToolPresentation = z.infer<typeof toolPresentationSchema>;

/** ── Progress appearance ──
 *  One pure data declaration per pattern: id, family and the slots it is
 *  legal for. Slot schemas, the id union and the frontend options list all
 *  derive from this table, so a pattern cannot be legal in one layer and
 *  rejected in another. React/adapters stay in the frontend. */

export const PROGRESS_SLOTS = [
  "thinking",
  "currentActivity",
  "streamingAnswer",
  "imageGeneration",
  "waiting",
  "completed",
] as const;
export type ProgressPatternSlot = (typeof PROGRESS_SLOTS)[number];
export const PROGRESS_PATTERN_FAMILIES = ["static", "orb", "inline", "text", "image"] as const;
export type ProgressPatternFamily = (typeof PROGRESS_PATTERN_FAMILIES)[number];

export interface ProgressPatternInfo {
  readonly id: string;
  readonly family: ProgressPatternFamily;
  readonly slots: readonly ProgressPatternSlot[];
}

const INLINE_SLOTS: readonly ProgressPatternSlot[] = ["thinking", "currentActivity", "waiting"];
const AICSS_ORB_IDS = [
  "aicss-orb-S1",
  "aicss-orb-S2",
  "aicss-orb-S3",
  "aicss-orb-S4",
  "aicss-orb-S5",
  "aicss-orb-B1",
  "aicss-orb-B2",
  "aicss-orb-B3",
  "aicss-orb-B4",
  "aicss-orb-B5",
  "aicss-orb-C1",
  "aicss-orb-C2",
  "aicss-orb-C3",
  "aicss-orb-C4",
  "aicss-orb-C5",
  "aicss-orb-G1",
  "aicss-orb-G2",
  "aicss-orb-G3",
  "aicss-orb-G4",
  "aicss-orb-G5",
  "aicss-orb-M1",
  "aicss-orb-M2",
  "aicss-orb-M3",
  "aicss-orb-M4",
  "aicss-orb-M5",
] as const;
const GENERATIVE_INLINE_IDS = [
  "inline-glyph",
  "inline-matrix",
  "inline-orbit",
  "inline-ripple",
  "inline-signal",
  "inline-spark",
  "inline-rotor",
  "inline-pixel-drift",
  "inline-chomp",
  "inline-snake",
  "inline-fold",
  "inline-gravity",
  "inline-domino",
  "inline-aperture",
] as const;
const GENERATIVE_TEXT_IDS = [
  "text-decode",
  "text-typewriter",
  "text-skeleton",
  "text-cascade",
  "text-focus",
  "text-wipe",
  "text-flip",
  "text-redact",
  "text-line",
  "text-terminal",
  "text-wave",
  "text-dissolve",
  "text-slice",
  "text-tracking",
  "text-coalesce",
  "text-fragments",
] as const;
const GENERATIVE_IMAGE_IDS = [
  "image-skeleton",
  "image-bands",
  "image-tiles",
  "image-scan",
  "image-pixel-grid",
  "image-resolution",
  "image-focus",
  "image-shutter",
  "image-contour",
] as const;

export const PROGRESS_PATTERNS: readonly ProgressPatternInfo[] = [
  { id: "static-check", family: "static", slots: ["thinking", "waiting", "completed"] },
  { id: "aicss-auto", family: "orb", slots: INLINE_SLOTS },
  ...AICSS_ORB_IDS.map((id) => ({ id, family: "orb" as const, slots: INLINE_SLOTS })),
  ...GENERATIVE_INLINE_IDS.map((id) => ({ id, family: "inline" as const, slots: INLINE_SLOTS })),
  ...GENERATIVE_TEXT_IDS.map((id) => ({
    id,
    family: "text" as const,
    slots: ["streamingAnswer" as const],
  })),
  ...GENERATIVE_IMAGE_IDS.map((id) => ({
    id,
    family: "image" as const,
    slots: ["imageGeneration" as const],
  })),
];

const PROGRESS_PATTERN_IDS = [
  "static-check",
  "aicss-auto",
  ...AICSS_ORB_IDS,
  ...GENERATIVE_INLINE_IDS,
  ...GENERATIVE_TEXT_IDS,
  ...GENERATIVE_IMAGE_IDS,
] as const;
export type ProgressPatternId = (typeof PROGRESS_PATTERN_IDS)[number];
export const progressPatternIdSchema = z.enum(PROGRESS_PATTERN_IDS);

function progressPatternForSlot(slot: ProgressPatternSlot) {
  const ids = PROGRESS_PATTERNS.filter((pattern) => pattern.slots.includes(slot)).map(
    (pattern) => pattern.id,
  );
  return z.enum(ids as [ProgressPatternId, ...ProgressPatternId[]]);
}

const DEFAULT_PATTERNS = {
  thinking: "aicss-auto",
  currentActivity: "aicss-auto",
  streamingAnswer: "text-decode",
  imageGeneration: "image-scan",
  waiting: "aicss-auto",
  completed: "static-check",
} as const;

function slotPatternSchema(slot: ProgressPatternSlot, tolerant: boolean) {
  const base = progressPatternForSlot(slot).default(DEFAULT_PATTERNS[slot]);
  return tolerant ? base.catch(DEFAULT_PATTERNS[slot]) : base;
}

function patternsSchema(tolerant: boolean) {
  return z
    .object({
      thinking: slotPatternSchema("thinking", tolerant),
      currentActivity: slotPatternSchema("currentActivity", tolerant),
      streamingAnswer: slotPatternSchema("streamingAnswer", tolerant),
      imageGeneration: slotPatternSchema("imageGeneration", tolerant),
      waiting: slotPatternSchema("waiting", tolerant),
      completed: slotPatternSchema("completed", tolerant),
    })
    .default(DEFAULT_PATTERNS);
}

const STRICT_COLOR = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable()
  .default(null);
const STRICT_SPEED = z.number().min(0.5).max(2).default(1);

/** Writes are strict: a bad slot value, an out-of-range speed, a malformed
 *  color or an unknown version is rejected instead of silently repaired. */
export const progressAppearanceInputSchema = z.object({
  version: z.literal(1).default(1),
  preset: z.enum(["quiet", "research", "science", "custom"]).default("quiet"),
  motion: z.enum(["system", "full", "off"]).default("system"),
  speed: STRICT_SPEED,
  colorMode: z.enum(["semantic", "custom"]).default("semantic"),
  customColor: STRICT_COLOR,
  patterns: patternsSchema(false),
});

/** Reads recover legacy or partially invalid storage through per-field
 *  fallbacks, so one bad field cannot discard the rest of the config. */
export const progressAppearanceSchema = progressAppearanceInputSchema.extend({
  version: z.literal(1).default(1).catch(1),
  speed: STRICT_SPEED.catch(1),
  // The color input emits six-digit hex; anything else falls back to the
  // semantic palette instead of invalidating the whole stored config.
  customColor: STRICT_COLOR.catch(null),
  patterns: patternsSchema(true),
});
export type ProgressAppearance = z.infer<typeof progressAppearanceSchema>;
export const defaultProgressAppearance: ProgressAppearance = progressAppearanceSchema.parse({});
