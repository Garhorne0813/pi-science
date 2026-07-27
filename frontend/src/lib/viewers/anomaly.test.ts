import { describe, expect, it } from "vitest";
import { divergingColor, parseAnomaly } from "./anomaly";

/** Long CSV shape: a header naming lat/lon/value, one row per grid cell. */
const LONG_CSV = [
  "# GISTEMP-style anomaly export, 2x2 cells",
  "lat,lon,anomaly",
  "-1.5,10,0.5",
  "-1.5,20,-0.5",
  "1.5,10,1.5",
  "1.5,20,-1.0",
].join("\n");

/** Labeled-grid shape: first row = longitudes after a corner cell, first column = latitudes. */
const LABEL_GRID = ["lat\\lon,10,20", "-1.5,0.5,-0.5", "1.5,1.5,-1.0"].join("\n");

describe("parseAnomaly", () => {
  it("parses a long CSV into an ascending lat/lon grid with a symmetric range", () => {
    const grid = parseAnomaly(LONG_CSV);
    expect(grid.lats).toEqual([-1.5, 1.5]);
    expect(grid.lons).toEqual([10, 20]);
    expect(grid.values).toEqual([
      [0.5, -0.5],
      [1.5, -1.0],
    ]);
    expect(grid.min).toBe(-1);
    expect(grid.max).toBe(1.5);
    expect(grid.absMax).toBe(1.5);
    expect(grid.unit).toBe("anomaly");
  });

  it("parses the labeled-grid shape to the same grid (without a unit label)", () => {
    const grid = parseAnomaly(LABEL_GRID);
    expect(grid.lats).toEqual([-1.5, 1.5]);
    expect(grid.lons).toEqual([10, 20]);
    expect(grid.values).toEqual([
      [0.5, -0.5],
      [1.5, -1.0],
    ]);
    expect(grid.unit).toBeUndefined();
  });

  it("leaves missing cells as NaN rather than collapsing the grid", () => {
    const sparse = ["lat,lon,value", "0,0,1", "0,10,2", "5,0,3"].join("\n");
    const grid = parseAnomaly(sparse);
    expect(grid.lats).toEqual([0, 5]);
    expect(grid.lons).toEqual([0, 10]);
    expect(grid.values[0]).toEqual([1, 2]);
    expect(grid.values[1][0]).toBe(3);
    expect(Number.isNaN(grid.values[1][1])).toBe(true);
  });

  it("throws a descriptive error instead of returning junk for malformed input", () => {
    expect(() => parseAnomaly("")).toThrow(/no grid data/);
    expect(() => parseAnomaly("lat,lon,value")).toThrow(/no grid data/);
    // Neither a lat/lon header nor numeric longitude labels.
    expect(() => parseAnomaly(["alpha,beta,gamma", "1,2,3"].join("\n"))).toThrow(
      /unrecognized anomaly format/,
    );
    // Correct header, but every value cell is non-numeric.
    expect(() => parseAnomaly(["lat,lon,value", "0,0,n/a", "0,10,n/a"].join("\n"))).toThrow(
      /no finite values/,
    );
  });

  it("ignores comment lines and blank lines", () => {
    const noisy = ["", "# a comment", "lat,lon,value", "", "0,0,1", "# trailing note", ""].join("\n");
    const grid = parseAnomaly(noisy);
    expect(grid.values).toEqual([[1]]);
  });
});

describe("divergingColor", () => {
  it("maps zero to white and the extremes to the blue/red stops", () => {
    expect(divergingColor(0)).toEqual([247, 247, 247]);
    expect(divergingColor(-1)).toEqual([33, 102, 172]);
    expect(divergingColor(1)).toEqual([178, 24, 43]);
  });

  it("clamps values outside [-1, 1] to the endpoint colors", () => {
    expect(divergingColor(9)).toEqual(divergingColor(1));
    expect(divergingColor(-9)).toEqual(divergingColor(-1));
  });
});
