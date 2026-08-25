// Schedule math characterization tests (docs §5, §14.2 rows: schedule/DST/misfire/timezone).
// Every expectation is a fixed UTC instant; no real clock, no sleep.
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ScheduledCronSchedule, ScheduledTaskSchedule } from "@pi-science/contracts";
import { ScheduledTaskError } from "./errors.js";
import {
  MISFIRE_GRACE_MS,
  advanceNextRunAt,
  businessDateFor,
  cronPreview,
  firstOccurrence,
  isValidTimezone,
  validateSchedule,
} from "./schedule.js";

const ms = (iso: string) => Date.parse(iso);

const hourly: ScheduledTaskSchedule = {
  type: "interval",
  every_seconds: 3600,
  anchor_at: "2026-08-25T00:00:00.000Z",
  timezone: "Asia/Shanghai",
};

const laCron = (expression: string): ScheduledCronSchedule => ({ type: "cron", expression, timezone: "America/Los_Angeles" });

function expectCode(fn: () => unknown, code: ScheduledTaskError["code"]) {
  try {
    fn();
    throw new Error(`expected ScheduledTaskError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduledTaskError);
    expect((error as ScheduledTaskError).code).toBe(code);
  }
}

describe("validateSchedule", () => {
  it("accepts once with offset, interval, and 5-field cron", () => {
    expect(validateSchedule({ type: "once", at: "2026-09-01T09:00:00+08:00", timezone: "Asia/Shanghai" })).toMatchObject({ type: "once" });
    expect(validateSchedule(hourly)).toMatchObject({ type: "interval", every_seconds: 3600 });
    expect(validateSchedule(laCron("30 2 * * *"))).toMatchObject({ type: "cron" });
    expect(validateSchedule({ type: "once", at: "2026-09-01T01:00:00Z", timezone: "UTC" })).toMatchObject({ type: "once" });
  });

  it("rejects once.at without Z or offset", () => {
    expectCode(() => validateSchedule({ type: "once", at: "2026-09-01T09:00:00", timezone: "Asia/Shanghai" }), "INVALID_SCHEDULE");
  });

  it("rejects sub-minute intervals below the 300s floor", () => {
    expectCode(
      () => validateSchedule({ type: "interval", every_seconds: 299, anchor_at: "2026-08-25T00:00:00.000Z", timezone: "UTC" }),
      "INVALID_SCHEDULE",
    );
  });

  it("rejects 6-field seconds cron and predefined names", () => {
    expectCode(() => validateSchedule({ type: "cron", expression: "0 9 * * * *", timezone: "UTC" }), "INVALID_SCHEDULE");
    expectCode(() => validateSchedule({ type: "cron", expression: "@daily", timezone: "UTC" }), "INVALID_SCHEDULE");
  });

  it("rejects expressions cron-parser cannot range-check", () => {
    expectCode(() => validateSchedule({ type: "cron", expression: "99 99 * * *", timezone: "UTC" }), "INVALID_SCHEDULE");
    expectCode(() => validateSchedule({ type: "cron", expression: "not a cron", timezone: "UTC" }), "INVALID_SCHEDULE");
  });

  it("rejects non-IANA timezones with INVALID_TIMEZONE", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("+08:00")).toBe(false);
    expectCode(() => validateSchedule({ type: "once", at: "2026-09-01T09:00:00Z", timezone: "Mars/Olympus" }), "INVALID_TIMEZONE");
  });

  it("rejects non-schedule payloads", () => {
    expectCode(() => validateSchedule({ type: "hourly" }), "INVALID_SCHEDULE");
    expectCode(() => validateSchedule("0 9 * * *"), "INVALID_SCHEDULE");
  });
});

describe("firstOccurrence — interval anchor grid", () => {
  it("walks the fixed anchor grid without drift regardless of claim latency", () => {
    const anchor = ms("2026-08-25T00:00:00.000Z");
    expect(firstOccurrence(hourly, anchor)).toBe(anchor + 3_600_000);
    // A 20-minute executor overrun must not shift the next occurrence.
    expect(firstOccurrence(hourly, anchor + 59 * 60_000)).toBe(anchor + 3_600_000);
    let cursor: number = anchor;
    for (let hour = 1; hour <= 5; hour++) {
      cursor = firstOccurrence(hourly, cursor)!;
      expect(cursor).toBe(anchor + hour * 3_600_000);
    }
  });

  it("starts at occurrence n=1 even when queried before the anchor", () => {
    expect(firstOccurrence(hourly, ms("2026-08-24T23:59:59.000Z"))).toBe(ms("2026-08-25T01:00:00.000Z"));
  });
});

describe("firstOccurrence — once", () => {
  const once: ScheduledTaskSchedule = { type: "once", at: "2026-09-01T01:00:00Z", timezone: "UTC" };
  it("returns at when strictly in the future and null otherwise", () => {
    expect(firstOccurrence(once, ms("2026-08-31T00:00:00Z"))).toBe(ms("2026-09-01T01:00:00.000Z"));
    expect(firstOccurrence(once, ms("2026-09-01T01:00:00.000Z"))).toBeNull();
    expect(firstOccurrence(once, ms("2026-09-02T00:00:00Z"))).toBeNull();
  });
});

describe("firstOccurrence — cron", () => {
  it("resolves 0 9 * * 1-5 in Asia/Shanghai to the correct UTC instant", () => {
    const weekdays: ScheduledCronSchedule = { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" };
    // Monday 2026-08-24 10:00 Asia/Shanghai → next run Tuesday 09:00 local = 01:00Z.
    expect(firstOccurrence(weekdays, ms("2026-08-24T02:00:00Z"))).toBe(ms("2026-08-25T01:00:00.000Z"));
    // Saturday query skips to Monday.
    expect(firstOccurrence(weekdays, ms("2026-08-29T01:00:00Z"))).toBe(ms("2026-08-31T01:00:00.000Z"));
  });

  it("pins DST spring forward: 30 2 Los Angeles 2026-03-08 lands at 03:30 PDT = 10:30Z", () => {
    const spring = laCron("30 2 * * *");
    expect(firstOccurrence(spring, ms("2026-03-06T20:00:00Z"))).toBe(ms("2026-03-07T10:30:00.000Z")); // PST −8
    expect(firstOccurrence(spring, ms("2026-03-07T10:30:00Z"))).toBe(ms("2026-03-08T10:30:00.000Z")); // 03:30 PDT −7
  });

  it("pins DST fall back: persisted chain consumes local 01:30 exactly once on 2026-11-01", () => {
    const fall = laCron("30 1 * * *");
    // Chain advance like the scheduler: each step queries strictly after the previous persisted value.
    const t0 = firstOccurrence(fall, ms("2026-10-30T12:00:00Z"));
    const t1 = firstOccurrence(fall, t0!);
    const t2 = firstOccurrence(fall, t1!);
    const t3 = firstOccurrence(fall, t2!);
    expect(t0).toBe(ms("2026-10-31T08:30:00.000Z"));
    expect(t1).toBe(ms("2026-11-01T08:30:00.000Z")); // first fold 01:30 PDT
    // The second fold (01:30 PST = 09:30Z on Nov 1) must never appear.
    expect(t2).toBe(ms("2026-11-02T09:30:00.000Z"));
    expect(t3).toBe(ms("2026-11-03T09:30:00.000Z"));
  });
});

describe("advanceNextRunAt — misfire policies", () => {
  it("returns none while next_run_at is still in the future", () => {
    const result = advanceNextRunAt(hourly, ms("2026-08-25T05:00:00.000Z"), ms("2026-08-25T04:00:00.000Z"), "coalesce_latest");
    expect(result).toEqual({ next_run_at: ms("2026-08-25T05:00:00.000Z"), missed: null, action: "none" });
  });

  it("reports due inside the grace window and keeps scheduled_for on the persisted point", () => {
    const currentNext = ms("2026-08-25T05:00:00.000Z");
    const withinGrace = advanceNextRunAt(hourly, currentNext, currentNext + 30_000, "coalesce_latest");
    expect(withinGrace.action).toBe("due");
    expect(withinGrace.missed).toBeNull();
    expect(withinGrace.next_run_at).toBe(currentNext + 3_600_000);
    // Grace boundary is inclusive (<= grace).
    const atBoundary = advanceNextRunAt(hourly, currentNext, currentNext + MISFIRE_GRACE_MS, "skip");
    expect(atBoundary.action).toBe("due");
  });

  it("coalesces multiple missed interval points into the latest one", () => {
    const currentNext = ms("2026-08-25T05:00:00.000Z");
    const result = advanceNextRunAt(hourly, currentNext, ms("2026-08-25T07:10:00.000Z"), "coalesce_latest");
    expect(result).toEqual({
      next_run_at: ms("2026-08-25T08:00:00.000Z"),
      missed: { from: currentNext, through: ms("2026-08-25T07:00:00.000Z") },
      action: "coalesce",
    });
  });

  it("skips with the same detected window under the skip policy", () => {
    const currentNext = ms("2026-08-25T05:00:00.000Z");
    const result = advanceNextRunAt(hourly, currentNext, ms("2026-08-25T07:10:00.000Z"), "skip");
    expect(result.action).toBe("skip");
    expect(result.missed).toEqual({ from: currentNext, through: ms("2026-08-25T07:00:00.000Z") });
    expect(result.next_run_at).toBe(ms("2026-08-25T08:00:00.000Z"));
  });

  it("handles once past its instant: window collapses to the single point and next_run_at ends", () => {
    const once: ScheduledTaskSchedule = { type: "once", at: "2026-08-25T05:00:00Z", timezone: "Asia/Shanghai" };
    const coalesced = advanceNextRunAt(once, ms("2026-08-25T05:00:00.000Z"), ms("2026-08-25T05:02:00.000Z"), "coalesce_latest");
    expect(coalesced.action).toBe("coalesce");
    expect(coalesced.missed).toEqual({ from: ms("2026-08-25T05:00:00.000Z"), through: ms("2026-08-25T05:00:00.000Z") });
    expect(coalesced.next_run_at).toBeNull(); // caller completes the task on claim
    const skipped = advanceNextRunAt(once, ms("2026-08-25T05:00:00.000Z"), ms("2026-08-25T06:00:00.000Z"), "skip");
    expect(skipped.action).toBe("skip");
    expect(skipped.next_run_at).toBeNull();
  });

  it("scans cron windows across days without replaying every point", () => {
    const daily: ScheduledCronSchedule = { type: "cron", expression: "0 9 * * *", timezone: "UTC" };
    const currentNext = ms("2026-08-24T09:00:00.000Z");
    const result = advanceNextRunAt(daily, currentNext, ms("2026-08-27T10:00:00.000Z"), "coalesce_latest");
    expect(result.missed).toEqual({ from: currentNext, through: ms("2026-08-27T09:00:00.000Z") });
    expect(result.next_run_at).toBe(ms("2026-08-28T09:00:00.000Z"));
  });

  it("supports injected grace windows", () => {
    const currentNext = ms("2026-08-25T05:00:00.000Z");
    expect(advanceNextRunAt(hourly, currentNext, currentNext + 120_000, "coalesce_latest").action).toBe("coalesce");
    expect(advanceNextRunAt(hourly, currentNext, currentNext + 120_000, "coalesce_latest", 300_000).action).toBe("due");
  });
});

describe("businessDateFor", () => {
  it("formats the task-timezone calendar date, independent of server zone", () => {
    const instant = ms("2026-08-25T20:30:00.000Z");
    expect(businessDateFor(instant, "Asia/Shanghai")).toBe("2026-08-26");
    expect(businessDateFor(instant, "UTC")).toBe("2026-08-25");
  });

  it("keeps the pre-transition local date during DST spring forward", () => {
    expect(businessDateFor(ms("2026-03-08T10:30:00.000Z"), "America/Los_Angeles")).toBe("2026-03-08");
  });

  it("rejects invalid timezones", () => {
    expect(() => businessDateFor(ms("2026-08-25T20:30:00.000Z"), "Mars/Olympus")).toThrow(ScheduledTaskError);
  });
});

describe("cronPreview", () => {
  it("pairs upcoming UTC instants with local wall clocks using the shared parser", () => {
    const entries = cronPreview(laCron("30 2 * * *"), 3, ms("2026-03-06T20:00:00Z"));
    expect(entries.map((entry) => entry.timestamp_ms)).toEqual([
      ms("2026-03-07T10:30:00.000Z"),
      ms("2026-03-08T10:30:00.000Z"),
      ms("2026-03-09T09:30:00.000Z"),
    ]);
    expect(entries.map((entry) => entry.utc)).toEqual([
      "2026-03-07T10:30:00.000Z",
      "2026-03-08T10:30:00.000Z",
      "2026-03-09T09:30:00.000Z",
    ]);
    expect(entries.map((entry) => entry.local)).toEqual(["2026-03-07 02:30", "2026-03-08 03:30", "2026-03-09 02:30"]);
  });

  it("matches the scheduler's chained firstOccurrence values", () => {
    const schedule = laCron("0 9 * * 1-5");
    const previewed = cronPreview(schedule, 3, ms("2026-08-24T02:00:00Z")).map((entry) => entry.timestamp_ms);
    let cursor = ms("2026-08-24T02:00:00Z");
    for (const expected of previewed) {
      const next = firstOccurrence(schedule, cursor)!;
      expect(next).toBe(expected);
      cursor = next;
    }
  });
});

describe("server timezone independence", () => {
  it("produces identical results regardless of process.env.TZ", () => {
    const baseline = {
      next: firstOccurrence(hourly, ms("2026-08-25T04:30:00.000Z")),
      shanghaiDate: businessDateFor(ms("2026-08-25T20:30:00.000Z"), "Asia/Shanghai"),
      spring: firstOccurrence(laCron("30 2 * * *"), ms("2026-03-07T10:30:00Z")),
      previewLocal: cronPreview(laCron("30 2 * * *"), 1, ms("2026-03-06T20:00:00Z"))[0]?.local,
    };
    vi.stubEnv("TZ", "Pacific/Kiritimati"); // UTC+14, maximally far from fixtures
    try {
      expect(firstOccurrence(hourly, ms("2026-08-25T04:30:00.000Z"))).toBe(baseline.next);
      expect(businessDateFor(ms("2026-08-25T20:30:00.000Z"), "Asia/Shanghai")).toBe(baseline.shanghaiDate);
      expect(firstOccurrence(laCron("30 2 * * *"), ms("2026-03-07T10:30:00Z"))).toBe(baseline.spring);
      expect(cronPreview(laCron("30 2 * * *"), 1, ms("2026-03-06T20:00:00Z"))[0]?.local).toBe(baseline.previewLocal);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps schedule math on plain millisecond numbers", () => {
    expectTypeOf(firstOccurrence(hourly, 0)).toEqualTypeOf<number | null>();
  });
});
