import { describe, expect, it } from "vitest";
import type { ExecutionRecord } from "@pi-science/contracts";
import { executionTimeline } from "./timeline";

function run(id: string, start?: number, end?: number, status: ExecutionRecord["status"] = "succeeded"): ExecutionRecord {
  return { schema_version: 1, execution_id: id, kind: "tool", surface: "pi", status,
    workspace_id: "/workspace", created_at: new Date(0).toISOString(), producer: "test", correlation: {},
    request: {}, result: {}, runtime: {}, files: { read: [], written: [] }, artifacts: [],
    started_at: start === undefined ? undefined : new Date(start).toISOString(),
    ended_at: end === undefined ? undefined : new Date(end).toISOString() };
}

describe("executionTimeline", () => {
  it("maps real timestamps on a common axis and preserves overlap", () => {
    const result = executionTimeline([run("a", 100, 200), run("b", 150, 300)]);
    expect(result).toMatchObject({ start: 100, end: 300 });
    expect(result.rows[0]).toMatchObject({ left: 0, width: 50, known: true });
    expect(result.rows[1]).toMatchObject({ left: 25, width: 75, known: true });
  });
  it("keeps zero durations exact and extends active records to now", () => {
    const result = executionTimeline([run("zero", 100, 100), run("active", 100, undefined, "running")], 500);
    expect(result.rows[0]).toMatchObject({ width: 0, known: true });
    expect(result.rows[1]).toMatchObject({ end: 500, width: 100, active: true });
  });
  it("does not fabricate missing, invalid, or backwards timing", () => {
    const result = executionTimeline([run("missing"), run("endless", 100), run("backwards", 200, 100),
      { ...run("invalid", 100, 200), started_at: "invalid" }], 500);
    expect(result.rows.every((row) => !row.known && row.width === 0)).toBe(true);
  });
});

it("uses real major/minor ticks and increases resolution with zoom", async () => {
  const { timelineTicks } = await import("./timeline");
  const fit = timelineTicks(0, 60_000);
  expect(timelineTicks(0, 53_000).filter((tick) => tick.major).length).toBeGreaterThanOrEqual(3);
  expect(fit.some((tick) => tick.major && tick.time === 30_000 && tick.left === 50)).toBe(true);
  expect(fit.some((tick) => !tick.major)).toBe(true);
  expect(timelineTicks(0, 60_000, 4).length).toBeGreaterThan(fit.length);
  expect(timelineTicks(0, 86_400_000 * 365).length).toBeLessThanOrEqual(200);
});


it("keeps active and long elapsed times readable without inventing an end", async () => {
  const { formatDuration } = await import("./run-formatters");
  const active = executionTimeline([run("active", 0, undefined, "running")], 5_500).rows[0]!;
  expect(formatDuration(active.end - active.start)).toBe("5.5 s");
  expect(active.run.ended_at).toBeUndefined();
  expect(formatDuration(48 * 3_600_000)).toBe("2d 0h");
  expect(formatDuration(Number.NaN)).toBe("—");
});
