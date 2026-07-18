import { useEffect, useCallback, type RefObject } from "react";

/** Persist and restore scroll position for a scrollable container.
 *
 * Usage:
 *   const onScroll = useScrollMemory(ref, "unique-key", ready);
 *   <div ref={ref} onScroll={onScroll} />
 *
 * When `ready` becomes true, the previously saved scrollTop is restored.
 * On every scroll event, the current position is saved to sessionStorage.
 */
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string,
  ready: boolean = true,
): (e: React.UIEvent) => void {
  // Restore scroll position when content becomes ready
  useEffect(() => {
    if (!ready || !ref.current) return;
    const stored = sessionStorage.getItem(`scroll:${key}`);
    if (stored !== null) {
      const top = parseInt(stored, 10) || 0;
      // Use rAF to ensure content is rendered before restoring
      requestAnimationFrame(() => {
        if (ref.current) {
          ref.current.scrollTop = top;
        }
      });
    }
  }, [key, ready, ref]);

  // Save scroll position on scroll
  return useCallback(() => {
    if (ref.current) {
      sessionStorage.setItem(`scroll:${key}`, String(ref.current.scrollTop));
    }
  }, [key, ref]);
}
