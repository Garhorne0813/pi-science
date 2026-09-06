import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { buildTurnPresentations } from "../lib/conversation/turn-presentation";
import { useRuntimeStore } from "../lib/agent-runtime";
import type { ThreadBlock } from "../types/thread";
import { useConversationFollow } from "./useConversationFollow";

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
  followOutput: () => "auto" | false;
  handleListHeightChanged: () => void;
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
  const { showScrollDown, attachScroller, followOutput, handleListHeightChanged, pauseFollowing, resumeFollowing } = useConversationFollow({
    scrollRef, virtuosoRef, scope: `${workspaceCwd}:${sessionId ?? activeSessionId ?? "new"}`, blocks, working,
  });
  const [virtualFirstItemIndex, setVirtualFirstItemIndex] = useState(100_000);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const scrollTimersRef = useRef<number[]>([]);
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
    setNavigationLoading(false);
    setVirtualFirstItemIndex(100_000);
  }, [sessionId, workspaceCwd]);

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

    const previousTurns = buildTurnPresentations(initial.thread.blocks);
    const previousBlockIds = new Set(initial.thread.blocks.map((block) => block.id));
    const promise = (async () => {
      const loadedMessages = await loadOlderMessages();
      const current = useRuntimeStore.getState();
      if (current.cwd === cwdAtStart && current.activeSessionId === sessionIdAtStart) {
        const nextTurns = buildTurnPresentations(current.thread.blocks);
        const firstExistingTurn = nextTurns.findIndex((turn) => turn.blocks.some((block) => previousBlockIds.has(block.id)));
        const addedTurns = firstExistingTurn >= 0
          ? firstExistingTurn
          : Math.max(0, nextTurns.length - previousTurns.length);
        if (addedTurns > 0) setVirtualFirstItemIndex((value) => value - addedTurns);
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
    const exactBlock = document.getElementById(`thread-block-${id}`);
    if (exactBlock) return exactBlock;
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
    const turnIndex = buildTurnPresentations(useRuntimeStore.getState().thread.blocks).findIndex((turn) => turn.blocks.some((block) => block.id === id));
    if (turnIndex >= 0) {
      // Virtuoso's scrollToIndex takes the 0-based data index (its data index),
      // NOT firstItemIndex + dataIndex — the latter overflows for long
      // conversations and clamps to the last item.
      virtuosoRef.current?.scrollToIndex({ index: turnIndex, align: "start", behavior: "auto" });
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
    pauseFollowing();
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
  }, [activeSessionId, cancelPendingScrollTimers, pauseFollowing, loadOlderAndAnchor, scheduleSessionScoped, scrollToLoadedTarget, sessionId, workspaceCwd]);

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
    cancelPendingScrollTimers();
    resumeFollowing();
  }, [cancelPendingScrollTimers, resumeFollowing]);

  // Sending is an explicit request to follow again, even while browsing an
  // older answer. New list measurements continue the pin; no guessed timers.
  const startNewTurn = scrollToBottom;

  return { scrollRef, virtuosoRef, showScrollDown, virtualFirstItemIndex, navigationLoading, attachScroller, handleLoadOlder, handleNavSelect, scrollToBottom, startNewTurn, followOutput, handleListHeightChanged };
}
