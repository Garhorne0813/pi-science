import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Play, X } from "lucide-react";
import type { FileRoot } from "../../types/thread";
import { readArtifact } from "../../lib/files";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { PaneTitlebarInset } from "../inspector/RightPane";
import { cn } from "../../lib/cn";
import {
  notebookKernel,
  kernelShutdownUrl,
  outputText,
  parseNotebookDocument,
  sourceText,
  stableNotebookId,
  type NotebookCell,
  type NotebookOutput,
} from "./notebook-model";

interface CellResult {
  ok: boolean;
  stdout: string;
  result: string | null;
  error: string | null;
}

interface EditableCell extends NotebookCell {
  id: string;
  code: string;
  running: boolean;
  liveResult: CellResult | null;
}

export function NotebookEditor({
  path,
  root,
  cwd = ".",
  onClose,
  controls,
}: {
  path: string;
  root?: FileRoot;
  cwd?: string;
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  const [cells, setCells] = useState<EditableCell[]>([]);
  const [language, setLanguage] = useState<"python" | "r" | "unsupported">("python");
  const [languageLabel, setLanguageLabel] = useState("Python");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const notebookId = useMemo(() => stableNotebookId(path), [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCells([]);

    void readArtifact(path, root, cwd)
      .then((file) => {
        if (cancelled) return;
        if (!file || file.encoding !== "utf8") {
          throw new Error("Notebook file is unavailable or is not UTF-8 JSON");
        }
        const notebook = parseNotebookDocument(file.data);
        const kernel = notebookKernel(notebook);
        setLanguage(kernel.language);
        setLanguageLabel(kernel.label);
        setCells(notebook.cells.map((cell, index) => ({
          ...cell,
          id: `cell-${index}`,
          code: sourceText(cell.source),
          running: false,
          liveResult: null,
        })));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, path, root]);

  useEffect(() => () => {
    void fetch(kernelShutdownUrl(notebookId, cwd), {
      method: "POST",
    }).catch(() => undefined);
  }, [cwd, notebookId]);

  const updateCode = (cellId: string, code: string) => {
    setCells((current) => current.map((cell) => (
      cell.id === cellId ? { ...cell, code } : cell
    )));
  };

  const runCell = async (cellId: string) => {
    const cell = cells.find((candidate) => candidate.id === cellId);
    if (!cell || cell.cell_type !== "code" || !cell.code.trim() || language === "unsupported") return;
    setCells((current) => current.map((candidate) => (
      candidate.id === cellId ? { ...candidate, running: true, liveResult: null } : candidate
    )));
    try {
      const params = new URLSearchParams({ cwd });
      const response = await fetch(`/api/kernels/execute?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          code: cell.code,
          notebook_id: notebookId,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `Cell execution failed: ${response.statusText}`);
      setCells((current) => current.map((candidate) => (
        candidate.id === cellId
          ? { ...candidate, running: false, liveResult: payload as CellResult }
          : candidate
      )));
    } catch (cause) {
      setCells((current) => current.map((candidate) => (
        candidate.id === cellId
          ? {
              ...candidate,
              running: false,
              liveResult: {
                ok: false,
                stdout: "",
                result: null,
                error: cause instanceof Error ? cause.message : String(cause),
              },
            }
          : candidate
      )));
    }
  };

  const filename = path.split(/[\\/]/).pop() || path;
  const runnable = language !== "unsupported";

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{filename}</span>
        <span className={cn(
          "rounded-full px-2 py-0.5 text-[11px] ring-1",
          runnable ? "bg-ok/10 text-ok ring-ok/20" : "bg-warn/10 text-warn ring-warn/20",
        )}>
          {languageLabel}
        </span>
        {controls}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notebook"
          className="flex h-9 w-9 items-center justify-center rounded-input text-text hover:bg-surface-2"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2 p-3 sm:p-4">
        {loading && (
          <div className="flex items-center gap-2 rounded-card border border-border bg-surface p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Loading notebook…
          </div>
        )}
        {!loading && error && (
          <div role="alert" className="flex items-start gap-2 rounded-card border border-error/30 bg-error/5 p-4 text-sm text-error">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {!loading && !error && cells.length === 0 && (
          <div className="rounded-card border border-border bg-surface p-8 text-center text-sm text-muted">
            This notebook contains no cells.
          </div>
        )}
        {!loading && !error && !runnable && (
          <div role="status" className="mb-3 rounded-input border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
            Viewing is available, but execution currently supports Python and R kernels only.
          </div>
        )}
        <div className="space-y-3">
          {cells.map((cell, index) => (
            <NotebookCellView
              key={cell.id}
              cell={cell}
              index={index}
              runnable={runnable}
              onCodeChange={(code) => updateCode(cell.id, code)}
              onRun={() => void runCell(cell.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function NotebookCellView({
  cell,
  index,
  runnable,
  onCodeChange,
  onRun,
}: {
  cell: EditableCell;
  index: number;
  runnable: boolean;
  onCodeChange: (code: string) => void;
  onRun: () => void;
}) {
  if (cell.cell_type === "markdown") {
    return (
      <section className="rounded-card border border-border bg-surface px-5 py-4">
        <MarkdownViewer>{cell.code}</MarkdownViewer>
      </section>
    );
  }
  if (cell.cell_type !== "code") {
    return (
      <section className="rounded-card border border-border bg-surface p-4">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Raw cell {index + 1}</div>
        <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-text">{cell.code}</pre>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex min-h-11 items-center gap-2 border-b border-faint bg-surface-2 px-3">
        <span className="font-mono text-[11px] tabular-nums text-muted">
          In [{cell.execution_count ?? " "}]
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRun}
          disabled={!runnable || cell.running || !cell.code.trim()}
          aria-label={`Run code cell ${index + 1}`}
          className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-xs font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {cell.running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {cell.running ? "Running" : "Run"}
        </button>
      </div>
      <textarea
        value={cell.code}
        onChange={(event) => onCodeChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onRun();
          }
        }}
        aria-label={`Code cell ${index + 1}`}
        spellCheck={false}
        rows={Math.max(3, Math.min(18, cell.code.split("\n").length + 1))}
        className="block w-full resize-y bg-surface px-4 py-3 font-mono text-[13px] leading-5 text-text outline-none focus:ring-2 focus:ring-inset focus:ring-accent/40"
      />
      {cell.liveResult ? (
        <LiveResult result={cell.liveResult} />
      ) : (
        <StoredOutputs outputs={cell.outputs || []} />
      )}
    </section>
  );
}

function LiveResult({ result }: { result: CellResult }) {
  if (!result.stdout && !result.result && !result.error) return null;
  return (
    <div className="space-y-2 border-t border-faint px-4 py-3 font-mono text-xs leading-5">
      {result.stdout && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-text">{result.stdout}</pre>}
      {result.result && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-accent">{result.result}</pre>}
      {result.error && <pre role="alert" className="max-h-64 overflow-auto whitespace-pre-wrap text-error">{result.error}</pre>}
    </div>
  );
}

function StoredOutputs({ outputs }: { outputs: NotebookOutput[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-faint px-4 py-3 font-mono text-xs leading-5">
      {outputs.map((output, index) => {
        const text = outputText(output);
        const image = output.data?.["image/png"];
        return (
          <div key={index}>
            {text && (
              <pre className={cn(
                "max-h-64 overflow-auto whitespace-pre-wrap",
                output.output_type === "error" ? "text-error" : "text-text",
              )}>
                {text}
              </pre>
            )}
            {typeof image === "string" && (
              <img
                src={`data:image/png;base64,${image}`}
                alt={`Notebook output ${index + 1}`}
                className="mt-2 max-h-80 max-w-full rounded-input bg-white object-contain"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
