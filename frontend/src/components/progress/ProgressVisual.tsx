import { useEffect, useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import { ImageLoader, InlineLoader, TextLoader } from "generative-loaders";
import type { ProgressAppearance } from "@pi-science/contracts";
import { hydrateProgressAppearance, subscribeProgressAppearance, getProgressAppearance } from "./progress-settings-store";
import type { ProgressSlot } from "./ProgressPatternCatalog";
import { PROGRESS_PATTERN_CATALOG } from "./ProgressPatternCatalog";
import "generative-loaders/styles.css";

export function useProgressAppearance(): ProgressAppearance {
  useEffect(() => { void hydrateProgressAppearance(); }, []);
  return useSyncExternalStore(subscribeProgressAppearance, getProgressAppearance, getProgressAppearance);
}
const INLINE_VARIANTS = {
  "inline-glyph": "glyph", "inline-matrix": "matrix", "inline-orbit": "orbit", "inline-ripple": "ripple", "inline-signal": "signal", "inline-spark": "spark", "inline-rotor": "rotor", "inline-pixel-drift": "pixel-drift", "inline-chomp": "chomp", "inline-snake": "snake", "inline-fold": "fold", "inline-gravity": "gravity", "inline-domino": "domino", "inline-aperture": "aperture",
} as const;
const TEXT_VARIANTS = {
  "text-decode": "decode", "text-typewriter": "typewriter", "text-skeleton": "skeleton", "text-cascade": "cascade", "text-focus": "focus", "text-wipe": "wipe", "text-flip": "flip", "text-redact": "redact", "text-line": "line", "text-terminal": "terminal", "text-wave": "wave", "text-dissolve": "dissolve", "text-slice": "slice", "text-tracking": "tracking", "text-coalesce": "coalesce", "text-fragments": "fragments",
} as const;
const IMAGE_VARIANTS = {
  "image-skeleton": "skeleton", "image-bands": "bands", "image-tiles": "tiles", "image-scan": "scan", "image-pixel-grid": "pixel-grid", "image-resolution": "resolution", "image-focus": "focus", "image-shutter": "shutter", "image-contour": "contour",
} as const;

export function progressPatternShowsText(slot: ProgressSlot, config: ProgressAppearance): boolean {
  const pattern = config.patterns[slot];
  return PROGRESS_PATTERN_CATALOG.find((item) => item.id === pattern)?.kind === "text";
}

export function ProgressVisual({ slot, config, state = "running", text = "Generating response", compact = false }: { slot: ProgressSlot; config: ProgressAppearance; state?: "running" | "waiting" | "completed"; text?: string; compact?: boolean }) {
  const pattern = config.patterns[slot];
  const definition = PROGRESS_PATTERN_CATALOG.find((item) => item.id === pattern && item.slots.includes(slot)) ?? PROGRESS_PATTERN_CATALOG.find((item) => item.slots.includes(slot)) ?? PROGRESS_PATTERN_CATALOG[0];
  const paused = config.motion === "off" || (config.motion === "system" && typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const color = config.colorMode === "custom" && config.customColor ? config.customColor : "var(--color-accent)";
  const speed = Number.isFinite(config.speed) && config.speed > 0 ? config.speed : 1;

  const visualText = compact ? text.slice(0, 3) : text;
  if (state === "completed") return <Check size={14} aria-hidden className="shrink-0 text-ok-text" />;
  if (definition.kind === "static") return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />;
  if (definition.kind === "inline") {
    const variant = INLINE_VARIANTS[definition.id as keyof typeof INLINE_VARIANTS];
    return variant ? <InlineLoader variant={variant} size={compact ? "1rem" : "1.15rem"} speed={speed} color={color} paused={paused} label={slot === "waiting" ? text : undefined} /> : null;
  }
  if (definition.kind === "text") {
    const variant = TEXT_VARIANTS[definition.id as keyof typeof TEXT_VARIANTS];
    return variant ? <TextLoader text={visualText} variant={variant} speed={speed} color={color} paused={paused} aria-label={text} className={compact ? "h-7 w-16 overflow-hidden" : undefined} /> : null;
  }
  if (definition.kind === "image") {
    const variant = IMAGE_VARIANTS[definition.id as keyof typeof IMAGE_VARIANTS];
    return variant ? <ImageLoader variant={variant} speed={speed} color={color} paused={paused} size={compact ? "2rem" : "7rem"} radius={compact ? "0.25rem" : "0.5rem"} label={text} /> : null;
  }
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />;
}
