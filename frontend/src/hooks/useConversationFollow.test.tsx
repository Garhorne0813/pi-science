import { act, cleanup, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useConversationFollow } from "./useConversationFollow";

function refs() {
  const scrollRef = { current: null } as RefObject<HTMLDivElement | null>;
  const scrollToIndex = vi.fn();
  const autoscrollToBottom = vi.fn();
  const virtuosoRef = {
    current: { scrollToIndex, autoscrollToBottom } as unknown as VirtuosoHandle,
  } as RefObject<VirtuosoHandle | null>;
  return { scrollRef, virtuosoRef, scrollToIndex, autoscrollToBottom };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useConversationFollow scroll ownership", () => {
  it("uses Virtuoso autoscroll for measured streaming growth instead of hard-pinning", () => {
    const { scrollRef, virtuosoRef, scrollToIndex, autoscrollToBottom } = refs();
    const { result } = renderHook(() => useConversationFollow({
      scrollRef,
      virtuosoRef,
      scope: "workspace:session-a",
      blocks: [],
      working: true,
    }));
    scrollToIndex.mockClear();
    autoscrollToBottom.mockClear();

    act(() => {
      result.current.handleListHeightChanged();
      result.current.handleListHeightChanged();
      result.current.handleListHeightChanged();
    });

    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(autoscrollToBottom).toHaveBeenCalledTimes(3);
  });

  it("does not move the viewport for measured growth after the user scrolls up", () => {
    const { scrollRef, virtuosoRef, scrollToIndex, autoscrollToBottom } = refs();
    const { result } = renderHook(() => useConversationFollow({
      scrollRef,
      virtuosoRef,
      scope: "workspace:session-a",
      blocks: [],
      working: true,
    }));
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, value: 400, writable: true },
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 500 },
    });
    act(() => { result.current.attachScroller(scroller); });
    scrollToIndex.mockClear();
    autoscrollToBottom.mockClear();

    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      result.current.handleListHeightChanged();
    });

    expect(result.current.followOutput()).toBe(false);
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(autoscrollToBottom).not.toHaveBeenCalled();
    expect(result.current.showScrollDown).toBe(true);
  });

  it("hard-pins once when following is explicitly resumed", () => {
    const { scrollRef, virtuosoRef, scrollToIndex, autoscrollToBottom } = refs();
    const { result } = renderHook(() => useConversationFollow({
      scrollRef,
      virtuosoRef,
      scope: "workspace:session-a",
      blocks: [],
      working: false,
    }));
    act(() => { result.current.pauseFollowing(); });
    scrollToIndex.mockClear();
    autoscrollToBottom.mockClear();

    act(() => { result.current.resumeFollowing(); });

    expect(result.current.followOutput()).toBe("auto");
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" });
    expect(autoscrollToBottom).not.toHaveBeenCalled();
  });
});
