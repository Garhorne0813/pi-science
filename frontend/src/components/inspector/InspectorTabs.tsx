import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Inspector } from "../../types/thread";
import { useUiStore, type InspectorTab } from "@/lib/ui";
import { cn } from "@/lib/ui";
import { ErrorBoundary } from "../ErrorBoundary";
import { InspectorShell } from "./InspectorShell";

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
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              id={`inspector-panel-${index}`}
              role="tabpanel"
              hidden={!active}
              className="h-full"
            >
              <ErrorBoundary>
                <InspectorShell
                  inspector={tab.data}
                  onClose={() => closeTab(tab.id)}
                  cwd={cwd}
                  compactHeader
                />
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
}
