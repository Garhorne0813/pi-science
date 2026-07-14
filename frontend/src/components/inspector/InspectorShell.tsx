import type { Inspector } from "../../types/thread";
import { FilePreviewInspector } from "./FilePreviewInspector";
import { NotebookPanel } from "./NotebookPanel";
import { useRuntimeStore } from "../../lib/runtime-store";

/** Right pane. Renders the correct inspector variant. */
export function InspectorShell({
  inspector,
  onClose,
  onEvaluate,
  controls,
}: {
  inspector: Inspector;
  onClose: () => void;
  onEvaluate?: (expr: string) => void;
  controls?: React.ReactNode;
}) {
  const cwd = useRuntimeStore((state) => state.cwd);

  return (
    <div className="h-full border-l border-border bg-surface" data-variant={inspector.variant}>
      {inspector.variant === "file" && (
        <FilePreviewInspector data={inspector} onClose={onClose} controls={controls} />
      )}
      {inspector.variant === "notebook-panel" && (
        <NotebookPanel onClose={onClose} cwd={cwd} />
      )}
      {inspector.variant === "artifact" && (
        <ArtifactStub data={inspector} onClose={onClose} controls={controls} />
      )}
      {inspector.variant === "pdf" && (
        <PdfStub data={inspector} onClose={onClose} controls={controls} />
      )}
      {(inspector.variant === "notebook" || inspector.variant === "notebook-file") && (
        <NotebookStub data={inspector} onClose={onClose} controls={controls} />
      )}
      {!["file", "artifact", "pdf", "notebook", "notebook-file"].includes(inspector.variant) && (
        <div className="flex items-center justify-center h-full text-muted text-sm">
          Unknown inspector type: {inspector.variant}
        </div>
      )}
    </div>
  );
}

// ── Stubs for not-yet-ported inspectors ──

function ArtifactStub({ data, onClose }: { data: any; onClose: () => void; controls?: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <span className="text-sm font-medium">{data.filename || data.title || "Artifact"}</span>
        <button onClick={onClose} className="text-muted hover:text-text text-sm">✕</button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {data.code ? (
          <pre className="text-xs font-mono text-muted whitespace-pre-wrap">{data.code}</pre>
        ) : (
          <p className="text-sm text-muted">Binary artifact — open from workspace to view.</p>
        )}
      </div>
    </div>
  );
}

function PdfStub({ data, onClose }: { data: any; onClose: () => void; controls?: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <span className="text-sm font-medium">{data.filename || "PDF"}</span>
        <button onClick={onClose} className="text-muted hover:text-text text-sm">✕</button>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted">PDF viewer not yet available. Download to view.</p>
      </div>
    </div>
  );
}

function NotebookStub({ data, onClose }: { data: any; onClose: () => void; controls?: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <span className="text-sm font-medium">Notebook</span>
        <button onClick={onClose} className="text-muted hover:text-text text-sm">✕</button>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted">Notebook editor not yet ported.</p>
      </div>
    </div>
  );
}
