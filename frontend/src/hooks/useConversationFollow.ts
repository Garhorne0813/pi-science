import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ThreadBlock } from "../types/thread";

/** Following is user intent, not a side effect of where the browser currently
 * sits. Virtuoso measures new turns asynchronously and completed activity can
 * shrink the list; neither is evidence that the user scrolled away. */
export function useConversationFollow({ scrollRef, virtuosoRef, scope, blocks, working }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scope: string;
  blocks: ThreadBlock[];
  working: boolean;
}) {
  const following = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const pendingFrame = useRef<(() => void) | null>(null);
  const detach = useRef<(() => void) | null>(null);

  const cancelFrame = useCallback(() => {
    pendingFrame.current?.();
    pendingFrame.current = null;
  }, []);

  const pauseFollowing = useCallback(() => {
    following.current = false;
    cancelFrame();
    setShowScrollDown(true);
  }, [cancelFrame]);

  const pinToBottom = useCallback(() => {
    if (!following.current) return;
    // One scroll owner: do not race Virtuoso's estimates with native writes.
    if (virtuosoRef.current) virtuosoRef.current.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    else if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [scrollRef, virtuosoRef]);

  const scheduleFollow = useCallback(() => {
    if (!following.current || pendingFrame.current) return;
    let fired = false;
    const frame = window.requestAnimationFrame(() => {
      fired = true;
      pendingFrame.current = null;
      pinToBottom();
    });
    // Some test/browser adapters run rAF synchronously.
    if (!fired) pendingFrame.current = () => window.cancelAnimationFrame(frame);
  }, [pinToBottom]);

  const resumeFollowing = useCallback(() => {
    following.current = true;
    setShowScrollDown(false);
    cancelFrame();
    pinToBottom();
    scheduleFollow();
  }, [cancelFrame, pinToBottom, scheduleFollow]);

  const attachScroller = useCallback((element: Window | HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    cancelFrame();
    const scroller = element instanceof HTMLDivElement ? element : null;
    scrollRef.current = scroller;
    if (!scroller) return;
    scroller.classList.add("conversation-scroller", "overflow-y-auto");
    let direction: "up" | "down" | null = null;
    let intentUntil = 0;
    let pointerDown = false;
    let touchY: number | null = null;
    let previousTop = scroller.scrollTop;
    const markIntent = (up: boolean) => {
      direction = up ? "up" : "down";
      intentUntil = Date.now() + 800;
      if (up) pauseFollowing();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY && !event.ctrlKey) markIntent(event.deltaY < 0);
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const onTouchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY ?? null;
      if (touchY !== null && next !== null && Math.abs(next - touchY) > 2) markIntent(next > touchY);
      touchY = next;
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) markIntent(true);
      if (["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey)) markIntent(false);
    };
    const onPointerDown = (event: PointerEvent) => { pointerDown = event.target === scroller; };
    const onPointerUp = () => { pointerDown = false; };
    const onScroll = () => {
      const top = scroller.scrollTop;
      const nearBottom = scroller.scrollHeight - top - scroller.clientHeight < 96;
      if (pointerDown && Math.abs(top - previousTop) > 1) markIntent(top < previousTop);
      previousTop = top;
      // Only a downward user gesture can opt back in implicitly. A stale pin,
      // content collapse or navigation jump must not change follow intent.
      if (direction === "down" && Date.now() <= intentUntil && nearBottom) {
        following.current = true;
        scheduleFollow();
      }
      setShowScrollDown(!following.current && !nearBottom);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("keydown", onKey);
    scroller.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    detach.current = () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("keydown", onKey);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    scheduleFollow();
  }, [cancelFrame, pauseFollowing, scheduleFollow, scrollRef]);

  useEffect(() => { resumeFollowing(); }, [scope, resumeFollowing]);
  useEffect(() => { scheduleFollow(); }, [blocks, working, scheduleFollow]);
  useEffect(() => () => { cancelFrame(); detach.current?.(); }, [cancelFrame]);

  const followOutput = useCallback(() => following.current ? "auto" as const : false, []);
  // Runs after real layout measurements, including token growth, images,
  // font loading, activity collapse and the arrival of a second user turn.
  const handleListHeightChanged = useCallback(() => {
    scheduleFollow();
    const scroller = scrollRef.current;
    if (!following.current && scroller) {
      setShowScrollDown(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 96);
    }
  }, [scheduleFollow, scrollRef]);
  return { showScrollDown, attachScroller, followOutput, handleListHeightChanged, pauseFollowing, resumeFollowing };
}
