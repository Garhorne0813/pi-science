import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Inspector } from "../../types/thread";
import { useUiStore, type InspectorTab } from "@/lib/ui";
import { cn } from "@/lib/ui";
import { ErrorBoundary } from "../ErrorBoundary";
import { InspectorShell } from "./InspectorShell";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function tabTitle(data: Inspector): string {
  switch (data.variant) {
    case "file": return data.filename;
    case "notebook-file": return data.path.split(/[\\/]/).pop() || data.path;
    case "pdf": return data.filename || data.path?.split(/[\\/]/).pop() || "PDF";
    case "artifact": return data.filename || data.title;
    case "notebook": return data.notebookId;
    case "notebook-panel": return "Notebook";
  }
}

export function InspectorTabs({
  tabs,
  activeTabId,
  cwd,
}: {
  tabs: InspectorTab[];
  activeTabId: string;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const activateTab = useUiStore((state) => state.activateInspectorTab);
  const closeTab = useUiStore((state) => state.closeInspectorTab);
  const [expandedTabId, setExpandedTabId] = useState<string | null>(null);
  const [zoomByTab, setZoomByTab] = useState<Record<string, number>>({});
  const expandedPanelRef = useRef<HTMLDivElement | null>(null);

  const setTabZoom = (tabId: string, update: (current: number) => number) => {
    setZoomByTab((current) => ({
      ...current,
      [tabId]: clampZoom(update(current[tabId] ?? 1)),
    }));
  };

  useEffect(() => {
    if (!expandedTabId) return;
    if (expandedTabId !== activeTabId || !tabs.some((tab) => tab.id === expandedTabId)) {
      setExpandedTabId(null);
    }
  }, [activeTabId, expandedTabId, tabs]);

  useEffect(() => {
    if (!expandedTabId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedTabId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
      <div
        role="tablist"
        aria-label={t("filePreview.openFiles")}
        className="flex h-9 shrink-0 overflow-x-auto border-b border-border bg-surface px-1"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const title = tabTitle(tab.data);
          return (
            <div
              key={tab.id}
              title={title}
              className={cn(
                "group relative flex min-w-[7rem] max-w-48 shrink-0 cursor-default items-center gap-1.5 border-r border-border px-2 text-xs outline-none",
                active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60 hover:text-text",
                "focus-within:ring-2 focus-within:ring-inset focus-within:ring-accent",
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
                className="min-w-0 flex-1 truncate text-left outline-none"
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
              <button
                type="button"
                aria-label={t("filePreview.closeTab", { filename: title })}
                className={cn(
                  "rounded p-0.5 hover:bg-border hover:text-text",
                  active ? "text-muted" : "text-transparent group-hover:text-muted group-focus-within:text-muted",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="min-h-0 flex-1">
        {expandedTabId && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            onClick={() => setExpandedTabId(null)}
          />
        )}
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const expanded = tab.id === expandedTabId;
          const title = tabTitle(tab.data);
          const zoom = zoomByTab[tab.id] ?? 1;
          return (
            <div
              ref={expanded ? expandedPanelRef : undefined}
              key={tab.id}
              id={`inspector-panel-${index}`}
              role={expanded ? "dialog" : "tabpanel"}
              aria-modal={expanded || undefined}
              aria-label={expanded ? title : undefined}
              hidden={!active}
              style={expanded ? { width: "92vw", height: "92vh", left: "4vw", top: "4vh" } : undefined}
              className={cn(
                "h-full",
                expanded && "fixed z-50 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl",
              )}
            >
              <ErrorBoundary>
                <InspectorShell
                  inspector={tab.data}
                  onClose={() => closeTab(tab.id)}
                  cwd={cwd}
                  compactHeader
                  contentZoom={expanded ? zoom : 1}
                  controls={tab.data.variant === "file" ? (
                    <>
                      <button
                        type="button"
                        className="text-text hover:opacity-60"
                        aria-label={t(expanded ? "shell.restorePanel" : "shell.maximizePanel")}
                        title={t(expanded ? "shell.restorePanel" : "shell.maximizePanel")}
                        aria-pressed={expanded}
                        onClick={() => setExpandedTabId(expanded ? null : tab.id)}
                      >
                        {expanded ? <Minimize2 size={14} strokeWidth={1.5} /> : <Maximize2 size={14} strokeWidth={1.5} />}
                      </button>
                      {expanded && (
                        <div className="flex items-center rounded-input bg-surface-2 p-0.5">
                          <button
                            type="button"
                            className="rounded p-1 text-muted hover:bg-surface hover:text-text disabled:opacity-35"
                            aria-label={t("filePreview.zoomOut")}
                            disabled={zoom <= MIN_ZOOM}
                            onClick={() => setTabZoom(tab.id, (current) => current - ZOOM_STEP)}
                          >
                            <Minus size={13} />
                          </button>
                          <button
                            type="button"
                            className="min-w-12 rounded px-1 py-0.5 text-[11px] tabular-nums text-muted hover:bg-surface hover:text-text"
                            aria-label={t("filePreview.resetZoom")}
                            title={t("filePreview.resetZoom")}
                            onClick={() => setTabZoom(tab.id, () => 1)}
                          >
                            {Math.round(zoom * 100)}%
                          </button>
                          <button
                            type="button"
                            className="rounded p-1 text-muted hover:bg-surface hover:text-text disabled:opacity-35"
                            aria-label={t("filePreview.zoomIn")}
                            disabled={zoom >= MAX_ZOOM}
                            onClick={() => setTabZoom(tab.id, (current) => current + ZOOM_STEP)}
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                      )}
                    </>
                  ) : undefined}
                />
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
}
