import { describe, expect, it } from "vitest";
import { parseEigenval } from "./bands";

// VASP EIGENVAL: 5 header lines, a control line `NELECT NKPTS NBANDS`, then one
// block per k-point (blank line, `kx ky kz weight`, then NBANDS energy lines).
const HEADER = [
  "    2    2    1    1",
  "  0.1000000E+01  0.5430000E-09  0.5430000E-09  0.5430000E-09",
  "  1.00000000000000E-004",
  "  CAR",
  "  Si2",
].join("\n");

/** 2 k-points × 2 bands, non-spin-polarized (`idx energy occupancy`). */
const NON_SPIN = [
  HEADER,
  "     8     2     2",
  "",
  "  0.0000000E+00  0.0000000E+00  0.0000000E+00  0.5000000E+00",
  "   1     -5.500000   1.000000",
  "   2      2.500000   0.000000",
  "",
  "  0.5000000E+00  0.0000000E+00  0.0000000E+00  0.5000000E+00",
  "   1     -4.000000   1.000000",
  "   2      3.750000   0.000000",
].join("\n");

/** Spin-polarized: `idx Eup Edown occUp occDown` (5 columns). */
const SPIN = [
  HEADER,
  "     8     1     2",
  "",
  "  0.0000000E+00  0.0000000E+00  0.0000000E+00  1.0000000E+00",
  "   1     -5.500000  -5.250000   1.000000   1.000000",
  "   2      2.500000   2.750000   0.000000   0.000000",
].join("\n");

describe("parseEigenval", () => {
  it("parses k-points and per-band energies from a non-spin-polarized EIGENVAL", () => {
    const data = parseEigenval(NON_SPIN);
    expect(data.nkpts).toBe(2);
    expect(data.nbands).toBe(2);
    expect(data.spin).toBe(false);
    expect(data.bandsDown).toBeUndefined();
    expect(data.kpoints).toEqual([
      [0, 0, 0],
      [0.5, 0, 0],
    ]);
    expect(data.bands).toEqual([
      [-5.5, -4],
      [2.5, 3.75],
    ]);
    expect(data.eMin).toBe(-5.5);
    expect(data.eMax).toBe(3.75);
  });

  it("reads both spin channels when the energy lines carry 5 columns", () => {
    const data = parseEigenval(SPIN);
    expect(data.spin).toBe(true);
    expect(data.bands).toEqual([[-5.5], [2.5]]);
    expect(data.bandsDown).toEqual([[-5.25], [2.75]]);
    // The range spans both channels, not just spin-up.
    expect(data.eMin).toBe(-5.5);
    expect(data.eMax).toBe(2.75);
  });

  it("throws a descriptive error instead of returning junk for malformed input", () => {
    expect(() => parseEigenval("")).toThrow(/too few lines/);
    expect(() => parseEigenval("garbage\nlines\nonly")).toThrow(/too few lines/);
    // Control line carrying fewer than 3 numbers.
    expect(() => parseEigenval([HEADER, "     8", "", "  0 0 0 1", "  1  0.0  1.0"].join("\n"))).toThrow(
      /control line malformed/,
    );
    // NKPTS / NBANDS of zero describes no band structure.
    expect(() =>
      parseEigenval([HEADER, "     8     0     2", "", "  0 0 0 1", "  1  0.0  1.0"].join("\n")),
    ).toThrow(/NKPTS\/NBANDS invalid/);
  });

  it("reports the k-points actually present when the file is truncated", () => {
    // Control line declares 3 k-points; only the first block is present.
    const truncated = [
      HEADER,
      "     8     3     2",
      "",
      "  0.0000000E+00  0.0000000E+00  0.0000000E+00  0.3333333E+00",
      "   1     -5.500000   1.000000",
      "   2      2.500000   0.000000",
    ].join("\n");
    const data = parseEigenval(truncated);
    expect(data.nkpts).toBe(1);
    expect(data.kpoints).toEqual([[0, 0, 0]]);
    expect(data.bands).toEqual([[-5.5], [2.5]]);
  });

  it("rejects a header that declares k-points but carries no data blocks", () => {
    expect(() => parseEigenval([HEADER, "     8     2     2", ""].join("\n"))).toThrow(/no k-points/);
  });
});
