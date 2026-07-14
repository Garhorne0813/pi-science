import { useCallback, useEffect } from "react";

/** Persist and restore a scroll position for a preview pane. */
export function useScrollMemory(
  ref: React.RefObject<HTMLElement | null>,
  key: string,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const saved = Number(localStorage.getItem(`pi-science.scroll.${key}`) || 0);
    if (saved > 0) ref.current.scrollTop = saved;
  }, [enabled, key, ref]);

  return useCallback((event: React.UIEvent<HTMLElement>) => {
    localStorage.setItem(`pi-science.scroll.${key}`, String(event.currentTarget.scrollTop));
  }, [key]);
}
