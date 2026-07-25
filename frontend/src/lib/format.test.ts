import { describe, expect, it, vi } from "vitest";
import { timeAgo } from "./format";

describe("timeAgo", () => {
  it("formats recent, hourly, and daily timestamps consistently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00Z"));
    expect(timeAgo("2026-07-25T11:55:00Z")).toBe("5m ago");
    expect(timeAgo("2026-07-25T09:00:00Z")).toBe("3h ago");
    expect(timeAgo("2026-07-22T12:00:00Z")).toBe("3d ago");
    vi.useRealTimers();
  });
});
