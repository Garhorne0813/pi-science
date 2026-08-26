import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { groupBlocks } from "../components/conversation/ConversationBlocks";
import type { ConversationNavItem } from "../components/conversation/ConversationNavRail";
import { useRuntimeStore } from "../lib/agent-runtime";
import type { ThreadBlock } from "../types/thread";

export interface ConversationScrollOptions {
  sessionId?: string;
  workspaceCwd: string;
  activeSessionId: string | null;
  focusedBlockId: string | null;
  showRuns: boolean;
  working: boolean;
  blocks: ThreadBlock[];
  blockGroups: ThreadBlock[][];
  userNavItems: ConversationNavItem[];
  historyHasMore: boolean;
  historyLoading: boolean;
  loadOlderMessages: () => Promise<number>;
  loadMessagesForNavigation: (before: string) => Promise<number>;
}

export interface ConversationScrollController {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  showScrollDown: boolean;
  virtualFirstItemIndex: number;
  attachScroller: (element: Window | HTMLElement | null) => void;
  handleLoadOlder: () => Promise<void>;
  handleNavSelect: (id: string) => void;
  scrollToBottom: () => void;
  startNewTurn: () => void;
}

/**
 * Owns the conversation viewport lifecycle: follow-output, virtual-list
 * anchoring, history loading, and focus navigation. Keeping this state out of
 * the page component prevents token streaming from coupling route concerns to
 * DOM correction timers.
 */
