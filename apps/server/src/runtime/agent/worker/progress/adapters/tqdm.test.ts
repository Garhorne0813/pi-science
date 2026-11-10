import { describe, expect, it } from "vitest";
import { tqdmProgressAdapter as adapter } from "./tqdm.js";

/** tqdm rewrites one line, so the harness cleaning turns its updates into one
 *  run of text with no separators between records. */
const glued =
  "  0%|          | 0/10 [00:00<?, ?it/s] 30%|███       | 3/10 [00:00<00:07,  1.30it/s]";

describe("tqdmProgressAdapter", () => {
  it("reads the library counter out of a rewritten bar", () => {
    expect(adapter.read(glued)).toEqual([
      {
        scopeId: "bar:10",
        scopeLabel: "Progress",
        current: 0,
        total: 10,
        totalKind: "fixed",
        unit: "items",
      },
      {
        scopeId: "bar:10",
        scopeLabel: "Progress",
        current: 3,
        total: 10,
        totalKind: "fixed",
        unit: "items",
      },
    ]);
  });

  it("uses the bar description as the scope label", () => {
    expect(
      adapter.read("Processing:  50%|█████     | 5/10 [00:01<00:01,  5.00it/s]").at(-1)?.scopeLabel,
    ).toBe("Processing");
  });

  it("counts iterations when the bar has no total", () => {
    expect(adapter.read("  4it [00:02,  1.90it/s]")).toEqual([
      { scopeId: "count", scopeLabel: "Progress", current: 4, totalKind: "unknown", unit: "items" },
    ]);
  });

  it("ignores a bar with no rate field", () => {
    expect(adapter.read(" 50%|█████     | 5/10 [00:01<00:01]")).toEqual([]);
  });

  it("ignores a count above its own total", () => {
    expect(adapter.read(" 50%|█████     | 11/10 [00:01<00:00,  1.00it/s]")).toEqual([]);
  });

  it("reads the bar whatever program produced it", () => {
    expect(adapter.matches?.("rsync -a a b")).toBeUndefined();
  });
});
