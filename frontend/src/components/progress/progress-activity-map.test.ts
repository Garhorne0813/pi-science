import { describe, expect, it } from "vitest";
import { aicssOrbForActivity } from "./progress-activity-map";

describe("aicssOrbForActivity", () => {
  it.each([
    ["orient", "S1"],
    ["explore", "S4"],
    ["research", "B2"],
    ["analyze", "C4"],
    ["implementation", "B4"],
    ["compute", "G1"],
    ["verify", "C5"],
    ["generate", "B3"],
    ["interaction", "C2"],
    ["recover", "G4"],
    ["complete", "S5"],
  ] as const)("maps %s to %s", (state, variant) => {
    expect(aicssOrbForActivity("currentActivity", state)).toBe(variant);
  });

  it("always uses the listening orb while waiting", () => {
    expect(aicssOrbForActivity("waiting", "research")).toBe("C2");
  });
});
