import { describe, expect, it } from "vitest";
import { parseDoscar } from "./dos";

// VASP DOSCAR: 5 header lines, a control line `Emax Emin NEDOS Efermi weight`,
// then NEDOS total-DOS rows. Header lines below are shaped like a real file
// (natoms line, lattice constants, temperature, coordinate flag, system name).
const HEADER = [
  "    2    2    1    0",
  "  0.1000000E+01  0.5430000E-09  0.5430000E-09  0.5430000E-09",
  "  1.00000000000000E-004",
  "  CAR",
  "  Si2",
].join("\n");

/** 3-column TDOS rows: `E tdos itdos`. */
const NON_SPIN = [
  HEADER,
  "     5.00000000    -5.00000000       4     0.50000000  1.00000000",
  "  -5.000  0.000  0.000",
  "  -1.667  0.500  0.410",
  "   1.667  1.250  1.320",
  "   5.000  0.100  2.000",
].join("\n");

/** 5-column TDOS rows: `E tdos↑ tdos↓ itdos↑ itdos↓`. */
const SPIN = [
  HEADER,
  "     5.00000000    -5.00000000       3     0.25000000  1.00000000",
  "  -5.000  0.000  0.000  0.000  0.000",
  "   0.000  0.800  0.600  0.400  0.300",
  "   5.000  0.200  0.100  1.000  0.900",
].join("\n");

describe("parseDoscar", () => {
  it("parses a non-spin-polarized DOSCAR into energies and a single channel", () => {
    const dos = parseDoscar(NON_SPIN);
    expect(dos.spin).toBe(false);
    expect(dos.down).toBeUndefined();
    expect(dos.efermi).toBe(0.5);
    expect(dos.nedos).toBe(4);
    expect(dos.energies).toEqual([-5, -1.667, 1.667, 5]);
    expect(dos.up).toEqual([0, 0.5, 1.25, 0.1]);
  });

  it("splits the spin-up and spin-down channels of a 5-column DOSCAR", () => {
    const dos = parseDoscar(SPIN);
    expect(dos.spin).toBe(true);
    expect(dos.efermi).toBe(0.25);
    expect(dos.up).toEqual([0, 0.8, 0.2]);
    expect(dos.down).toEqual([0, 0.6, 0.1]);
  });

  it("throws a descriptive error instead of returning junk for malformed input", () => {
    expect(() => parseDoscar("")).toThrow(/too few lines/);
    expect(() => parseDoscar("not a doscar at all")).toThrow(/too few lines/);
    // Control line present but carrying fewer than 4 numbers.
    expect(() => parseDoscar([HEADER, "  5.0  -5.0", "  0 0 0", "  0 0 0"].join("\n"))).toThrow(
      /control line malformed/,
    );
    // NEDOS = 0 is structurally valid text but describes no data.
    expect(() =>
      parseDoscar([HEADER, "  5.0  -5.0  0  0.5  1.0", "  0 0 0", "  0 0 0"].join("\n")),
    ).toThrow(/NEDOS invalid/);
  });

  it("stops at the last present row when the file is truncated mid-DOS", () => {
    // Control line declares 4 rows; only 2 are present.
    const truncated = [
      HEADER,
      "     5.00000000    -5.00000000       4     0.50000000  1.00000000",
      "  -5.000  0.000  0.000",
      "   0.000  0.500  0.410",
    ].join("\n");
    const dos = parseDoscar(truncated);
    expect(dos.nedos).toBe(2);
    expect(dos.energies).toHaveLength(2);
    expect(dos.up).toHaveLength(2);
  });

  it("rejects a header-only file that declares rows it does not carry", () => {
    const headerOnly = [HEADER, "  5.0  -5.0  4  0.5  1.0", "", ""].join("\n");
    expect(() => parseDoscar(headerOnly)).toThrow(/no DOS rows/);
  });
});
