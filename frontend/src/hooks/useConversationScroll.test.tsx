import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { VirtuosoHandle } from "react-virtuoso";
import { useConversationScroll, type ConversationScrollOptions } from "./useConversationScroll";
import { useRuntimeStore } from "../lib/agent-runtime";
import type { ThreadBlock } from "../types/thread";

const CWD = "/workspace";
const SESSION_ID = "session-a";

function user(id: string, text = id): ThreadBlock {
  return { kind: "user", id, text };
}

function agent(id: string, text = id): ThreadBlock {
  return { kind: "agent", id, parts: [{ id: `${id}-part`, text }] };
}

function thread(blocks: ThreadBlock[]) {
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { blocks, index, loaded: true };
}

function setHistory(blocks: ThreadBlock[], cursor: string | null, hasMore: boolean) {
  useRuntimeStore.setState({
    cwd: CWD,
    activeSessionId: SESSION_ID,
    thread: thread(blocks),
    historyCursor: cursor,
    historyHasMore: hasMore,
    historyLoading: false,
  });
}

function options(loadOlderMessages: () => Promise<number>, focusedBlockId: string | null = null): ConversationScrollOptions {
  return {
    sessionId: SESSION_ID,
    workspaceCwd: CWD,
    activeSessionId: SESSION_ID,
    focusedBlockId,
    showRuns: false,
    working: false,
    blocks: useRuntimeStore.getState().thread.blocks,
    loadOlderMessages,
  };
}

beforeEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollBy = vi.fn();
  setHistory([user("u-latest"), agent("a-latest")], "cursor-latest", true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useConversationScroll follow output", () => {
  it("follows a second turn after collapse and delayed measurements, but respects browsing", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        (props: ConversationScrollOptions) => useConversationScroll(props),
        { initialProps: options(vi.fn(async () => 0)) },
      );
      const scroller = document.createElement("div");
      let height = 2_400;
      Object.defineProperties(scroller, {
        scrollHeight: { get: () => height },
        clientHeight: { value: 400 },
      });
      const scrollToIndex = vi.fn(() => { scroller.scrollTop = height - 400; });
      result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
      act(() => { result.current.attachScroller(scroller); vi.advanceTimersByTime(20); });
      expect(scroller.scrollTop).toBe(2_000);

      // Completion collapses the first turn, then the user browses its answer.
      height = 1_600;
      act(() => { result.current.handleListHeightChanged(); vi.advanceTimersByTime(20); });
      act(() => { scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 })); });
      scroller.scrollTop = 400;
      expect(result.current.followOutput()).toBe(false);

      // Sending happens before the next user block and virtual measurement.
      act(() => { result.current.startNewTurn(); });
      rerender({ ...options(vi.fn(async () => 0)), working: true, blocks: [user("u1"), agent("a1"), user("u2")] });
      height = 3_200;
      act(() => {
        scroller.dispatchEvent(new Event("scroll")); // stale layout event
        result.current.handleListHeightChanged();
        vi.advanceTimersByTime(20);
      });
      expect(scroller.scrollTop).toBe(2_800);
      expect(result.current.followOutput()).toBe("auto");

      // A fresh gesture cancels even a pin already queued by token growth.
      height = 3_600;
      act(() => {
        result.current.handleListHeightChanged();
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
        scroller.scrollTop = 2_400;
        vi.advanceTimersByTime(20);
      });
      expect(scroller.scrollTop).toBe(2_400);
      expect(result.current.followOutput()).toBe(false);
      expect(result.current.showScrollDown).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("starts a newly attached Virtuoso scroller at the latest turn", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const { result } = renderHook(() => useConversationScroll(options(vi.fn(async () => 0))));
    const scrollToIndex = vi.fn();
    result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_600 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    act(() => { result.current.attachScroller(scroller); });

    expect(scroller.scrollTop).toBe(0); // Virtuoso is the only scroll owner.
    expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" });
  });

  it("keeps follow output when a stale scroll event lags grown content", () => {
    const { result } = renderHook(() => useConversationScroll(options(vi.fn(async () => 0))));
    const scroller = document.createElement("div");
    let scrollTop = 1_200;
    let scrollHeight = 1_600;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; } },
    });

    act(() => { result.current.attachScroller(scroller); });

    // Streaming grew the content after the last pin; the browser then delivers
    // the pin's scroll event while the viewport lags far above the new bottom.
    // That lag must not be read as "user scrolled up".
    scrollHeight = 2_400;
    scrollTop = 1_220;
    act(() => { scroller.dispatchEvent(new Event("scroll")); });
    expect(result.current.showScrollDown).toBe(false);

    // An explicit upward scroll does leave follow mode.
    scrollTop = 800;
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.showScrollDown).toBe(true);
  });
});

