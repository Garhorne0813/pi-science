import { describe, expect, it } from "vitest";
import { resolveWindow } from "./window.js";
import { settingsSchema } from "./schema.js";
const window = (
  timeZone = "Asia/Shanghai",
  start = "00:00",
  end = "06:00",
) => ({ enabled: true, start, end, timeZone });
describe("IANA execution windows", () => {
  it("uses a half-open local interval and never catches up outside it", () => {
    expect(
      resolveWindow(window(), Date.parse("2026-10-25T16:00:00Z")).allowed,
    ).toBe(true);
    expect(
      resolveWindow(window(), Date.parse("2026-10-25T22:00:00Z")).allowed,
    ).toBe(false);
  });
  it("anchors cross-midnight windows to their opening local date", () => {
    const a = resolveWindow(
      window("Asia/Shanghai", "22:00", "06:00"),
      Date.parse("2026-10-25T15:00Z"),
    );
    const b = resolveWindow(
      window("Asia/Shanghai", "22:00", "06:00"),
      Date.parse("2026-10-25T19:00Z"),
    );
    expect(a.allowed && b.allowed).toBe(true);
    expect(a.key).toBe(b.key);
    expect(b.windowStartLocalDate).toBe("2026-10-25");
  });
  it("resolves skipped and repeated DST boundaries with earliest start/latest end", () => {
    const spring = resolveWindow(
      window("America/Los_Angeles", "02:30", "04:00"),
      Date.parse("2026-03-08T10:00Z"),
    );
    expect(spring.start).toBe(Date.parse("2026-03-08T10:00Z"));
    const fall = resolveWindow(
      window("America/Los_Angeles", "01:00", "01:30"),
      Date.parse("2026-11-01T09:15Z"),
    );
    expect(fall.allowed).toBe(true);
    expect(fall.start).toBe(Date.parse("2026-11-01T08:00Z"));
    expect(fall.end).toBe(Date.parse("2026-11-01T09:30Z"));
  });
  it("rejects equal boundaries and invalid time zones; allows explicit all-day", () => {
    expect(() =>
      settingsSchema.parse({ dream: { allowedWindow: window("No/Zone") } }),
    ).toThrow();
    expect(() =>
      settingsSchema.parse({
        dream: { allowedWindow: window("UTC", "00:00", "00:00") },
      }),
    ).toThrow();
    expect(
      resolveWindow({ ...window(), enabled: false }, Date.now()).allowed,
    ).toBe(true);
  });
});
