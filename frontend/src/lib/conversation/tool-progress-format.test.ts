import { describe, expect, it } from "vitest";
import { formatBytes } from "./tool-progress-format";

describe("formatBytes", () => {
  it.each([
    [1000, "1 KB"],
    [1500, "1.5 KB"],
    [10234, "10 KB"],
    [999999, "1 MB"],
    [2956984320, "3 GB"],
  ] as const)("formats %i as %s", (value, text) => {
    expect(formatBytes(value)).toBe(text);
  });

  it("keeps sub-kilobyte counts as whole bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("moves a value that rounds up to a thousand into the next unit", () => {
    expect(formatBytes(999_950)).toBe("1 MB");
    expect(formatBytes(1_999_999)).toBe("2 MB");
  });
});
