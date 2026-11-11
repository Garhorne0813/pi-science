import { describe, expect, it } from "vitest";
import {
  mergeToolProgress,
  normalizeToolProgress,
  selectToolProgressDisplay,
  type ToolProgressV1,
} from "./tool-progress.js";

const progress = (overrides: Record<string, unknown> = {}) =>
  normalizeToolProgress({
    version: 1,
    scopeId: "process-files:1",
    scopeLabel: "Processing files",
    current: 72,
    total: 100,
    totalKind: "fixed",
    ...overrides,
  }) as ToolProgressV1;

describe("normalizeToolProgress", () => {
  it("accepts a fixed total inside its range", () => {
    expect(progress()).toMatchObject({
      scopeId: "process-files:1",
      scopeLabel: "Processing files",
      current: 72,
      total: 100,
      determinate: true,
    });
  });

  it("rejects a payload without a version or a named scope", () => {
    expect(normalizeToolProgress({ scopeId: "a", scopeLabel: "A", current: 1 })).toBeUndefined();
    expect(normalizeToolProgress({ version: 2, scopeId: "a", scopeLabel: "A" })).toBeUndefined();
    expect(normalizeToolProgress({ version: 1, scopeLabel: "A", current: 1 })).toBeUndefined();
    expect(normalizeToolProgress({ version: 1, scopeId: "a", scopeLabel: "   " })).toBeUndefined();
    expect(normalizeToolProgress("42%")).toBeUndefined();
    expect(normalizeToolProgress(undefined)).toBeUndefined();
  });

  it("drops a bad number instead of repairing it", () => {
    expect(progress({ total: 0 })).toMatchObject({ determinate: false });
    expect(progress({ total: Number.POSITIVE_INFINITY })).toMatchObject({ determinate: false });
    expect(progress({ current: -1 })).toMatchObject({ determinate: false });
    expect(progress({ current: 120 })).toMatchObject({ determinate: false });
    expect(progress({ current: Number.NaN })).toMatchObject({ determinate: false });
    expect(progress({ current: 120 }).current).toBe(120);
  });

  it("keeps a producer's share inside its own range and rejects the whole payload outside it", () => {
    expect(
      normalizeToolProgress({
        version: 1,
        scopeId: "a",
        scopeLabel: "A",
        determinate: true,
        percent: 50,
      }),
    ).toMatchObject({ determinate: false, percent: 50 });
    expect(
      normalizeToolProgress({ version: 1, scopeId: "a", scopeLabel: "A", percent: 140 }),
    ).toBeUndefined();
    expect(
      normalizeToolProgress({ version: 1, scopeId: "a", scopeLabel: "A", percent: -1 }),
    ).toBeUndefined();
  });

  it("suppresses the bar when the producer marks the work indeterminate", () => {
    expect(progress({ indeterminate: true })).toMatchObject({
      indeterminate: true,
      determinate: false,
    });
  });

  it("treats a dynamic total as unknown until the producer declares it fixed", () => {
    expect(progress({ totalKind: "reestimated" })).toMatchObject({ determinate: false });
    expect(progress({ totalKind: undefined })).toMatchObject({ determinate: false });
  });

  it("bounds the visible text so an external label cannot flood the UI", () => {
    const long = normalizeToolProgress({
      version: 1,
      scopeId: "scope",
      scopeLabel: "l".repeat(500),
      unit: "u".repeat(80),
      phase: "p".repeat(200),
      totalKind: "unknown",
    })!;
    expect(long.scopeId).toBe("scope");
    expect(long.scopeLabel).toHaveLength(100);
    expect(long.unit).toHaveLength(24);
    expect(long.phase).toHaveLength(64);
  });

  it("rejects an over-long scope identity instead of truncating it into another scope", () => {
    const shared = "s".repeat(64);
    expect(
      normalizeToolProgress({ version: 1, scopeId: shared, scopeLabel: "Reach" })?.scopeId,
    ).toBe(shared);
    expect(
      normalizeToolProgress({ version: 1, scopeId: `${shared}-a`, scopeLabel: "A", current: 5 }),
    ).toBeUndefined();
    expect(
      normalizeToolProgress({ version: 1, scopeId: `${shared}-b`, scopeLabel: "B", current: 1 }),
    ).toBeUndefined();
  });
});