export function useConversationScroll(options: ConversationScrollOptions): ConversationScrollController {
  const {
    sessionId,
    workspaceCwd,
    activeSessionId,
    focusedBlockId,
    showRuns,
    working,
    blocks,
    blockGroups,
    userNavItems,
    historyHasMore,
    historyLoading,
    loadOlderMessages,
    loadMessagesForNavigation,
  } = options;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const followOutputRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [virtualFirstItemIndex, setVirtualFirstItemIndex] = useState(100_000);
  const scrollTimersRef = useRef<number[]>([]);
  const followOutputCancelRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(sessionId);
  const locatedFocusRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    return () => {
      for (const handle of scrollTimersRef.current) window.clearTimeout(handle);
      scrollTimersRef.current = [];
    };
  }, []);

  // A new session (or a reconnect) starts at the bottom: never inherit the
  // "user scrolled up" state of the previous session on this route.
  useEffect(() => {
    followOutputRef.current = true;
    setShowScrollDown(false);
    setVirtualFirstItemIndex(100_000);
  }, [sessionId, workspaceCwd]);

  const handleThreadScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
    followOutputRef.current = nearBottom;
    setShowScrollDown(!nearBottom);
  }, []);

  const attachScroller = useCallback((element: Window | HTMLElement | null) => {
    if (scrollRef.current) scrollRef.current.removeEventListener("scroll", handleThreadScroll);
    scrollRef.current = element instanceof HTMLElement ? element as HTMLDivElement : null;
    if (scrollRef.current) {
      // Keep the stable class hook used by the conversation rail and by
      // integrations that locate the active conversation scroller.
      scrollRef.current.classList.add("conversation-scroller", "overflow-y-auto");
      scrollRef.current.addEventListener("scroll", handleThreadScroll);
    }
  }, [handleThreadScroll]);

  const scheduleFollowOutput = useCallback(() => {
    if (followOutputCancelRef.current) return;
    const apply = () => {
      followOutputCancelRef.current = null;
      if (!followOutputRef.current) return;
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    };
    if (typeof window.requestAnimationFrame === "function") {
      const frame = window.requestAnimationFrame(apply);
      followOutputCancelRef.current = () => window.cancelAnimationFrame(frame);
    } else {
      // Keep jsdom/tests deterministic; browsers use the frame-coalesced path.
      apply();
    }
  }, []);

  useEffect(() => {
    if (followOutputRef.current) scheduleFollowOutput();
  }, [scheduleFollowOutput, blocks]);

  useEffect(() => () => {
    followOutputCancelRef.current?.();
    followOutputCancelRef.current = null;
  }, []);

  // When a new turn starts (user sends a message or the agent resumes), snap
  // the view back to the newest content. The user may have scrolled up to read
  // history; sending a message — or receiving live output — must always bring
  // the latest message into view instead of leaving the thread pinned to the
  // old position.
  const wasWorking = useRef(false);
  useEffect(() => {
    if (working && !wasWorking.current) {
      // Only snap to the bottom on a NEW turn if the user is not deliberately
      // reading history (followOutputRef stays false after a nav click).
      if (followOutputRef.current === false) return;
      followOutputRef.current = true;
      setShowScrollDown(false);
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    }
    wasWorking.current = working;
  }, [working]);

  const handleLoadOlder = useCallback(async () => {
    if (!historyHasMore || historyLoading) return;
    const previousGroupCount = blockGroups.length;
    const loadedMessages = await loadOlderMessages();
    if (!loadedMessages) return;
    const nextGroupCount = groupBlocks(useRuntimeStore.getState().thread.blocks).length;
    const addedGroups = Math.max(0, nextGroupCount - previousGroupCount);
    if (addedGroups > 0) setVirtualFirstItemIndex((current) => current - addedGroups);
  }, [blockGroups.length, historyHasMore, historyLoading, loadOlderMessages]);

  const smoothScroll = useCallback(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  // Runs fn after `delay` only while the page still shows the same session;
  // every pending handle is tracked so newer interactions/unmount can cancel.
  const scheduleSessionScoped = useCallback((fn: () => void, delay: number) => {
    const scheduledSession = sessionRef.current;
    const handle = window.setTimeout(() => {
      if (sessionRef.current !== scheduledSession) return;
      fn();
    }, delay);
    scrollTimersRef.current.push(handle);
  }, []);

  const cancelPendingScrollTimers = useCallback(() => {
    for (const handle of scrollTimersRef.current) window.clearTimeout(handle);
    scrollTimersRef.current = [];
  }, []);

  const threadBlockElement = useCallback((id: string) => {
    const userMessage = document.getElementById(`user-msg-${id}`);
    if (userMessage) return userMessage;
    return Array.from(document.querySelectorAll<HTMLElement>("[data-thread-block-ids]"))
      .find((element) => element.dataset.threadBlockIds?.split(" ").includes(id)) ?? null;
  }, []);

  const highlightThreadBlock = useCallback((id: string) => {
    const target = threadBlockElement(id);
    if (!target) return;
    target.classList.add("execution-focus-highlight");
    scheduleSessionScoped(() => target.classList.remove("execution-focus-highlight"), 2_400);
  }, [scheduleSessionScoped, threadBlockElement]);

  const scrollToLoadedTarget = useCallback((id: string, highlight = false) => {
    const scrollToExact = () => {
      const target = threadBlockElement(id);
      if (!target) return false;
      // Instant positioning (behavior "auto"): a smooth animation would race
      // the getBoundingClientRect offset check below.
      target.scrollIntoView({ behavior: "auto", block: "start" });
      return true;
    };
    // Fast path: the target is already mounted and Virtuoso's native layout
    // can honor a direct scroll (recent messages, short threads). Check the
    // result: if the target is not near the viewport top afterwards, fall
    // through to the Virtuoso scrollToIndex path (virtualized lists position
    // items absolutely, so a native scrollIntoView can land mid-list).
    const scrollerNow = scrollRef.current;
    const beforeTop = scrollerNow?.scrollTop ?? -1;
    if (scrollToExact() && scrollerNow) {
      const target = threadBlockElement(id);
      if (target) {
        const r = target.getBoundingClientRect();
        const vr = scrollerNow.getBoundingClientRect();
        const offset = r.top - vr.top;
        if (offset >= -20 && offset < 300) {
          if (highlight) highlightThreadBlock(id);
          return;
        }
      }
      scrollerNow.scrollTop = beforeTop;
    }
    const groupIndex = groupBlocks(useRuntimeStore.getState().thread.blocks).findIndex((group) => group.some((block) => block.id === id));
    if (groupIndex >= 0) {
      // Virtuoso's scrollToIndex takes the 0-based data index (its data index),
      // NOT firstItemIndex + dataIndex — the latter overflows for long
      // conversations and clamps to the last item.
      virtuosoRef.current?.scrollToIndex({ index: groupIndex, align: "start", behavior: "auto" });
      // After Virtuoso mounts the group, scroll again so the target lands at
      // the top of the viewport exactly (height estimation is inexact).
      scheduleSessionScoped(() => { if (!scrollToExact()) scheduleSessionScoped(scrollToExact, 250); }, 120);
      scheduleSessionScoped(() => {
        scrollToExact();
        if (highlight) highlightThreadBlock(id);
      }, 350);
    } else if (scrollToExact() && highlight) {
      highlightThreadBlock(id);
    }
  }, [highlightThreadBlock, scheduleSessionScoped, threadBlockElement]);

  const handleNavSelect = useCallback((id: string) => {
    // Stop the follow-output effect from yanking the viewport back to the bottom.
    followOutputRef.current = false;
    // A new navigation supersedes any pending correction timers from a
    // previous one (rapid consecutive clicks, session switch).
    cancelPendingScrollTimers();
    const target = userNavItems.find((item) => item.id === id);
    if (target?.before) {
      void loadMessagesForNavigation(target.before).then((loadedMessages) => {
        if (loadedMessages > 0) scheduleSessionScoped(() => scrollToLoadedTarget(id), 0);
      });
      return;
    }
    scrollToLoadedTarget(id);
  }, [cancelPendingScrollTimers, loadMessagesForNavigation, scheduleSessionScoped, scrollToLoadedTarget, userNavItems]);

  useEffect(() => {
    if (!focusedBlockId) {
      locatedFocusRef.current = null;
      return;
    }
    if (showRuns || !activeSessionId) return;
    const focusKey = `${activeSessionId}:${focusedBlockId}`;
    if (locatedFocusRef.current === focusKey) return;
    let cancelled = false;

    const locate = async () => {
      followOutputRef.current = false;
      cancelPendingScrollTimers();
      let previousGroupCount = groupBlocks(useRuntimeStore.getState().thread.blocks).length;
      let state = useRuntimeStore.getState();
      while (!state.thread.blocks.some((block) => block.id === focusedBlockId) && state.historyHasMore) {
        const loadedMessages = await state.loadOlderMessages();
        if (cancelled || loadedMessages === 0) return;
        const nextGroupCount = groupBlocks(useRuntimeStore.getState().thread.blocks).length;
        const addedGroups = Math.max(0, nextGroupCount - previousGroupCount);
        if (addedGroups > 0) setVirtualFirstItemIndex((current) => current - addedGroups);
        previousGroupCount = nextGroupCount;
        state = useRuntimeStore.getState();
      }
      if (cancelled || !state.thread.blocks.some((block) => block.id === focusedBlockId)) return;
      locatedFocusRef.current = focusKey;
      scheduleSessionScoped(() => scrollToLoadedTarget(focusedBlockId, true), 0);
    };

    void locate();
    return () => { cancelled = true; };
  }, [activeSessionId, cancelPendingScrollTimers, focusedBlockId, scheduleSessionScoped, scrollToLoadedTarget, showRuns, blocks]);

  const scrollToBottom = useCallback(() => {
    followOutputRef.current = true;
    const scroller = scrollRef.current;
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smoothScroll() ? "smooth" : "auto" });
      scroller.scrollTop = scroller.scrollHeight;
    }
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: smoothScroll() ? "smooth" : "auto" });
  }, [smoothScroll]);

  const startNewTurn = useCallback(() => {
    followOutputRef.current = true;
    setShowScrollDown(false);
    cancelPendingScrollTimers();
    const snapToBottom = () => {
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    };
    snapToBottom();
    // The optimistic user block lands right after; scroll again once the
    // block list has grown so the new message is actually in view.
    scheduleSessionScoped(snapToBottom, 50);
    scheduleSessionScoped(snapToBottom, 200);
  }, [cancelPendingScrollTimers, scheduleSessionScoped]);

  return { scrollRef, virtuosoRef, showScrollDown, virtualFirstItemIndex, attachScroller, handleLoadOlder, handleNavSelect, scrollToBottom, startNewTurn };
}
