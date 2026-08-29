import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { groupBlocks } from "../components/conversation/ConversationBlocks";
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
  loadOlderMessages: () => Promise<number>;
}

export interface ConversationScrollController {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  showScrollDown: boolean;
  virtualFirstItemIndex: number;
  navigationLoading: boolean;
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
    loadOlderMessages,
  } = options;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const followOutputRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [virtualFirstItemIndex, setVirtualFirstItemIndex] = useState(100_000);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const scrollTimersRef = useRef<number[]>([]);
  const followOutputCancelRef = useRef<(() => void) | null>(null);
  const historyLoadInFlightRef = useRef<{ key: string; promise: Promise<number> } | null>(null);
  const navigationGenerationRef = useRef(0);
  const sessionRef = useRef(sessionId);
  const locatedFocusRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    return () => {
      navigationGenerationRef.current += 1;
      for (const handle of scrollTimersRef.current) window.clearTimeout(handle);
      scrollTimersRef.current = [];
    };
  }, []);

  // A new session (or a reconnect) starts at the bottom: never inherit the
  // "user scrolled up" state of the previous session on this route.
  useEffect(() => {
    navigationGenerationRef.current += 1;
    followOutputRef.current = true;
    setShowScrollDown(false);
    setNavigationLoading(false);
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

  // One anchor transaction owns each in-flight prepend. Both Virtuoso's
  // startReached callback and navigation can request the same page; sharing
  // this promise prevents them from decrementing firstItemIndex twice.
  const loadOlderAndAnchor = useCallback(async (): Promise<number> => {
    const initial = useRuntimeStore.getState();
    if (!initial.activeSessionId || !initial.historyHasMore || !initial.historyCursor) return 0;
    const sessionIdAtStart = initial.activeSessionId;
    const cwdAtStart = initial.cwd;
    const cursorAtStart = initial.historyCursor;
    const key = `${cwdAtStart}\u0000${sessionIdAtStart}\u0000${cursorAtStart}`;
    const existing = historyLoadInFlightRef.current;
    if (existing?.key === key) return existing.promise;

    const previousGroups = groupBlocks(initial.thread.blocks);
    const previousBlockIds = new Set(initial.thread.blocks.map((block) => block.id));
    const promise = (async () => {
      const loadedMessages = await loadOlderMessages();
      const current = useRuntimeStore.getState();
      if (current.cwd === cwdAtStart && current.activeSessionId === sessionIdAtStart) {
        const nextGroups = groupBlocks(current.thread.blocks);
        const firstExistingGroup = nextGroups.findIndex((group) => group.some((block) => previousBlockIds.has(block.id)));
        const addedGroups = firstExistingGroup >= 0
          ? firstExistingGroup
          : Math.max(0, nextGroups.length - previousGroups.length);
        if (addedGroups > 0) setVirtualFirstItemIndex((value) => value - addedGroups);
      }
      return loadedMessages;
    })();
    historyLoadInFlightRef.current = { key, promise };
    try {
      return await promise;
    } finally {
      if (historyLoadInFlightRef.current?.promise === promise) historyLoadInFlightRef.current = null;
    }
  }, [loadOlderMessages]);

  const handleLoadOlder = useCallback(async () => {
    await loadOlderAndAnchor();
  }, [loadOlderAndAnchor]);

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

  const locateBlock = useCallback(async (id: string, options: { highlight?: boolean } = {}): Promise<boolean> => {
    const token = ++navigationGenerationRef.current;
    followOutputRef.current = false;
    cancelPendingScrollTimers();
    const expectedSessionId = activeSessionId ?? sessionId ?? null;
    let state = useRuntimeStore.getState();
    if (state.cwd !== workspaceCwd || (expectedSessionId && state.activeSessionId !== expectedSessionId)) {
      setNavigationLoading(false);
      return false;
    }

    try {
      if (state.thread.blocks.some((block) => block.id === id)) {
        scrollToLoadedTarget(id, options.highlight ?? false);
        return true;
      }
      setNavigationLoading(true);
      while (token === navigationGenerationRef.current) {
        state = useRuntimeStore.getState();
        if (state.cwd !== workspaceCwd || (expectedSessionId && state.activeSessionId !== expectedSessionId)) return false;
        if (state.thread.blocks.some((block) => block.id === id)) break;
        if (!state.historyHasMore) break;
        const loadedMessages = await loadOlderAndAnchor();
        if (token !== navigationGenerationRef.current) return false;
        state = useRuntimeStore.getState();
        if (state.cwd !== workspaceCwd || (expectedSessionId && state.activeSessionId !== expectedSessionId)) return false;
        if (loadedMessages === 0) break;
      }

      if (token !== navigationGenerationRef.current || !state.thread.blocks.some((block) => block.id === id)) return false;
      scheduleSessionScoped(() => {
        if (navigationGenerationRef.current === token) scrollToLoadedTarget(id, options.highlight ?? false);
      }, 0);
      return true;
    } finally {
      if (navigationGenerationRef.current === token) setNavigationLoading(false);
    }
  }, [activeSessionId, cancelPendingScrollTimers, loadOlderAndAnchor, scheduleSessionScoped, scrollToLoadedTarget, sessionId, workspaceCwd]);

  const handleNavSelect = useCallback((id: string) => {
    void locateBlock(id);
  }, [locateBlock]);

  useEffect(() => {
    if (!showRuns) return;
    navigationGenerationRef.current += 1;
    cancelPendingScrollTimers();
    setNavigationLoading(false);
  }, [cancelPendingScrollTimers, showRuns]);

  useEffect(() => {
    if (!focusedBlockId) {
      locatedFocusRef.current = null;
      return;
    }
    if (showRuns || !activeSessionId) return;
    const focusKey = `${activeSessionId}:${focusedBlockId}`;
    if (locatedFocusRef.current === focusKey) return;
    let cancelled = false;

    void locateBlock(focusedBlockId, { highlight: true }).then((located) => {
      if (!cancelled && located) locatedFocusRef.current = focusKey;
    });
    return () => {
      cancelled = true;
      navigationGenerationRef.current += 1;
      cancelPendingScrollTimers();
    };
  }, [activeSessionId, cancelPendingScrollTimers, focusedBlockId, locateBlock, showRuns]);

  const scrollToBottom = useCallback(() => {
    navigationGenerationRef.current += 1;
    setNavigationLoading(false);
    followOutputRef.current = true;
    cancelPendingScrollTimers();
    const scroller = scrollRef.current;
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smoothScroll() ? "smooth" : "auto" });
      scroller.scrollTop = scroller.scrollHeight;
    }
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: smoothScroll() ? "smooth" : "auto" });
  }, [cancelPendingScrollTimers, smoothScroll]);

  const startNewTurn = useCallback(() => {
    navigationGenerationRef.current += 1;
    setNavigationLoading(false);
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

  return { scrollRef, virtuosoRef, showScrollDown, virtualFirstItemIndex, navigationLoading, attachScroller, handleLoadOlder, handleNavSelect, scrollToBottom, startNewTurn };
}