describe("selectToolProgressDisplay", () => {
  it("shows a bar for a fixed scope with a current count", () => {
    expect(selectToolProgressDisplay("running", progress())).toMatchObject({
      mode: "determinate",
      current: 72,
      total: 100,
      percent: 72,
      scopeLabel: "Processing files",
    });
  });

  it("shows a count when there is no denominator", () => {
    expect(selectToolProgressDisplay("running", progress({ total: undefined }))).toEqual({
      mode: "count",
      value: 72,
      scopeLabel: "Processing files",
    });
  });

  it("draws a revisable total as an estimate and names it so in the text", () => {
    expect(
      selectToolProgressDisplay("running", progress({ current: 45, totalKind: "reestimated" })),
    ).toEqual({
      mode: "estimated",
      current: 45,
      total: 100,
      percent: 45,
      scopeLabel: "Processing files",
    });
    expect(
      selectToolProgressDisplay("running", progress({ current: 120, totalKind: "reestimated" })),
    ).toMatchObject({ mode: "count", value: 120 });
  });

  it("keeps a producer's own share without inventing a denominator", () => {
    expect(
      selectToolProgressDisplay(
        "running",
        normalizeToolProgress({
          version: 1,
          scopeId: "pv:percent",
          scopeLabel: "Transfer",
          percent: 45,
          totalKind: "unknown",
        }),
      ),
    ).toEqual({ mode: "percent", value: 45, scopeLabel: "Transfer" });
  });

  it("shows nothing numeric without progress", () => {
    expect(selectToolProgressDisplay("running", undefined)).toEqual({ mode: "indeterminate" });
  });

  it("keeps the phase wording without a number", () => {
    expect(
      selectToolProgressDisplay(
        "running",
        normalizeToolProgress({
          version: 1,
          scopeId: "a",
          scopeLabel: "A",
          label: "Screening",
          totalKind: "unknown",
        }),
      ),
    ).toEqual({ mode: "indeterminate", label: "Screening" });
  });

  it("keeps the last measurement after the tool settles", () => {
    for (const status of ["done", "error", "waiting-approval", "unknown"] as const) {
      expect(selectToolProgressDisplay(status, progress())).toMatchObject({
        mode: "determinate",
        current: 72,
        total: 100,
        percent: 72,
      });
    }
  });

  it("hides a settled row that never measured anything", () => {
    for (const status of ["done", "error", "waiting-approval", "unknown"] as const) {
      expect(selectToolProgressDisplay(status, undefined)).toEqual({ mode: "hidden" });
    }
  });

  it("never renders more than one hundred percent", () => {
    expect(
      selectToolProgressDisplay("running", progress({ current: 100, total: 100 })),
    ).toMatchObject({ percent: 100 });
    expect(selectToolProgressDisplay("running", progress({ current: 120 }))).toMatchObject({
      mode: "count",
    });
  });
});

describe("mergeToolProgress", () => {
  it("keeps the current value when an update carries no progress", () => {
    const first = progress();
    expect(mergeToolProgress(first, undefined)).toBe(first);
    expect(mergeToolProgress(undefined, first)).toBe(first);
  });

  it("ignores a lower count inside the same scope", () => {
    const merged = mergeToolProgress(progress({ current: 60 }), progress({ current: 40 }));
    expect(merged).toMatchObject({ current: 60, total: 100 });
  });

  it("keeps the newer wording when it rejects a lower count", () => {
    expect(
      mergeToolProgress(progress({ current: 60 }), progress({ current: 40, phase: "verify" })),
    ).toMatchObject({ current: 60, phase: "verify" });
  });

  it("restarts on a new scope and takes its label", () => {
    expect(
      mergeToolProgress(
        progress({ current: 80 }),
        progress({
          scopeId: "verify-files:1",
          scopeLabel: "Verifying files",
          current: 10,
          total: 100,
        }),
      ),
    ).toMatchObject({ scopeId: "verify-files:1", scopeLabel: "Verifying files", current: 10 });
  });

  it("keeps the measurement when an update inside the scope carries only wording", () => {
    const wording = normalizeToolProgress({
      version: 1,
      scopeId: "process-files:1",
      scopeLabel: "Processing files",
      phase: "validating",
    });
    expect(mergeToolProgress(progress({ current: 60, unit: "files" }), wording!)).toMatchObject({
      current: 60,
      total: 100,
      unit: "files",
      totalKind: "fixed",
      determinate: true,
      phase: "validating",
    });
  });

  it("never loses or rewinds the count across numeric, wording-only and numeric updates", () => {
    const first = mergeToolProgress(undefined, progress({ current: 60 }));
    const wording = mergeToolProgress(
      first,
      progress({ current: undefined, total: undefined, phase: "validating" }),
    );
    expect(wording).toMatchObject({ current: 60, determinate: true });
    expect(mergeToolProgress(wording, progress({ current: 70 }))).toMatchObject({
      current: 70,
      determinate: true,
    });
  });

  it("keeps two distinct full-length identities apart", () => {
    const first = progress({ scopeId: "a".repeat(64), current: 5 });
    expect(
      mergeToolProgress(first, progress({ scopeId: "b".repeat(64), current: 1 })),
    ).toMatchObject({ scopeId: "b".repeat(64), current: 1 });
  });

  it("draws a revisable total as an estimate and follows it to the newer total", () => {
    const first = progress({ current: 80, total: 100, totalKind: "reestimated" });
    const second = progress({ current: 90, total: 200, totalKind: "reestimated" });
    expect(selectToolProgressDisplay("running", first)).toEqual({
      mode: "estimated",
      current: 80,
      total: 100,
      percent: 80,
      scopeLabel: "Processing files",
    });
    expect(selectToolProgressDisplay("running", mergeToolProgress(first, second))).toEqual({
      mode: "estimated",
      current: 90,
      total: 200,
      percent: 45,
      scopeLabel: "Processing files",
    });
  });

  it("keeps a producer's share across a wording-only update", () => {
    const share = normalizeToolProgress({
      version: 1,
      scopeId: "pv:percent",
      scopeLabel: "Transfer",
      percent: 45,
      totalKind: "unknown",
    });
    const wording = normalizeToolProgress({
      version: 1,
      scopeId: "pv:percent",
      scopeLabel: "Transferring",
      totalKind: "unknown",
    });
    expect(mergeToolProgress(share, wording)).toMatchObject({
      scopeLabel: "Transferring",
      percent: 45,
    });
  });
});
