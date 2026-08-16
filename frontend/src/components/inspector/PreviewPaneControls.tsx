import { Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn, useUiStore } from "@/lib/ui";
import { notifyInspectorLayoutChange } from "@/lib/ui/inspector-layout";
import { IconButton } from "../ui/Icon";

export function PreviewPaneControls({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const inspectorMaximized = useUiStore((state) => state.inspectorMaximized);
  const previewPaneSide = useUiStore((state) => state.previewPaneSide);
  const hasTabs = useUiStore((state) => state.inspectorTabs.length > 0);
  const setInspectorVisible = useUiStore((state) => state.setInspectorVisible);
  const setInspectorMaximized = useUiStore((state) => state.setInspectorMaximized);
  const visibilityIcon = previewPaneSide === "left"
    ? (inspectorOpen ? PanelLeftClose : PanelLeftOpen)
    : (inspectorOpen ? PanelRightClose : PanelRightOpen);

  return (
    <div className={cn(
      "right-card top-0 z-30 hidden h-control items-center gap-2 lg:flex",
      embedded ? "absolute" : "fixed",
    )}>
      {inspectorOpen && hasTabs && (
        <IconButton
          icon={inspectorMaximized ? Minimize2 : Maximize2}
          label={t(inspectorMaximized ? "shell.restorePanelWidth" : "shell.expandPanel")}
          size="compact"
          className="text-text"
          aria-pressed={inspectorMaximized}
          onClick={() => {
            setInspectorMaximized(!inspectorMaximized);
            notifyInspectorLayoutChange();
          }}
        />
      )}
      <IconButton
        icon={visibilityIcon}
        label={t(inspectorOpen ? "shell.hideInspector" : "shell.showInspector")}
        size="compact"
        className={inspectorOpen ? "bg-surface text-text" : "text-text"}
        aria-pressed={inspectorOpen}
        disabled={!hasTabs}
        onClick={() => setInspectorVisible(!inspectorOpen)}
      />
    </div>
  );
}
