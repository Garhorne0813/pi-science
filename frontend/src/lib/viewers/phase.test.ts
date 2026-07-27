import { describe, expect, it } from "vitest";
import { parsePhaseDiagram } from "./phase";

/** Li–O binary: the elements at zero formation energy, one deep stable line
 *  compound (Li2O) and one metastable phase (LiO2) sitting above the tie-line. */
const LI_O = JSON.stringify({
  elements: ["Li", "O"],
  entries: [
    { formula: "Li", composition: { Li: 1 }, formation_energy_per_atom: 0 },
    { formula: "O", composition: { O: 1 }, formation_energy_per_atom: 0 },
    { formula: "Li2O", composition: { Li: 2, O: 1 }, formation_energy_per_atom: -2.0 },
    { formula: "LiO2", composition: { Li: 1, O: 2 }, formation_energy_per_atom: -0.5 },
  ],
});

describe("parsePhaseDiagram", () => {
  it("maps compositions to hull coordinates and flags the stable phases", () => {
    const pd = parsePhaseDiagram(LI_O);
    expect(pd.elements).toEqual(["Li", "O"]);

    const byFormula = Object.fromEntries(pd.entries.map((e) => [e.formula, e]));
    expect(byFormula.Li.x).toBe(0);
    expect(byFormula.O.x).toBe(1);
    expect(byFormula.Li2O.x).toBeCloseTo(1 / 3, 10);
    expect(byFormula.LiO2.x).toBeCloseTo(2 / 3, 10);

    expect(byFormula.Li.stable).toBe(true);
    expect(byFormula.O.stable).toBe(true);
    expect(byFormula.Li2O.stable).toBe(true);
    expect(byFormula.LiO2.stable).toBe(false);

    expect(byFormula.Li2O.eAboveHull).toBe(0);
    expect(byFormula.LiO2.eAboveHull).toBeCloseTo(0.5, 2);
  });

  it("returns the lower-hull vertices sorted by composition", () => {
    const pd = parsePhaseDiagram(LI_O);
    expect(pd.hull.map((h) => h.formula)).toEqual(["Li", "Li2O", "O"]);
    expect(pd.hull.map((h) => h.x)).toEqual([...pd.hull.map((h) => h.x)].sort((a, b) => a - b));
  });

  it("treats a phase exactly on a tie-line as marginally stable", () => {
    // A–B with an intermediate whose energy lies exactly on the A–B line (y = 0).
    const collinear = JSON.stringify({
      elements: ["A", "B"],
      entries: [
        { formula: "A", composition: { A: 1 }, formation_energy_per_atom: 0 },
        { formula: "AB", composition: { A: 1, B: 1 }, formation_energy_per_atom: 0 },
        { formula: "B", composition: { B: 1 }, formation_energy_per_atom: 0 },
      ],
    });
    const pd = parsePhaseDiagram(collinear);
    expect(pd.entries.every((e) => e.stable)).toBe(true);
    // The monotone chain drops the collinear midpoint as a redundant vertex …
    expect(pd.hull.map((h) => h.formula)).toEqual(["A", "B"]);
    // … but stability is decided by energy-above-hull, so AB survives as stable.
    expect(pd.entries.find((e) => e.formula === "AB")?.eAboveHull).toBe(0);
  });

  it("throws a descriptive error instead of returning junk for malformed input", () => {
    expect(() => parsePhaseDiagram("{ not json")).toThrow(/not valid JSON/);
    expect(() => parsePhaseDiagram("")).toThrow(/not valid JSON/);
    expect(() =>
      parsePhaseDiagram(JSON.stringify({ elements: ["A", "B", "C"], entries: [] })),
    ).toThrow(/exactly 2 elements/);
    expect(() => parsePhaseDiagram(JSON.stringify({}))).toThrow(/exactly 2 elements/);
  });

  it("rejects a well-formed file with an empty entry list", () => {
    expect(() => parsePhaseDiagram(JSON.stringify({ elements: ["A", "B"], entries: [] }))).toThrow(
      /no entries/,
    );
  });
});