describe("useConversationScroll history navigation", () => {
  it("loads older pages sequentially and keeps the virtual index aligned", async () => {
    let page = 0;
    const loadOlderMessages = vi.fn(async () => {
      if (page === 0) setHistory([user("u-middle"), agent("a-middle"), user("u-latest"), agent("a-latest")], "cursor-old", true);
      else setHistory([user("u-old"), agent("a-old"), user("u-middle"), agent("a-middle"), user("u-latest"), agent("a-latest")], null, false);
      page += 1;
      return 2;
    });
    const { result } = renderHook(() => useConversationScroll(options(loadOlderMessages)));

    act(() => { result.current.handleNavSelect("u-old"); });

    await waitFor(() => expect(loadOlderMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.virtualFirstItemIndex).toBe(99_998));
    expect(useRuntimeStore.getState().thread.blocks.map((block) => block.id)).toEqual([
      "u-old", "a-old", "u-middle", "a-middle", "u-latest", "a-latest",
    ]);
  });

  it("counts only prepended groups when live output arrives during a page load", async () => {
    let resolvePage!: (count: number) => void;
    const page = new Promise<number>((resolve) => { resolvePage = resolve; });
    const loadOlderMessages = vi.fn(() => page);
    const { result } = renderHook(() => useConversationScroll(options(loadOlderMessages)));

    act(() => { result.current.handleLoadOlder(); });
    await waitFor(() => expect(loadOlderMessages).toHaveBeenCalledTimes(1));

    act(() => {
      setHistory([
        user("u-old"), agent("a-old"), user("u-latest"), agent("a-latest"), agent("a-live"),
      ], "cursor-next", true);
      resolvePage(2);
    });

    await waitFor(() => expect(result.current.virtualFirstItemIndex).toBe(99_999));
  });

  it("shares a prepend between auto-load and navigation so the anchor moves once", async () => {
    let resolvePage!: (count: number) => void;
    const page = new Promise<number>((resolve) => { resolvePage = resolve; });
    const loadOlderMessages = vi.fn(() => page);
    const { result } = renderHook(() => useConversationScroll(options(loadOlderMessages)));

    act(() => {
      result.current.handleLoadOlder();
      result.current.handleNavSelect("u-old");
    });
    await waitFor(() => expect(loadOlderMessages).toHaveBeenCalledTimes(1));

    act(() => {
      setHistory([user("u-old"), agent("a-old"), user("u-latest"), agent("a-latest")], null, false);
      resolvePage(2);
    });

    await waitFor(() => expect(result.current.virtualFirstItemIndex).toBe(99_999));
    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it("lets the latest navigation cancel an older in-flight target", async () => {
    let resolveFirst!: (count: number) => void;
    let resolveSecond!: (count: number) => void;
    const firstPage = new Promise<number>((resolve) => { resolveFirst = resolve; });
    const secondPage = new Promise<number>((resolve) => { resolveSecond = resolve; });
    const loadOlderMessages = vi.fn()
      .mockImplementationOnce(() => firstPage)
      .mockImplementationOnce(() => secondPage);
    const scrollToIndex = vi.fn();
    const { result } = renderHook(() => useConversationScroll(options(loadOlderMessages)));
    result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;

    act(() => {
      result.current.handleNavSelect("u-a");
      result.current.handleNavSelect("u-b");
    });
    await waitFor(() => expect(loadOlderMessages).toHaveBeenCalledTimes(1));

    act(() => {
      setHistory([user("u-a"), agent("a-a"), user("u-latest"), agent("a-latest")], "cursor-second", true);
      resolveFirst(2);
    });
    await waitFor(() => expect(loadOlderMessages).toHaveBeenCalledTimes(2));

    act(() => {
      setHistory([
        user("u-a"), agent("a-a"), user("u-b"), agent("a-b"), user("u-latest"), agent("a-latest"),
      ], null, false);
      resolveSecond(2);
    });

    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(1));
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, align: "start", behavior: "auto" });
    expect(result.current.navigationLoading).toBe(false);
  });

  it("does not let a session switch apply an old navigation result", async () => {
    let resolvePage!: (count: number) => void;
    const page = new Promise<number>((resolve) => { resolvePage = resolve; });
    const loadOlderMessages = vi.fn(() => page);
    const { result, rerender } = renderHook(
      (currentOptions: ConversationScrollOptions) => useConversationScroll(currentOptions),
      { initialProps: options(loadOlderMessages) },
    );
    const scrollToIndex = vi.fn();
    result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;

    act(() => { result.current.handleNavSelect("u-old"); });
    await waitFor(() => expect(loadOlderMessages).toHaveBeenCalledTimes(1));

    setHistory([user("u-new"), agent("a-new")], "cursor-new", true);
    rerender({ ...options(loadOlderMessages), sessionId: "session-b", activeSessionId: "session-b" });
    act(() => { resolvePage(2); });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scrollToIndex.mock.calls.every(([target]) => target.index === "LAST")).toBe(true);
    expect(result.current.virtualFirstItemIndex).toBe(100_000);
  });
});
