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
    await waitFor(() => expect(result.current.virtualFirstItemIndex).toBe(99_996));
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

    await waitFor(() => expect(result.current.virtualFirstItemIndex).toBe(99_998));
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

    await waitFor(() => expect(result.current.virtualFirstItemIndex).toBe(99_998));
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
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, align: "start", behavior: "auto" });
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
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(result.current.virtualFirstItemIndex).toBe(100_000);
  });
});
