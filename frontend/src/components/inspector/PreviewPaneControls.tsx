import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "@/lib/ui";
import { IconButton } from "../ui/Icon";

export function PreviewPaneControls() {
  const { t } = useTranslation();
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const inspectorMaximized = useUiStore((state) => state.inspectorMaximized);
  const hasTabs = useUiStore((state) => state.inspectorTabs.length > 0);
  const setInspectorVisible = useUiStore((state) => state.setInspectorVisible);
  const setInspectorMaximized = useUiStore((state) => state.setInspectorMaximized);

  return (
    <div className="fixed right-card top-0 z-30 hidden h-control items-center gap-2 lg:flex">
      {inspectorOpen && hasTabs && (
        <IconButton
          icon={inspectorMaximized ? Minimize2 : Maximize2}
          label={t(inspectorMaximized ? "shell.restorePanelWidth" : "shell.expandPanel")}
          size="compact"
          className="text-text"
          aria-pressed={inspectorMaximized}
          onClick={() => setInspectorMaximized(!inspectorMaximized)}
        />
      )}
      <IconButton
        icon={inspectorOpen ? PanelRightClose : PanelRightOpen}
        label={t(inspectorOpen ? "shell.hideInspector" : "shell.showInspector")}
        size="compact"
        className="text-text"
        aria-pressed={inspectorOpen}
        disabled={!hasTabs}
        onClick={() => setInspectorVisible(!inspectorOpen)}
      />
    </div>
  );
}
