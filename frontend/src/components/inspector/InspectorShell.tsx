import type { Inspector } from "../../types/thread";
import { FilePreviewInspector } from "./FilePreviewInspector";
import { ArtifactInspector } from "./ArtifactInspector";
import { PdfInspector } from "./PdfInspector";
import { NotebookPanel } from "./NotebookPanel";
import { NotebookEditor } from "../notebook/NotebookEditor";
import { useRuntimeStore } from "../../lib/agent-runtime";

/** Right pane. Renders the correct inspector variant. */
export function InspectorShell({
  inspector,
  onClose,
  leadingControls,
  controls,
  cwd: cwdOverride,
  sessionId,
  compactHeader = false,
  contentZoom = 1,
}: {
  inspector: Inspector;
  onClose: () => void;
  leadingControls?: React.ReactNode;
  controls?: React.ReactNode;
  cwd?: string;
  sessionId?: string;
  compactHeader?: boolean;
  contentZoom?: number;
}) {
  const runtimeCwd = useRuntimeStore((state) => state.cwd);
  const cwd = cwdOverride || runtimeCwd;

  return (
    <div className="h-full border-l border-border bg-surface" data-variant={inspector.variant}>
      {inspector.variant === "file" && (
        <FilePreviewInspector
          data={inspector}
          onClose={onClose}
          leadingControls={leadingControls}
          controls={controls}
          cwd={inspector.cwd || cwd}
          showTitle={!compactHeader}
          showClose={!compactHeader}
          showOpenExternally={!compactHeader}
          contentZoom={contentZoom}
          compactHeader={compactHeader}
        />
      )}
      {inspector.variant === "notebook-panel" && (
        <NotebookPanel onClose={onClose} cwd={cwd} sessionId={sessionId} />
      )}
      {inspector.variant === "artifact" && (
        <ArtifactInspector data={inspector} onClose={onClose} controls={controls} />
      )}
      {inspector.variant === "pdf" && (
        <PdfInspector data={inspector} onClose={onClose} controls={controls} cwd={cwd} />
      )}
      {inspector.variant === "notebook" && (
        <NotebookPanel onClose={onClose} cwd={cwd} notebookId={inspector.notebookId} sessionId={sessionId} />
      )}
      {inspector.variant === "notebook-file" && (
        <NotebookEditor
          path={inspector.path}
          root={inspector.root}
          cwd={inspector.cwd || cwd}
          sessionId={sessionId}
          onClose={onClose}
          controls={controls}
        />
      )}
      {!["file", "artifact", "pdf", "notebook", "notebook-file", "notebook-panel"].includes(inspector.variant) && (
        <div className="flex items-center justify-center h-full text-muted text-sm">
          Unknown inspector type: {inspector.variant}
        </div>
      )}
    </div>
  );
}
