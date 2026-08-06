import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "@/lib/ui";

export function PreviewPaneControls() {
  const { t } = useTranslation();
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const inspectorMaximized = useUiStore((state) => state.inspectorMaximized);
  const hasTabs = useUiStore((state) => state.inspectorTabs.length > 0);
  const setInspectorVisible = useUiStore((state) => state.setInspectorVisible);
  const setInspectorMaximized = useUiStore((state) => state.setInspectorMaximized);

  return (
    <div className="fixed right-4 top-0 z-30 hidden h-9 items-center gap-1 lg:flex">
      {inspectorOpen && hasTabs && (
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text"
          aria-label={t(inspectorMaximized ? "shell.restorePanelWidth" : "shell.expandPanel")}
          title={t(inspectorMaximized ? "shell.restorePanelWidth" : "shell.expandPanel")}
          aria-pressed={inspectorMaximized}
          onClick={() => setInspectorMaximized(!inspectorMaximized)}
        >
          {inspectorMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      )}
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
        aria-label={t(inspectorOpen ? "shell.hideInspector" : "shell.showInspector")}
        title={t(inspectorOpen ? "shell.hideInspector" : "shell.showInspector")}
        aria-pressed={inspectorOpen}
        disabled={!hasTabs}
        onClick={() => setInspectorVisible(!inspectorOpen)}
      >
        {inspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
    </div>
  );
}
