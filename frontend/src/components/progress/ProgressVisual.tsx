import { lazy, Suspense, useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { Orb } from "./aicss/orbs";
import type { ProgressAppearance } from "@pi-science/contracts";
import { hydrateProgressAppearance, subscribeProgressAppearance, getProgressAppearance } from "./progress-settings-store";
import type { ProgressSlot } from "./ProgressPatternCatalog";
import { PROGRESS_PATTERN_CATALOG } from "./ProgressPatternCatalog";
import { aicssOrbForActivity, type ProgressActivityState } from "./progress-activity-map";

const GenerativeProgressVisual = lazy(() => import("./GenerativeProgressVisual"));

export function useProgressAppearance(): ProgressAppearance {
  useEffect(() => { void hydrateProgressAppearance(); }, []);
  return useSyncExternalStore(subscribeProgressAppearance, getProgressAppearance, getProgressAppearance);
}
const AICSS_ORB_VARIANTS = Object.fromEntries(["S1", "S2", "S3", "S4", "S5", "B1", "B2", "B3", "B4", "B5", "C1", "C2", "C3", "C4", "C5", "G1", "G2", "G3", "G4", "G5", "M1", "M2", "M3", "M4", "M5"].map((name) => [`aicss-orb-${name}`, name])) as Record<string, import("./aicss/orbs").OrbVariant>;

export function progressPatternShowsText(slot: ProgressSlot, config: ProgressAppearance): boolean {
  const pattern = config.patterns[slot];
  return PROGRESS_PATTERN_CATALOG.find((item) => item.id === pattern)?.kind === "text";
}

export function ProgressVisual({ slot, config, state = "running", activityState, text = "Generating response", compact = false }: { slot: ProgressSlot; config: ProgressAppearance; state?: "running" | "waiting" | "completed"; activityState?: ProgressActivityState; text?: string; compact?: boolean }) {
  const pattern = config.patterns[slot];
  const definition = PROGRESS_PATTERN_CATALOG.find((item) => item.id === pattern && item.slots.includes(slot)) ?? PROGRESS_PATTERN_CATALOG.find((item) => item.slots.includes(slot)) ?? PROGRESS_PATTERN_CATALOG[0];
  const paused = config.motion === "off" || (config.motion === "system" && typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const color = config.colorMode === "custom" && config.customColor ? config.customColor : "var(--accent)";
  const speed = Number.isFinite(config.speed) && config.speed > 0 ? config.speed : 1;

  if (state === "completed") return <Check size={14} aria-hidden className="shrink-0 text-ok-text" />;
  if (definition.kind === "static") return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />;
  if (definition.kind === "orb") {
    const variant = definition.id === "aicss-auto" ? aicssOrbForActivity(slot, activityState) : AICSS_ORB_VARIANTS[definition.id];
    return variant ? <Orb variant={variant} size={compact ? 16 : 20} paused={paused} style={{ "--orb-fg": color } as CSSProperties} /> : null;
  }
  return (
    <Suspense fallback={<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}>
      <GenerativeProgressVisual definition={definition} slot={slot} speed={speed} color={color} paused={paused} text={text} compact={compact} />
    </Suspense>
  );
}
