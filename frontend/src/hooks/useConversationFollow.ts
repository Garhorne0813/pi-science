import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ThreadBlock } from "../types/thread";

/** Following is user intent, not a side effect of where the browser currently
 * sits. Virtuoso measures new turns asynchronously and completed activity can
 * shrink the list; neither is evidence that the user scrolled away. */
export function useConversationFollow({ scrollRef, virtuosoRef, scope }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scope: string;
  blocks: ThreadBlock[];
  working: boolean;
}) {
  const following = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const detach = useRef<(() => void) | null>(null);

  const pauseFollowing = useCallback(() => {
    following.current = false;
    setShowScrollDown(true);
  }, []);

  /** Hard pin only for an explicit follow/resume action. Routine streaming
   * growth is owned by Virtuoso's followOutput + autoscrollToBottom instead. */
  const pinToBottom = useCallback(() => {
    if (!following.current) return;
    if (virtuosoRef.current) virtuosoRef.current.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    else if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [scrollRef, virtuosoRef]);

  const resumeFollowing = useCallback(() => {
    following.current = true;
    setShowScrollDown(false);
    pinToBottom();
  }, [pinToBottom]);

  const attachScroller = useCallback((element: Window | HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
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
      // Only a downward user gesture can opt back in implicitly. Once it does,
      // Virtuoso owns subsequent follow corrections; do not issue a hard pin.
      if (direction === "down" && Date.now() <= intentUntil && nearBottom) {
        following.current = true;
        setShowScrollDown(false);
      } else {
        setShowScrollDown(!following.current && !nearBottom);
      }
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
    // Initial attachment is an explicit viewport handoff; start at the latest
    // turn once, then leave routine growth to Virtuoso.
    pinToBottom();
  }, [pauseFollowing, pinToBottom, scrollRef]);

  useEffect(() => { resumeFollowing(); }, [scope, resumeFollowing]);
  useEffect(() => () => { detach.current?.(); }, []);

  const followOutput = useCallback(() => following.current ? "auto" as const : false, []);
  // Item height changes (streamed markdown, images, activity collapse) are
  // measured by Virtuoso. Let its follow-output machinery perform the matching
  // correction instead of racing it with scrollToIndex("LAST").
  const handleListHeightChanged = useCallback(() => {
    const scroller = scrollRef.current;
    if (following.current) {
      const handle = virtuosoRef.current;
      if (handle?.autoscrollToBottom) handle.autoscrollToBottom();
      // Keep non-Virtuoso/test adapters functional without making the fallback
      // the production scroll owner. Current Virtuoso exposes autoscrollToBottom.
      else if (handle) handle.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      else if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (scroller) {
      setShowScrollDown(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 96);
    }
  }, [scrollRef, virtuosoRef]);
  return { showScrollDown, attachScroller, followOutput, handleListHeightChanged, pauseFollowing, resumeFollowing };
}
