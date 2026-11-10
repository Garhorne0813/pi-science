import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tqdmProgressAdapter as adapter } from "./tqdm.js";

/** tqdm rewrites one line, so the harness cleaning turns its updates into one
 *  run of text with no separators between records. */
const glued =
  "  0%|          | 0/10 [00:00<?, ?it/s] 30%|███       | 3/10 [00:00<00:07,  1.30it/s]";

/** The cleaned stream of one real run whose bar used the caller's own unit:
 *  `tqdm(..., unit="file")` over 30 files. */
const fileRate = readFileSync(
  new URL("./__fixtures__/tqdm-file-rate.txt", import.meta.url),
  "utf8",
);

/** tqdm's default unit at a small size, glued the way the harness sees it. */
const iterationSample = Array.from({ length: 22 }, (_, index) => {
  const done = index + 1;
  const filled = Math.round((done / 22) * 10);
  const bar = `${"█".repeat(filled)}${" ".repeat(10 - filled)}`;
  return `${String(Math.round((done / 22) * 100)).padStart(3)}%|${bar}| ${done}/22 [00:01<00:0${done % 2}, 22.00it/s]`;
}).join("");

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

  it("reads a rate printed in the caller's own unit", () => {
    const observations = adapter.read(fileRate);
    expect(observations).toHaveLength(32);
    expect(observations.at(-1)).toEqual({
      scopeId: "bar:30",
      scopeLabel: "Processing files",
      current: 30,
      total: 30,
      totalKind: "fixed",
      unit: "file",
    });
  });

  it("keeps reading the default iteration bars", () => {
    const observations = adapter.read(iterationSample);
    expect(observations).toHaveLength(22);
    expect(observations.map((observation) => observation.unit)).toEqual(
      Array.from({ length: 22 }, () => "items"),
    );
    expect(observations.at(-1)).toMatchObject({ current: 22, total: 22, totalKind: "fixed" });
  });

  it("reads a rate written as seconds per unit", () => {
    expect(adapter.read(" 50%|█████     | 5/10 [00:01<00:01,  0.50s/it]").at(-1)).toMatchObject({
      current: 5,
      unit: "items",
    });
  });

  it("counts a unit rate when the bar has no total", () => {
    expect(adapter.read("  5file [00:02,  2.00file/s]")).toEqual([
      { scopeId: "count", scopeLabel: "Progress", current: 5, totalKind: "unknown", unit: "file" },
    ]);
  });

  it("still ignores brackets that carry no rate", () => {
    expect(adapter.read(" 50%|█████     | 5/10 [00:01<00:01]")).toEqual([]);
    expect(adapter.read("done 3/30")).toEqual([]);
    expect(adapter.read("  5file [00:02]")).toEqual([]);
  });
});
