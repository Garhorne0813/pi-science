import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Inspector } from "../../types/thread";
import { useUiStore, type InspectorTab } from "@/lib/ui";
import { cn } from "@/lib/ui";
import { notifyInspectorLayoutChange } from "@/lib/ui/inspector-layout";
import { IconButton } from "../ui/Icon";
import { ErrorBoundary } from "../ErrorBoundary";
import { InspectorShell } from "./InspectorShell";
import { previewFocusables, inertPreviewBackground, focusPreviewElement } from "./preview-focus";
import { bindPreviewFrameEscape } from "./iframe-focus";
import { PreviewPaneControls } from "./PreviewPaneControls";

function tabTitle(data: Inspector, sessionKernelTitle: string): string {
  switch (data.variant) {
    case "file": return data.sha256 ? `${data.filename} (${data.version ? `v${data.version}` : data.sha256.slice(0, 8)})` : data.filename;
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
  // Keep visited tabs mounted so drafts and per-file view state survive tab
  // switches, but do not parse/load every unopened preview on first render.
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(
    () => (activeTabId ? new Set([activeTabId]) : new Set()),
  );
  const expandedPanelRef = useRef<HTMLDivElement | null>(null);
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  // Focus origin of the expanded dialog, restored when it closes.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const reverseTabRef = useRef(false);

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
    notifyInspectorLayoutChange();
    if (!expandedTabId) return;
    // Remember where focus came from and move it into the expanded dialog.
    lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreBackground = expandedPanelRef.current ? inertPreviewBackground(expandedPanelRef.current) : undefined;
    expandedPanelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") reverseTabRef.current = event.shiftKey;
      const nestedDialog = event.target instanceof HTMLElement ? event.target.closest('[role="dialog"]') : null;
      if (nestedDialog && nestedDialog !== expandedPanelRef.current) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        setExpandedTabId(null);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const panel = expandedPanelRef.current;
      if (!panel || !(event.target instanceof Node) || panel.contains(event.target)) return;
      // iframe key events do not bubble to React. Contain native focus when
      // Tab leaves a browsing context, including a browser-owned PDF viewer.
      const available = previewFocusables(panel);
      ((reverseTabRef.current ? available.at(-1) : available[0]) ?? panel).focus();
    };
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown);
    const unbindFrames = expandedPanelRef.current ? bindPreviewFrameEscape(expandedPanelRef.current, () => setExpandedTabId(null), (reverse) => { reverseTabRef.current = reverse; }) : undefined;
    return () => {
      unbindFrames?.();
      document.removeEventListener("focusin", onFocusIn);
      restoreBackground?.();
      window.removeEventListener("keydown", onKeyDown);
      lastFocusedRef.current?.focus();
      lastFocusedRef.current = null;
    };
  }, [expandedTabId]);

  useEffect(() => {
    const scroller = tabScrollRef.current;
    if (!scroller) return;
    const handleWheel = (event: WheelEvent) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      // Preserve native horizontal trackpad gestures. A regular vertical
      // mouse wheel over the tab strip moves the tabs horizontally instead.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const previousScrollLeft = scroller.scrollLeft;
      scroller.scrollLeft += event.deltaY;
      if (scroller.scrollLeft !== previousScrollLeft) event.preventDefault();
    };
    scroller.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      scroller.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // Keep Tab inside the expanded dialog so keyboard users cannot reach the
  // background while it is open.
  const handleExpandedPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !expandedPanelRef.current) return;
    const nestedDialog = (event.target as HTMLElement).closest?.('[role="dialog"]');
    if (nestedDialog && nestedDialog !== expandedPanelRef.current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setExpandedTabId(null);
      return;
    }
    if (event.key !== "Tab") return;
    const available = previewFocusables(expandedPanelRef.current);
    if (available.length === 0) { event.preventDefault(); return; }
    const first = available[0];
    const last = available[available.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === expandedPanelRef.current)) {
      event.preventDefault();
      focusPreviewElement(last, true);
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === expandedPanelRef.current)) {
      event.preventDefault();
      focusPreviewElement(first);
    } else {
      const index = available.indexOf(document.activeElement as HTMLElement);
      const destination = available[index + (event.shiftKey ? -1 : 1)];
      if (destination?.tagName === "IFRAME") {
        event.preventDefault();
        focusPreviewElement(destination, event.shiftKey);
      }
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
      <div className="relative h-11 shrink-0 border-b border-border bg-surface">
        <div
          ref={tabScrollRef}
          role="tablist"
          aria-label={t("filePreview.openFiles")}
          className={cn(
            "h-11 overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            // Reserve a real layout column for the two floating controls. A
            // padding-only reservation still lets the scroll viewport extend
            // underneath them when the tabs are scrolled to the end.
            reserveControls && "mr-20",
          )}
        >
          <div className="flex h-11 w-max min-w-full px-1">
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
                  className="min-w-0 flex-1 truncate text-left text-ui-label outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
        {reserveControls && <PreviewPaneControls embedded />}
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
                expanded && "preview-focus fixed z-50 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl",
              )}
            >
              {mounted && (
                <ErrorBoundary>
                  <InspectorShell
                    inspector={tab.data}
                    onClose={() => closeTab(tab.id)}
                    cwd={cwd}
                    sessionId={sessionId}
                    focused={expanded}
                    compactHeader
                    controls={["file", "pdf", "artifact", "notebook-file"].includes(tab.data.variant) ? (
                      <IconButton
                        icon={expanded ? Minimize2 : Maximize2}
                        label={t(expanded ? "filePreview.exitFocus" : "filePreview.focus")}
                        size="compact"
                        className="hidden text-text lg:inline-flex"
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
