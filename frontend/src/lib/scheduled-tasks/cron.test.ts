import { describe, expect, it } from "vitest";
import { humanReadableCron, isValidCron, nextCronRuns } from "./cron";

describe("isValidCron", () => {
  it("accepts star, plain numbers, steps, lists and ranges in all five fields", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("0 * * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0,15,30,45 * * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("5 4 * * 0")).toBe(true);
    expect(isValidCron("30 2 * * *")).toBe(true);
    expect(isValidCron("0 0 1 * *")).toBe(true);
    expect(isValidCron("59 23 31 12 6")).toBe(true);
    expect(isValidCron("  0  9  *  *  1  ")).toBe(true);
  });

  it("rejects out-of-range fields", () => {
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("* 24 * * *")).toBe(false);
    expect(isValidCron("* * 0 * *")).toBe(false);
    expect(isValidCron("* * 32 * *")).toBe(false);
    expect(isValidCron("* * * 13 *")).toBe(false);
    expect(isValidCron("* * * * 7")).toBe(false);
    expect(isValidCron("* * * 0 *")).toBe(false);
    expect(isValidCron("0-59 * * * *")).toBe(true);
    expect(isValidCron("5-2 * * * *")).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("* * * * * *")).toBe(false);
    expect(isValidCron("a * * * *")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("*/ * * * *")).toBe(false);
    expect(isValidCron("1,,3 * * * *")).toBe(false);
    expect(isValidCron("1-2-3 * * * *")).toBe(false);
    expect(isValidCron("1.5 * * * *")).toBe(false);
    expect(isValidCron(null as unknown as string)).toBe(false);
  });
});

describe("nextCronRuns", () => {
  const from = new Date("2026-01-01T00:03:00.000Z");

  it("matches every minute for a wildcard schedule", () => {
    const runs = nextCronRuns("* * * * *", "UTC", 5, from);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-01-01T00:03:00.000Z",
      "2026-01-01T00:04:00.000Z",
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:06:00.000Z",
      "2026-01-01T00:07:00.000Z",
    ]);
  });

  it("matches step expressions and skips to the next step boundary", () => {
    const runs = nextCronRuns("*/5 * * * *", "UTC", 5, from);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:20:00.000Z",
      "2026-01-01T00:25:00.000Z",
    ]);
  });

  it("matches lists and ranges", () => {
    const listRuns = nextCronRuns("0,15,30,45 * * * *", "UTC", 2, new Date("2026-01-01T00:03:00.000Z"));
    expect(listRuns.map((d) => d.toISOString())).toEqual(["2026-01-01T00:15:00.000Z", "2026-01-01T00:30:00.000Z"]);

    const rangeRuns = nextCronRuns("0 9-11 * * *", "UTC", 2, new Date("2026-01-01T00:03:00.000Z"));
    expect(rangeRuns.map((d) => d.toISOString())).toEqual(["2026-01-01T09:00:00.000Z", "2026-01-01T10:00:00.000Z"]);
  });

  it("returns the requested count for a daily schedule", () => {
    const runs = nextCronRuns("0 9 * * *", "UTC", 5, new Date("2026-01-01T10:00:00.000Z"));
    expect(runs).toHaveLength(5);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-01-02T09:00:00.000Z",
      "2026-01-03T09:00:00.000Z",
      "2026-01-04T09:00:00.000Z",
      "2026-01-05T09:00:00.000Z",
      "2026-01-06T09:00:00.000Z",
    ]);
  });

  it("skips weekends for a weekday schedule", () => {
    // 2026-01-03 is a Saturday, 2026-01-05 is the following Monday.
    const runs = nextCronRuns("0 9 * * 1-5", "UTC", 2, new Date("2026-01-03T10:00:00.000Z"));
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-01-05T09:00:00.000Z", "2026-01-06T09:00:00.000Z"]);
  });

  it("honors a single weekday", () => {
    // 2026-01-05 is a Monday; 08:00 is still before the 09:00 trigger.
    const runs = nextCronRuns("0 9 * * 1", "UTC", 2, new Date("2026-01-05T08:00:00.000Z"));
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-01-05T09:00:00.000Z", "2026-01-12T09:00:00.000Z"]);
  });

  it("returns the next month boundary for a monthly schedule", () => {
    const runs = nextCronRuns("0 0 1 * *", "UTC", 1, new Date("2026-01-02T00:00:00.000Z"));
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-02-01T00:00:00.000Z"]);
  });

  it("accepts a timezone argument without changing the UTC-approximated result", () => {
    const runs = nextCronRuns("0 9 * * *", "Asia/Shanghai", 1, new Date("2026-01-01T10:00:00.000Z"));
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-01-02T09:00:00.000Z"]);
  });

  it("returns an empty list for invalid cron or non-positive counts", () => {
    expect(nextCronRuns("not a cron", "UTC", 5, from)).toEqual([]);
    expect(nextCronRuns("* * * * *", "UTC", 0, from)).toEqual([]);
  });
});

describe("humanReadableCron", () => {
  it("describes common combinations", () => {
    expect(humanReadableCron("* * * * *")).toBe("每分钟");
    expect(humanReadableCron("0 * * * *")).toBe("每小时");
    expect(humanReadableCron("0 9 * * *")).toBe("每天 09:00");
    expect(humanReadableCron("0 9 * * 1-5")).toBe("每周一至周五 09:00");
    expect(humanReadableCron("0 9 * * 1")).toBe("每周一 09:00");
    expect(humanReadableCron("0 0 1 * *")).toBe("每月 1 日 00:00");
  });

  it("generalizes to other hours, weekdays and month days", () => {
    expect(humanReadableCron("0 13 * * *")).toBe("每天 13:00");
    expect(humanReadableCron("0 9 * * 0")).toBe("每周日 09:00");
    expect(humanReadableCron("0 18 * * 5")).toBe("每周五 18:00");
    expect(humanReadableCron("0 8 15 * *")).toBe("每月 15 日 08:00");
  });

  it("returns the raw expression for unknown combinations", () => {
    expect(humanReadableCron("*/5 * * * *")).toBe("*/5 * * * *");
    expect(humanReadableCron("0 9 1 * 1")).toBe("0 9 1 * 1");
    expect(humanReadableCron("not a cron")).toBe("not a cron");
    expect(humanReadableCron("")).toBe("");
  });
});
