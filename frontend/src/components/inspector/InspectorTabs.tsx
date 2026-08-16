import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Inspector } from "../../types/thread";
import { useUiStore, type InspectorTab } from "@/lib/ui";
import { cn } from "@/lib/ui";
import { notifyInspectorLayoutChange } from "@/lib/ui/inspector-layout";
import { IconButton } from "../ui/Icon";
import { ErrorBoundary } from "../ErrorBoundary";
import { InspectorShell } from "./InspectorShell";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function tabTitle(data: Inspector, sessionKernelTitle: string): string {
  switch (data.variant) {
    case "file": return data.filename;
    case "notebook-file": return data.path.split(/[\\/]/).pop() || data.path;
    case "pdf": return data.filename || data.path?.split(/[\\/]/).pop() || "PDF";
    case "artifact": return data.filename || data.title;
    case "notebook": return data.notebookId;
    case "notebook-panel": return sessionKernelTitle;
  }
}

export function InspectorTabs({
  tabs,
  activeTabId,
  cwd,
  sessionId,
  reserveControls = false,
}: {
  tabs: InspectorTab[];
  activeTabId: string;
  cwd?: string;
  sessionId?: string;
  /** Keep the fixed preview layout controls from covering the scroll viewport. */
  reserveControls?: boolean;
}) {
  const { t } = useTranslation();
  const activateTab = useUiStore((state) => state.activateInspectorTab);
  const closeTab = useUiStore((state) => state.closeInspectorTab);
  const [expandedTabId, setExpandedTabId] = useState<string | null>(null);
  const [zoomByTab, setZoomByTab] = useState<Record<string, number>>({});
  // Keep visited tabs mounted so drafts and per-file view state survive tab
  // switches, but do not parse/load every unopened preview on first render.
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(
    () => (activeTabId ? new Set([activeTabId]) : new Set()),
  );
  const expandedPanelRef = useRef<HTMLDivElement | null>(null);
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  // Focus origin of the expanded dialog, restored when it closes.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const [tabScrollIndicator, setTabScrollIndicator] = useState({ visible: false, left: 0, width: 100 });

  const setTabZoom = (tabId: string, update: (current: number) => number) => {
    setZoomByTab((current) => ({
      ...current,
      [tabId]: clampZoom(update(current[tabId] ?? 1)),
    }));
  };

  useEffect(() => {
    const validIds = new Set(tabs.map((tab) => tab.id));
    setMountedTabIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      if (activeTabId) next.add(activeTabId);
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [activeTabId, tabs]);

  useEffect(() => {
    if (!expandedTabId) return;
    if (expandedTabId !== activeTabId || !tabs.some((tab) => tab.id === expandedTabId)) {
      setExpandedTabId(null);
    }
  }, [activeTabId, expandedTabId, tabs]);

  useEffect(() => {
    if (!expandedTabId) return;
    // Remember where focus came from and move it into the expanded dialog.
    lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    expandedPanelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedTabId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      lastFocusedRef.current?.focus();
      lastFocusedRef.current = null;
    };
  }, [expandedTabId]);

  useEffect(() => {
    if (!expandedTabId || !expandedPanelRef.current) return;
    const panel = expandedPanelRef.current;
    const onWheel = (event: WheelEvent) => {
      // Chromium emits ctrl+wheel for a trackpad pinch. metaKey also supports
      // the familiar Command+wheel gesture on macOS.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = Math.exp(-event.deltaY * 0.002);
      setTabZoom(expandedTabId, (current) => current * factor);
    };
    panel.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => panel.removeEventListener("wheel", onWheel, { capture: true });
  }, [expandedTabId]);

  useEffect(() => {
    const scroller = tabScrollRef.current;
    if (!scroller) return;
    const updateIndicator = () => {
      const { clientWidth, scrollLeft, scrollWidth } = scroller;
      const visible = scrollWidth > clientWidth + 1;
      const width = visible ? Math.max(12, (clientWidth / scrollWidth) * 100) : 100;
      const maxScroll = Math.max(0, scrollWidth - clientWidth);
      const left = maxScroll > 0 ? (scrollLeft / maxScroll) * (100 - width) : 0;
      setTabScrollIndicator({ visible, left, width });
    };
    const handleWheel = (event: WheelEvent) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      // Preserve native horizontal trackpad gestures. A regular vertical
      // mouse wheel over the tab strip moves the tabs horizontally instead.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const previousScrollLeft = scroller.scrollLeft;
      scroller.scrollLeft += event.deltaY;
      if (scroller.scrollLeft !== previousScrollLeft) event.preventDefault();
    };
    updateIndicator();
    scroller.addEventListener("scroll", updateIndicator, { passive: true });
    scroller.addEventListener("wheel", handleWheel, { passive: false });
    const observer = new ResizeObserver(updateIndicator);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", updateIndicator);
      scroller.removeEventListener("wheel", handleWheel);
      observer.disconnect();
    };
  }, [tabs.length]);

  // Keep Tab inside the expanded dialog so keyboard users cannot reach the
  // background while it is open.
  const handleExpandedPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !expandedPanelRef.current) return;
    const focusables = expandedPanelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const focusSibling = (currentId: string, direction: -1 | 1) => {
    const index = tabs.findIndex((tab) => tab.id === currentId);
    if (index === -1) return;
    const nextIndex = (index + direction + tabs.length) % tabs.length;
    activateTab(tabs[nextIndex].id);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[role="tab"][data-tab-index="${nextIndex}"]`)?.focus();
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative h-11 shrink-0 bg-surface">
        <div
          ref={tabScrollRef}
          role="tablist"
          aria-label={t("filePreview.openFiles")}
          className="h-11 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div
            className={cn(
              "flex h-11 w-max min-w-full border-b border-border px-1",
              reserveControls && "pr-14",
            )}
          >
            {tabs.map((tab, index) => {
            const active = tab.id === activeTabId;
            const title = tabTitle(tab.data, t("notebook.sessionKernel"));
            return (
              <div
                key={tab.id}
                title={title}
                className={cn(
                  "group relative flex h-full min-w-28 max-w-48 shrink-0 cursor-default items-center gap-1.5 px-2 outline-none",
                  active ? "text-text" : "text-muted hover:bg-surface-2/60 hover:text-text",
                )}
              >
                {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
                <button
                  type="button"
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  data-tab-index={index}
                  aria-selected={active}
                  aria-controls={`inspector-panel-${index}`}
                  className="min-w-0 flex-1 truncate text-left text-ui-label outline-none"
                  onClick={() => activateTab(tab.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) closeTab(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      event.preventDefault();
                      focusSibling(tab.id, event.key === "ArrowLeft" ? -1 : 1);
                    }
                  }}
                >
                  {title}
                </button>
                <IconButton
                  icon={X}
                  label={t("filePreview.closeTab", { filename: title })}
                  size="compact"
                  className={cn(
                    "h-11 w-11 hover:bg-border hover:text-text",
                    active ? "text-muted" : "text-transparent group-hover:text-muted group-focus-within:text-muted",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                />
              </div>
            );
            })}
          </div>
        </div>
        {tabScrollIndicator.visible && (
          <div aria-hidden="true" className="absolute inset-x-1 bottom-0 h-1 overflow-hidden rounded-full bg-border/45">
            <div
              className="h-full rounded-full bg-muted/55"
              style={{ marginLeft: `${tabScrollIndicator.left}%`, width: `${tabScrollIndicator.width}%` }}
            />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {expandedTabId && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setExpandedTabId(null)}
          />
        )}
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const expanded = tab.id === expandedTabId;
          const title = tabTitle(tab.data, t("notebook.sessionKernel"));
          const zoom = zoomByTab[tab.id] ?? 1;
          const mounted = active || mountedTabIds.has(tab.id);
          return (
            <div
              ref={expanded ? expandedPanelRef : undefined}
              key={tab.id}
              id={`inspector-panel-${index}`}
              role={expanded ? "dialog" : "tabpanel"}
              aria-modal={expanded || undefined}
              aria-label={expanded ? title : undefined}
              tabIndex={expanded ? -1 : undefined}
              hidden={!active}
              style={expanded ? { width: "92vw", height: "92vh", left: "4vw", top: "4vh" } : undefined}
              onKeyDown={expanded ? handleExpandedPanelKeyDown : undefined}
              className={cn(
                "h-full",
                expanded && "fixed z-50 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl",
              )}
            >
              {mounted && (
                <ErrorBoundary>
                  <InspectorShell
                    inspector={tab.data}
                    onClose={() => closeTab(tab.id)}
                    cwd={cwd}
                    sessionId={sessionId}
                    compactHeader
                    contentZoom={expanded ? zoom : 1}
                    leadingControls={tab.data.variant === "file" && expanded ? (
                      <div className="flex items-center rounded-input bg-surface-2 p-0.5">
                        <IconButton
                          icon={Minus}
                          label={t("filePreview.zoomOut")}
                          size="compact"
                          className="hover:bg-surface"
                          disabled={zoom <= MIN_ZOOM}
                          onClick={() => setTabZoom(tab.id, (current) => current - ZOOM_STEP)}
                        />
                        <button
                          type="button"
                          className="min-w-12 rounded px-1 py-0.5 text-ui-caption tabular-nums text-muted hover:bg-surface hover:text-text"
                          aria-label={t("filePreview.resetZoom")}
                          title={t("filePreview.resetZoom")}
                          onClick={() => setTabZoom(tab.id, () => 1)}
                        >
                          {Math.round(zoom * 100)}%
                        </button>
                        <IconButton
                          icon={Plus}
                          label={t("filePreview.zoomIn")}
                          size="compact"
                          className="hover:bg-surface"
                          disabled={zoom >= MAX_ZOOM}
                          onClick={() => setTabZoom(tab.id, (current) => current + ZOOM_STEP)}
                        />
                      </div>
                    ) : undefined}
                    controls={tab.data.variant === "file" ? (
                      <IconButton
                        icon={expanded ? Minimize2 : Maximize2}
                        label={t(expanded ? "shell.restorePanel" : "shell.maximizePanel")}
                        size="compact"
                        className="text-text"
                        aria-pressed={expanded}
                        onClick={() => {
                          setExpandedTabId(expanded ? null : tab.id);
                          notifyInspectorLayoutChange();
                        }}
                      />
                    ) : undefined}
                  />
                </ErrorBoundary>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
