import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";

export interface ConversationNavItem {
  id: string;
  label: string;
  /** Full message text retained for accessibility and native fallback text. */
  full?: string;
}

type Preview = { id: string; top: number };

const IDLE_INDICATOR_WIDTH = 8;

function indicatorWidth(distance: number): number {
  if (distance === 0) return 32;
  if (distance === 1) return 24;
  if (distance === 2) return 16;
  return IDLE_INDICATOR_WIDTH;
}

/** Compact conversation minimap: one line per user query. The current query
 *  and its neighbours form a length gradient; hover/focus reveals only that
 *  query's preview, and clicking locates the target in the loaded thread. */
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(items.at(-1)?.id ?? null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const signature = items.map((item) => item.id).join("\u0000");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const previewItem = preview ? items.find((item) => item.id === preview.id) : undefined;
  const hoverIndex = preview ? items.findIndex((item) => item.id === preview.id) : -1;
  const rowHeight = items.length <= 20 ? 16 : 12;

  useEffect(() => {
    if (activeId && items.some((item) => item.id === activeId)) return;
    setActiveId(items.at(-1)?.id ?? null);
  }, [activeId, signature, items]);

  // Split panes can be narrow even on a desktop viewport, so use the actual
  // conversation scroller width instead of relying only on Tailwind's lg
  // breakpoint. Below 480 px the minimap yields all space to the thread.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setPaneWidth(root.getBoundingClientRect().width || root.clientWidth || 0);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef]);

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
      const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 96;
      if (nearBottom) {
        const last = current[current.length - 1]?.id ?? null;
        setActiveId((previous) => (previous !== last ? last : previous));
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
      setActiveId((previous) => (previous !== best ? best : previous));
    }, { root, rootMargin: "0px 0px -45% 0px" });
    for (const item of itemsRef.current) {
      const element = document.getElementById(`user-msg-${item.id}`);
      if (element && root.contains(element)) io.observe(element);
    }
    return () => io.disconnect();
  }, [rootRef, signature]);

  // Long conversations scroll inside the bounded minimap. Keep the active
  // line near its centre without affecting the conversation's own scroll.
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const button = listRef.current.querySelector<HTMLElement>(`[data-nav-id="${activeId}"]`);
    if (!button) return;
    const top = button.offsetTop - listRef.current.offsetTop;
    const desired = top - (listRef.current.clientHeight - button.offsetHeight) / 2;
    if (top < listRef.current.scrollTop || top + button.offsetHeight > listRef.current.scrollTop + listRef.current.clientHeight) {
      listRef.current.scrollTo({ top: Math.max(0, desired) });
    }
  }, [activeId]);

  if (items.length === 0 || (paneWidth > 0 && paneWidth < 480)) return null;

  const showPreview = (id: string, element: HTMLElement) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const itemRect = element.getBoundingClientRect();
    const itemCenter = itemRect.top + itemRect.height / 2;
    // Clamp against the viewport, not the rail height. A short conversation
    // may have a 32–48 px rail while its tooltip is much taller.
    const viewportCenter = Math.max(52, Math.min(window.innerHeight - 52, itemCenter));
    const top = viewportCenter - wrapperRect.top;
    setPreview((current) => current?.id === id && current.top === top ? current : { id, top });
  };

  const activateFromPointer = (event: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-nav-id]")
      : null;
    if (target?.dataset.navId) {
      showPreview(target.dataset.navId, target);
      return;
    }
    // The visual strokes are deliberately tiny. When the pointer is inside
    // the wider transparent rail hit area, resolve the closest row from its Y
    // position so hovering never requires pixel-perfect targeting or a click.
    const list = listRef.current;
    if (!list) return;
    const listRect = list.getBoundingClientRect();
    const contentY = event.clientY - listRect.top + list.scrollTop;
    const index = Math.max(0, Math.min(items.length - 1, Math.floor(contentY / rowHeight)));
    const item = items[index];
    const button = item
      ? list.querySelector<HTMLElement>(`[data-nav-id="${item.id}"]`)
      : null;
    if (item && button) showPreview(item.id, button);
  };

  return (
    <div
      ref={wrapperRef}
      className="pointer-events-auto absolute left-2 top-1/2 z-20 hidden -translate-y-1/2 lg:block"
      onMouseLeave={() => setPreview(null)}
    >
      <nav
        ref={listRef}
        aria-label={t("conversation.threadNav")}
        onPointerMove={activateFromPointer}
        onMouseMove={activateFromPointer}
        onScroll={() => setPreview(null)}
        className="flex w-20 flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ maxHeight: "min(55vh, 520px)" }}
      >
        {items.map((item, index) => {
          const active = activeId === item.id;
          const hovered = preview?.id === item.id;
          const distance = hoverIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - hoverIndex);
          return (
            <button
              key={item.id}
              type="button"
              data-nav-id={item.id}
              aria-label={item.label}
              aria-current={active ? "true" : undefined}
              title={item.full ?? item.label}
              onFocus={(event) => showPreview(item.id, event.currentTarget)}
              onBlur={() => setPreview(null)}
              onClick={() => { setActiveId(item.id); onSelect(item.id); }}
              className="group flex w-20 shrink-0 items-center justify-start rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              style={{ height: rowHeight }}
            >
              <span
                data-nav-indicator
                className={cn(
                  "block rounded-full transition-[width,background-color] duration-150",
                  hovered ? "h-[3px] bg-text opacity-100" : "h-0.5 bg-muted opacity-60 group-hover:opacity-100",
                )}
                style={{ width: hoverIndex < 0 ? IDLE_INDICATOR_WIDTH : indicatorWidth(distance) }}
              />
            </button>
          );
        })}
      </nav>

      {previewItem && preview && (
        <div
          role="tooltip"
          className={cn(
            "ui-popover pointer-events-none absolute left-24 z-30 w-80 -translate-y-1/2 rounded-card px-3.5 py-3 text-sm text-text",
            paneWidth > 0 && paneWidth < 640 && "w-60",
          )}
          style={{ top: preview.top }}
        >
          <p className="line-clamp-3 whitespace-pre-wrap break-words leading-5">{itemPreview(previewItem)}</p>
        </div>
      )}
    </div>
  );
}

function itemPreview(item: ConversationNavItem): string {
  // `full` may contain hidden workspace-reference markup; `label` is already
  // the user-visible, sanitized message summary prepared by LiveSessionPage.
  return item.label;
}
