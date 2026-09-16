import type { ProgressSlot } from "./ProgressPatternCatalog";
import type { OrbVariant } from "./aicss/orbs";

export type ProgressActivityState = "orient" | "explore" | "research" | "analyze" | "implementation" | "compute" | "verify" | "generate" | "interaction" | "recover" | "error" | "complete";

const ORB_BY_STATE: Record<ProgressActivityState, OrbVariant> = {
  orient: "S1",
  explore: "S4",
  research: "B2",
  analyze: "C4",
  implementation: "B4",
  compute: "G1",
  verify: "C5",
  generate: "B3",
  interaction: "C2",
  recover: "G4",
  error: "B4",
  complete: "S5",
};

export function aicssOrbForActivity(slot: ProgressSlot, state?: ProgressActivityState): OrbVariant {
  if (slot === "waiting") return "C2";
  if (state) return ORB_BY_STATE[state];
  return "S1";
}
