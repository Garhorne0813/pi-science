import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";

export interface ConversationNavItem {
  id: string;
  label: string;
  /** Full message text for the tooltip; `label` stays truncated for display. */
  full?: string;
}

/** ChatGPT-style rail on the right of the conversation: one entry per user
 *  query, the entry in the current viewport is highlighted, clicking one
 *  scrolls the thread to that message. Desktop only (`lg:`). */
export function ConversationNavRail({
  items,
  rootRef,
  onSelect,
}: {
  items: ConversationNavItem[];
  rootRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const signature = items.map((item) => item.id).join("\u0000");
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Track which user message occupies the top band of the viewport.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || itemsRef.current.length === 0) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver((entries) => {
      const current = itemsRef.current;
      for (const entry of entries) {
        const id = String(entry.target.id).replace(/^user-msg-/, "");
        if (entry.isIntersecting) visible.set(id, entry.intersectionRatio);
        else visible.delete(id);
      }
      // Near the bottom, the last message is the active one even when the
      // top band has nothing in it (e.g. the composer is on screen).
      const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 96;
      if (nearBottom) {
        const last = current[current.length - 1]?.id ?? null;
        setActiveId((prev) => (prev !== last ? last : prev));
        return;
      }
      let best: string | null = null;
      let bestRatio = 0;
      for (const [id, ratio] of visible) {
        if (ratio > bestRatio) {
          best = id;
          bestRatio = ratio;
        }
      }
      setActiveId((prev) => (prev !== best ? best : prev));
    }, { root, rootMargin: "0px 0px -45% 0px" });
    for (const item of itemsRef.current) {
      // getElementById needs no CSS.escape and the anchors are unique.
      const el = document.getElementById(`user-msg-${item.id}`);
      if (el && root.contains(el)) io.observe(el);
    }
    return () => io.disconnect();
  }, [rootRef, signature]);

  // Keep the active entry visible inside the rail's own scroll area without
  // scrolling the thread container.
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const button = listRef.current.querySelector<HTMLElement>(`[data-nav-id="${activeId}"]`);
    if (!button) return;
    const top = button.offsetTop - listRef.current.offsetTop - 8;
    if (top < listRef.current.scrollTop || top > listRef.current.scrollTop + listRef.current.clientHeight - 32) {
      listRef.current.scrollTo({ top });
    }
  }, [activeId]);

  if (items.length === 0) return null;

  return (
    <div className="group pointer-events-none absolute right-0 top-1/2 z-20 hidden -translate-y-1/2 lg:block">
      {/* Narrow vertical handle; hovering it (or focusing it) slides out the
          query list to the left, ChatGPT-style. */}
      <button
        type="button"
        aria-label={t("conversation.threadNav")}
        title={t("conversation.threadNav")}
        className="pointer-events-auto flex h-16 w-8 items-center justify-center rounded-input outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="h-14 w-2 rounded-full bg-[#a8a49a] transition-colors group-hover:bg-accent group-focus-within:bg-accent" />
      </button>
      <nav
        ref={listRef}
        aria-label={t("conversation.threadNav")}
        className={cn(
          "pointer-events-auto invisible absolute right-2 top-1/2 flex max-h-[55vh] w-60 -translate-y-1/2 translate-x-2 flex-col overflow-y-auto rounded-card border border-border bg-surface py-1.5 opacity-0 shadow-card transition-all duration-150",
          "group-hover:visible group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-x-0 group-focus-within:opacity-100",
        )}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-nav-id={item.id}
            aria-current={activeId === item.id ? "true" : undefined}
            onClick={() => { setActiveId(item.id); onSelect(item.id); }}
            title={item.full ?? item.label}
            className={cn(
              "relative flex min-h-8 w-full shrink-0 items-center gap-2 px-2.5 text-left text-xs transition-colors",
              "focus-visible:bg-surface-2 focus-visible:text-text focus-visible:outline-none",
              activeId === item.id ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
              activeId === item.id && "after:absolute after:left-0 after:top-1/2 after:h-4 after:w-0.5 after:-translate-y-1/2 after:rounded-full after:bg-accent",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
