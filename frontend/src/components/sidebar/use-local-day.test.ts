import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalDay } from "./use-local-day";
import { groupSessions } from "./WorkspaceSessionList";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 9, 23, 59, 59));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLocalDay", () => {
  it("moves an unchanged conversation from Today to Yesterday at local midnight", () => {
    const sessions = [{ id: "s1", cwd: "proj", name: "Study", updated_at: new Date(2026, 9, 9, 12).toISOString() }];
    const { result } = renderHook(() => groupSessions(sessions, "", new Date(useLocalDay())));
    expect(result.current[0].key).toBe("today");
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current[0].key).toBe("yesterday");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1_000));
    expect(result.current[0].key).toBe("week");
  });

  it("catches up when a suspended page becomes visible and reschedules midnight", () => {
    const { result } = renderHook(() => useLocalDay());
    vi.setSystemTime(new Date(2026, 9, 12, 15));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe(new Date(2026, 9, 12).getTime());
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(9 * 60 * 60 * 1_000));
    expect(result.current).toBe(new Date(2026, 9, 13).getTime());
  });

  it("removes its timer and visibility listener on unmount", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useLocalDay());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
