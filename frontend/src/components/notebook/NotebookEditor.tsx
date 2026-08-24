import { useEffect, useMemo, useState } from "react";
import { AlertCircle, BookOpen, ExternalLink, Loader2, Pencil, Play, Save, Square, X } from "lucide-react";
import type { FileRoot } from "../../types/thread";
import { readArtifact, writeArtifact } from "../../lib/files";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { cn } from "../../lib/ui";
import {
  notebookKernel,
  outputText,
  parseNotebookDocument,
  sourceText,
  stableCellId,
  stableNotebookId,
  type NotebookCell,
  type NotebookDocument,
  type NotebookOutput,
} from "./notebook-model";
import { notebookRuntime, type CellResult } from "../../lib/notebook";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { openJsonEventStream } from "../../lib/client/event-stream";
import { NotebookCodePreview } from "./NotebookCodePreview";
import { NotebookMimeOutput } from "./NotebookMimeOutput";

interface EditableCell extends NotebookCell {
  id: string;
  code: string;
  running: boolean;
  liveResult: CellResult | null;
}

export function NotebookEditor({
  path,
  root,
  cwd,
  sessionId,
  onClose,
  controls,
}: {
  path: string;
  root?: FileRoot;
  cwd: string;
  sessionId?: string;
  onClose: () => void;
  controls?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [cells, setCells] = useState<EditableCell[]>([]);
  const [language, setLanguage] = useState<"python" | "r" | "unsupported">("python");
  const [languageLabel, setLanguageLabel] = useState("Python");
  const [loading, setLoading] = useState(true);
  const [document, setDocument] = useState<NotebookDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openingJupyter, setOpeningJupyter] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notebookId = useMemo(() => stableNotebookId(path), [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCells([]);
    setDocument(null);
    setDirty(false);

    void readArtifact(path, root, cwd)
      .then((file) => {
        if (cancelled) return;
        if (!file || file.encoding !== "utf8") {
          throw new Error("notebook_unavailable");
        }
        const notebook = parseNotebookDocument(file.data);
        setDocument(notebook);
        const kernel = notebookKernel(notebook);
        setLanguage(kernel.language);
        setLanguageLabel(kernel.label);
        setCells(notebook.cells.map((cell, index) => ({
          ...cell,
          id: stableCellId(cell, index, path),
          code: sourceText(cell.source),
          running: false,
          liveResult: null,
        })));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error && cause.message === "notebook_unavailable" ? t("notebook.fileUnavailable") : cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, path, root, t]);

  const updateCode = (cellId: string, code: string) => {
    setDirty(true);
    setCells((current) => current.map((cell) => (
      cell.id === cellId ? { ...cell, code } : cell
    )));
  };

  const saveNotebook = async () => {
    if (!document || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next: NotebookDocument = {
        ...document,
        cells: cells.map(({ id, code, running: _running, liveResult, ...cell }) => ({
          ...cell,
          id,
          source: code,
          ...(liveResult ? { outputs: resultOutputs(liveResult) } : {}),
        })),
      };
      await writeArtifact(path, root, cwd, JSON.stringify(next, null, 2) + "\n");
      setDocument(next);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const runCell = async (cellId: string) => {
    const cell = cells.find((candidate) => candidate.id === cellId);
    if (!cell || cell.cell_type !== "code" || !cell.code.trim() || language === "unsupported") return;
    setCells((current) => current.map((candidate) => (
      candidate.id === cellId ? { ...candidate, running: true, liveResult: { ok: true, stdout: "", stderr: "", result: null, error: null } } : candidate
    )));
    try {
      const payload = await notebookRuntime.executeStreaming(notebookId, cwd, language, cell.code, sessionId, { source: "file_notebook", notebookPath: path, cellId }, (event) => {
        if (event.type !== "stream") return;
        setCells((current) => current.map((candidate) => {
          if (candidate.id !== cellId) return candidate;
          const result = candidate.liveResult ?? { ok: true, stdout: "", stderr: "", result: null, error: null };
          return { ...candidate, liveResult: { ...result, [event.stream]: `${result[event.stream] || ""}${event.text}` } };
        }));
      });
      setCells((current) => current.map((candidate) => (
        candidate.id === cellId
          ? { ...candidate, running: false, liveResult: payload }
          : candidate
      )));
      setDirty(true);
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
      setDirty(true);
    }
  };

  const filename = path.split(/[\\/]/).pop() || path;
  const runnable = language !== "unsupported";
  const interruptKernel = async () => {
    if (language === "unsupported" || interrupting) return;
    setInterrupting(true);
    try { await notebookRuntime.interrupt(notebookId, cwd, language); }
    finally { setInterrupting(false); }
  };
  const requestClose = () => {
    if (!dirty || window.confirm("Discard unsaved notebook changes?")) onClose();
  };

  const openInJupyter = async () => {
    const target = window.open("about:blank", "_blank");
    setOpeningJupyter(true); setError(null);
    try {
      const status = await apiRequest<{ env_ready?: boolean }>(`/api/notebooks/jupyter/status?cwd=${encodeURIComponent(cwd)}`);
      if (!status.env_ready) await setupJupyter(cwd);
      const started = await apiRequest<{ url: string }>(`/api/notebooks/jupyter/start?cwd=${encodeURIComponent(cwd)}`, { method: "POST" });
      const url = new URL(started.url);
      url.pathname = `/lab/tree/${path.split("/").map(encodeURIComponent).join("/")}`;
      if (target) target.location.href = url.toString(); else window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch (cause) {
      target?.close();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setOpeningJupyter(false); }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><BookOpen size={14} /></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text">{filename}</div>
          <div className="truncate font-mono text-[9px] text-muted">{path}</div>
        </div>
        <span className={cn(
          "rounded-full px-2 py-0.5 text-[11px] ring-1",
          runnable ? "bg-ok/10 text-ok-text ring-ok/20" : "bg-warn/10 text-warn-text ring-warn/20",
        )}>
          {languageLabel}
        </span>
        {dirty && <span className="text-[11px] text-warn">Unsaved</span>}
        <button type="button" onClick={() => void openInJupyter()} disabled={openingJupyter} className="flex h-9 items-center gap-1.5 rounded-input border border-border px-3 text-xs text-text hover:bg-surface-2 disabled:opacity-40">
          {openingJupyter ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />} JupyterLab
        </button>
        <button type="button" onClick={() => void saveNotebook()} disabled={!dirty || saving} className="flex h-9 items-center gap-1.5 rounded-input border border-border px-3 text-xs text-text hover:bg-surface-2 disabled:opacity-40">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
        </button>
        {controls}
        <button
          type="button"
          onClick={requestClose}
          aria-label={t("notebook.close")}
          className="flex h-9 w-9 items-center justify-center rounded-input text-text hover:bg-surface-2"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
        {loading && (
          <div className="m-4 flex items-center gap-2 rounded-card border border-border bg-surface-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> {t("notebook.loading")}
          </div>
        )}
        {!loading && error && (
          <div role="alert" className="m-4 flex items-start gap-2 rounded-card border border-error/30 bg-error/5 p-4 text-sm text-error-text">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {!loading && !error && cells.length === 0 && (
          <div className="p-12 text-center text-sm text-muted">
            {t("notebook.empty")}
          </div>
        )}
        {!loading && !error && !runnable && (
          <div role="status" className="m-4 rounded-input border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn-text">
            {t("notebook.unsupportedKernel")}
          </div>
        )}
        <div className="w-full bg-surface">
          {cells.map((cell, index) => (
            <NotebookCellView
              key={cell.id}
              cell={cell}
              index={index}
              runnable={runnable}
              language={language === "r" ? "r" : "python"}
              onCodeChange={(code) => updateCode(cell.id, code)}
              onRun={() => void runCell(cell.id)}
              onInterrupt={() => void interruptKernel()}
              interrupting={interrupting}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function resultOutputs(result: CellResult): NotebookOutput[] {
  const outputs: NotebookOutput[] = [];
  if (result.stdout) outputs.push({ output_type: "stream", name: "stdout", text: result.stdout });
  if (result.result || Object.keys(result.mime || {}).length > 0) {
    outputs.push({
      output_type: "execute_result",
      data: {
        ...(result.result ? { "text/plain": result.result } : {}),
        ...(result.mime || {}),
      },
    });
  }
  if (result.error) outputs.push({ output_type: "error", ename: "ExecutionError", evalue: result.error, traceback: [result.error] });
  return outputs;
}

function setupJupyter(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let close: () => void = () => {};
    close = openJsonEventStream<{ status: string; text: string }>(`/api/notebooks/jupyter/setup?cwd=${encodeURIComponent(cwd)}`, {
      onMessage: (event) => {
        if (event.status === "done") { close(); resolve(); }
        else if (event.status === "error") { close(); reject(new Error(event.text)); }
      },
      onError: () => { close(); reject(new Error("Jupyter runtime setup failed")); },
    });
  });
}

function NotebookCellView({
  cell,
  index,
  runnable,
  language,
  onCodeChange,
  onRun,
  onInterrupt,
  interrupting,
}: {
  cell: EditableCell;
  index: number;
  runnable: boolean;
  language: "python" | "r";
  onCodeChange: (code: string) => void;
  onRun: () => void;
  onInterrupt: () => void;
  interrupting: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  if (cell.cell_type === "markdown") {
    return (
      <section className="border-b border-faint px-6 py-5 last:border-b-0">
        <MarkdownViewer>{cell.code}</MarkdownViewer>
      </section>
    );
  }
  if (cell.cell_type !== "code") {
    return (
      <section className="border-b border-faint p-4 last:border-b-0">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{t("notebook.rawCell", { index: index + 1 })}</div>
        <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-text">{cell.code}</pre>
      </section>
    );
  }

  return (
    <section className="group/cell border-b border-faint bg-surface px-4 py-4 transition-colors last:border-b-0 hover:bg-[color-mix(in_srgb,var(--surface-2)_24%,var(--surface))]">
      <div className="mb-2 flex min-h-8 items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-muted">
          In [{cell.execution_count ?? " "}]
        </span>
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-muted">code</span>
        <div className="flex-1" />
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="flex min-h-8 items-center gap-1.5 rounded-input px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-text">
            <Pencil size={12} /> Edit
          </button>
        )}
        {cell.running ? (
          <button type="button" onClick={onInterrupt} disabled={interrupting} className="flex min-h-8 items-center gap-1.5 rounded-input bg-error px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
            {interrupting ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} fill="currentColor" />} {t("common.stop")}
          </button>
        ) : (
          <button
            type="button"
            onClick={onRun}
            disabled={!runnable || !cell.code.trim()}
            aria-label={t("notebook.runCell", { index: index + 1 })}
            className="flex min-h-8 items-center gap-1.5 rounded-input bg-accent px-3 text-xs font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play size={13} /> {t("common.run")}
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={cell.code}
          onChange={(event) => onCodeChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              setEditing(false);
              onRun();
            }
            if (event.key === "Escape") setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          aria-label={t("notebook.codeCell", { index: index + 1 })}
          spellCheck={false}
          rows={Math.max(4, Math.min(18, cell.code.split("\n").length + 1))}
          className="block w-full resize-y rounded-lg border border-accent/35 bg-[var(--surface-inset)] px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-text outline-none shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_7%,transparent)]"
        />
      ) : (
        <NotebookCodePreview code={cell.code} language={language} className="rounded-lg border border-faint" />
      )}
      {cell.liveResult ? (
        <LiveResult result={cell.liveResult} />
      ) : (
        <StoredOutputs outputs={cell.outputs || []} />
      )}
    </section>
  );
}

function LiveResult({ result }: { result: CellResult }) {
  if (!result.stdout && !result.stderr && !result.result && !result.error && !Object.keys(result.mime || {}).length) return null;
  return (
    <div className="space-y-2 border-t border-faint px-4 py-3 font-mono text-xs leading-5">
      {result.stdout && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-text">{result.stdout}</pre>}
      {result.stderr && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-warn">{result.stderr}</pre>}
      {result.result && Object.keys(result.mime || {}).length === 0 && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-accent">{result.result}</pre>}
      {result.error && <pre role="alert" className={cn("max-h-64 overflow-auto whitespace-pre-wrap", result.interrupted ? "text-muted" : "text-error")}>{result.error}</pre>}
      {result.mime && Object.keys(result.mime).length > 0 && <NotebookMimeOutput mime={result.mime} label="Cell output" />}
    </div>
  );
}

function StoredOutputs({ outputs }: { outputs: NotebookOutput[] }) {
  const { t } = useTranslation();
  if (outputs.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-faint px-4 py-3 font-mono text-xs leading-5">
      {outputs.map((output, index) => {
        const png = mimeValue(output, "image/png");
        const jpeg = mimeValue(output, "image/jpeg");
        const svg = mimeValue(output, "image/svg+xml");
        const html = mimeValue(output, "text/html");
        const json = mimeValue(output, "application/json");
        const rich = Boolean(png || jpeg || svg || html || json);
        const text = rich && output.output_type !== "error" ? "" : outputText(output);
        const mime = Object.fromEntries(Object.entries({ "image/png": png, "image/jpeg": jpeg, "image/svg+xml": svg, "text/html": html, "application/json": json }).filter((entry): entry is [string, string] => Boolean(entry[1])));
        return (
          <div key={index} className="space-y-2">
            {text && (
              <pre className={cn(
                "max-h-64 overflow-auto whitespace-pre-wrap",
                output.output_type === "error" ? "text-error-text" : "text-text",
              )}>
                {text}
              </pre>
            )}
            {rich && <NotebookMimeOutput mime={mime} label={t("notebook.output", { index: index + 1 })} />}
          </div>
        );
      })}
    </div>
  );
}

function mimeValue(output: NotebookOutput, mime: string): string {
  const value = output.data?.[mime];
  return Array.isArray(value) ? value.join("") : value || "";
}
