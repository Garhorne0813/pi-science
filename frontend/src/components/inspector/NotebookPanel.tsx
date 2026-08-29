import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { notebookRuntime, type CellResult } from "../../lib/notebook";
import { useTranslation } from "react-i18next";
import { sessionRunsQuery } from "../../lib/runs";
import { subscribeExecutionInvalidation } from "../../lib/runs/execution-events";
import { apiRequest } from "../../lib/client/api";
import { Braces, ChevronDown, Loader2, Pencil, Play, Square, TerminalSquare, Trash2, X } from "lucide-react";
import { NotebookCodePreview } from "../notebook/NotebookCodePreview";
import { NotebookMimeOutput } from "../notebook/NotebookMimeOutput";
import { newNotebookCellId, type NotebookOutput } from "../notebook/notebook-model";
import { StoredOutputs } from "../notebook/NotebookOutputs";
import { cn } from "../../lib/ui";

interface Cell {
  id: string;
  code: string;
  language: "python" | "r";
  result: CellResult | null;
  running: boolean;
  editing: boolean;
}

export function NotebookPanel({ onClose, cwd, notebookId: requestedNotebookId, sessionId }: { onClose: () => void; cwd?: string; notebookId?: string; sessionId?: string }) {
  const { t } = useTranslation();
  const [notebookId] = useState(() => requestedNotebookId || (sessionId ? `session-${sessionId}` : `nb-${Date.now()}`));
  const [cells, setCells] = useState<Cell[]>([]);
  const [interpreters, setInterpreters] = useState<{ python: boolean; r: boolean } | null>(null);
  const [draft, setDraft] = useState(() => {
    try { return window.localStorage.getItem(`pi-science:kernel-draft:${notebookId}`) || ""; }
    catch { return ""; }
  });
  const [draftLanguage, setDraftLanguage] = useState<"python" | "r">("python");
  const [interrupting, setInterrupting] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);

  // Check kernel availability on mount
  useEffect(() => {
    notebookRuntime.capabilities()
      .then(setInterpreters)
      .catch(() => setInterpreters({ python: false, r: false }));
  }, []);

  const { data: executions = [] } = useQuery({
    ...sessionRunsQuery(cwd || ".", sessionId || "", liveConnected),
    enabled: Boolean(sessionId && cwd),
  });
  const { data: environment } = useQuery({
    queryKey: ["project-environment", cwd || "."],
    queryFn: () => apiRequest<{ display_name?: string; revision_id?: string; manager?: string }>(`/api/environments/workspace?cwd=${encodeURIComponent(cwd || ".")}`),
    enabled: Boolean(cwd),
  });

  useEffect(() => {
    if (!sessionId || !cwd) return;
    return subscribeExecutionInvalidation(cwd, { onConnectionChange: setLiveConnected });
  }, [cwd, sessionId]);

  useEffect(() => {
    try {
      const key = `pi-science:kernel-draft:${notebookId}`;
      if (draft) window.localStorage.setItem(key, draft); else window.localStorage.removeItem(key);
    } catch { /* storage can be disabled */ }
  }, [draft, notebookId]);

  useEffect(() => {
    if (interpreters && !interpreters.python && interpreters.r) setDraftLanguage("r");
  }, [interpreters]);

  const executeCell = useCallback(async (cellId: string, code: string, language: "python" | "r") => {
    setCells((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, running: true, result: { ok: true, stdout: "", stderr: "", result: null, error: null } } : c))
    );

    try {
      const data = await notebookRuntime.executeStreaming(notebookId, cwd || ".", language, code, sessionId, { source: "session_notebook", cellId }, (event) => {
        if (event.type !== "stream") return;
        setCells((current) => current.map((cell) => {
          if (cell.id !== cellId) return cell;
          const result = cell.result ?? { ok: true, stdout: "", stderr: "", result: null, error: null };
          return { ...cell, result: { ...result, [event.stream]: `${result[event.stream] || ""}${event.text}` } };
        }));
      });
      setCells((prev) =>
        prev.map((c) => (c.id === cellId ? { ...c, running: false, result: data, editing: false } : c))
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCells((prev) =>
        prev.map((c) =>
          c.id === cellId
            ? { ...c, running: false, editing: false, result: { ok: false, stdout: "", result: null, error: message } }
            : c
        )
      );
    }
  }, [notebookId, cwd, sessionId]);

  const runCell = useCallback(async (cellId: string) => {
    const cell = cells.find((candidate) => candidate.id === cellId);
    if (cell) await executeCell(cell.id, cell.code, cell.language);
  }, [cells, executeCell]);

  const submitDraft = useCallback(async () => {
    const code = draft.trimEnd();
    if (!code.trim() || !interpreters?.[draftLanguage]) return;
    const cell: Cell = { id: newNotebookCellId(), code, language: draftLanguage, result: null, running: true, editing: false };
    setCells((current) => [...current, cell]);
    setDraft("");
    await executeCell(cell.id, cell.code, cell.language);
  }, [draft, draftLanguage, executeCell, interpreters]);

  const interruptKernel = useCallback(async (language?: "python" | "r") => {
    setInterrupting(true);
    try { await notebookRuntime.interrupt(notebookId, cwd || ".", language); }
    finally { setInterrupting(false); }
  }, [cwd, notebookId]);

  const updateCellCode = useCallback((cellId: string, code: string) => {
    setCells((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, code } : c))
    );
  }, []);

  const removeCell = useCallback((cellId: string) => {
    setCells((prev) => prev.filter((c) => c.id !== cellId));
  }, []);

  const historicalCells = executions.filter((run) => run.kind === "kernel_cell").slice().reverse();
  const recordedExecutionIds = new Set(historicalCells.map((run) => run.execution_id));
  const pendingCells = cells.filter((cell) => !cell.result?.execution_id || !recordedExecutionIds.has(cell.result.execution_id));
  const runningCell = pendingCells.find((cell) => cell.running);
  const recordedKernelRunning = historicalCells.some((run) => run.status === "pending" || run.status === "running");
  const kernelsReady = Boolean(interpreters?.python || interpreters?.r);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent"><Braces size={14} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-text">{t("notebook.sessionKernel")}</span>
            {environment && <span className="max-w-36 truncate rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted" title={environment.revision_id}>{environment.display_name || environment.manager}</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
            <span className={cn("h-1.5 w-1.5 rounded-full", interpreters === null ? "animate-pulse bg-warn" : kernelsReady ? "bg-ok" : "bg-error")} />
            {interpreters === null
              ? t("notebook.checkingKernels")
              : kernelsReady
                ? t("notebook.kernelsReady", { kernels: `${interpreters?.python ? "Python" : ""}${interpreters?.python && interpreters?.r ? " / " : ""}${interpreters?.r ? "R" : ""}` })
                : t("notebook.noKernel")}
          </div>
        </div>
        {recordedKernelRunning && (
          <button onClick={() => void interruptKernel()} disabled={interrupting} className="flex h-8 items-center gap-1.5 rounded-lg border border-error/30 bg-error/5 px-2.5 text-[11px] font-medium text-error hover:bg-error/10 disabled:opacity-50">
            {interrupting ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} fill="currentColor" />} {t("common.stop")}
          </button>
        )}
        <button onClick={onClose} aria-label={t("notebook.close")} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"><X size={14} /></button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {historicalCells.length === 0 && pendingCells.length === 0 && (
          <div className="mx-auto flex max-w-xs flex-col items-center px-6 py-16 text-center">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-[var(--surface-raised)] text-muted shadow-card"><TerminalSquare size={18} /></div>
            <p className="text-sm font-medium text-text">{t("notebook.panelEmpty")}</p>
            <p className="mt-1.5 text-xs leading-5 text-muted">{t("notebook.namespaceHint")}</p>
          </div>
        )}

        <div className="divide-y divide-faint">
          {historicalCells.map((run, index) => {
            const interrupted = run.status === "interrupted";
            const failed = run.status === "failed" || (!interrupted && Boolean(run.result.error));
            const mime = mimeBundle(run.result.mime);
            const storedOutputs = Array.isArray((run.result as Record<string, unknown>).outputs)
              ? (run.result as Record<string, unknown>).outputs as NotebookOutput[]
              : [];
            const output = `${String(run.result.stdout_preview || "")}${storedOutputs.length > 0 || Object.keys(mime).length > 0 ? "" : String(run.result.output_preview || "")}${String(run.result.error || "")}`;
            return (
              <section key={run.execution_id} className="px-4 py-4 transition-colors hover:bg-[color-mix(in_srgb,var(--surface-2)_28%,transparent)]">
                <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted">
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums">[{historicalCells.length - index}]</span>
                    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 uppercase">{String(run.surface)}</span>
                    <span className={cn("rounded-md px-1.5 py-0.5", run.request.source === "session_notebook" ? "bg-accent/10 text-accent" : "bg-surface-2 text-muted")}>{run.request.source === "session_notebook" ? t("notebook.you") : t("notebook.agent")}</span>
                    {failed && <span className="rounded-md bg-error/10 px-1.5 py-0.5 text-error">{t("notebook.errorStatus")}</span>}
                    {interrupted && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-muted">{t("notebook.interruptedStatus")}</span>}
                  </div>
                  <span className={cn("flex items-center gap-1.5", run.status === "running" && "text-ok")}>
                    {run.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />}{run.status}
                  </span>
                </div>
                {typeof run.request.code === "string" && <NotebookCodePreview code={run.request.code} language={String(run.surface)} className="rounded-lg border border-faint" />}
                {output && (
                  <details className="mt-2" open={failed || run.request.source === "session_notebook"}>
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted hover:text-text"><ChevronDown size={11} /> {t("notebook.outputLabel")}</summary>
                    <pre className={cn("mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border-l-2 bg-[var(--surface-inset)] px-3 py-2 font-mono text-xs leading-5", failed ? "border-error text-error" : interrupted ? "border-border text-muted" : "border-border text-text")}>{output}</pre>
                  </details>
                )}
                {storedOutputs.length > 0 && <div className="mt-2"><StoredOutputs outputs={storedOutputs} /></div>}
                {storedOutputs.length === 0 && Object.keys(mime).length > 0 && <div className="mt-2"><NotebookMimeOutput mime={mime} label={t("notebook.output", { index: historicalCells.length - index })} /></div>}
                {run.files.written.length > 0 && <div className="mt-2 text-[11px] text-muted">{t("notebook.wroteFiles", { files: run.files.written.map((file) => file.path.split("/").pop()).join(", ") })}</div>}
              </section>
            );
          })}

          {pendingCells.map((cell, index) => (
            <section key={cell.id} className="px-4 py-4">
              <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted">
                <div className="flex items-center gap-2">
                  <span className="font-mono tabular-nums">[new {index + 1}]</span>
                  <span className="rounded-md bg-surface-2 px-1.5 py-0.5 uppercase">{cell.language}</span>
                  <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-accent">{t("notebook.you")}</span>
                </div>
                <div className="flex items-center gap-1">
                  {!cell.editing && <button onClick={() => setCells((current) => current.map((item) => item.id === cell.id ? { ...item, editing: true } : item))} className="flex h-7 items-center gap-1 rounded-md px-2 hover:bg-surface-2 hover:text-text"><Pencil size={11} /> {t("notebook.edit")}</button>}
                  {cell.running ? (
                    <button onClick={() => void interruptKernel(cell.language)} disabled={interrupting} className="flex h-7 items-center gap-1 rounded-md bg-error px-2 font-medium text-white hover:opacity-90 disabled:opacity-50"><Square size={10} fill="currentColor" /> {t("common.stop")}</button>
                  ) : (
                    <button onClick={() => void runCell(cell.id)} disabled={!cell.code.trim()} className="flex h-7 items-center gap-1 rounded-md bg-accent px-2 font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"><Play size={11} /> {t("common.run")}</button>
                  )}
                  <button onClick={() => removeCell(cell.id)} aria-label={t("notebook.removeCell")} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-error/10 hover:text-error"><Trash2 size={11} /></button>
                </div>
              </div>

              {cell.editing ? (
                <textarea
                  autoFocus
                  value={cell.code}
                  onChange={(event) => updateCellCode(cell.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void runCell(cell.id); }
                    if (event.key === "Escape" && cell.code.trim()) setCells((current) => current.map((item) => item.id === cell.id ? { ...item, editing: false } : item));
                  }}
                  placeholder={cell.language === "python" ? "# Run code in the shared kernel\nprint('hello')" : "# Run R in the shared kernel\nprint('hello')"}
                  spellCheck={false}
                  rows={Math.max(4, Math.min(18, cell.code.split("\n").length + 1))}
                  className="block w-full resize-y rounded-lg border border-accent/35 bg-[var(--surface-inset)] px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-text outline-none shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_7%,transparent)] placeholder:text-muted/60"
                />
              ) : <NotebookCodePreview code={cell.code} language={cell.language} className="rounded-lg border border-faint" />}

              {cell.result && (cell.result.stdout || cell.result.stderr || cell.result.result || cell.result.error || cell.result.outputs?.length) && (
                <div className={cn("mt-2 max-h-56 overflow-auto rounded-lg border-l-2 bg-[var(--surface-inset)] px-3 py-2 font-mono text-xs leading-5", cell.result.error && !cell.result.interrupted ? "border-error text-error" : cell.result.interrupted ? "border-border text-muted" : "border-border text-text")}>
                  {cell.result.stdout && <pre className="whitespace-pre-wrap">{cell.result.stdout}</pre>}
                  {cell.result.stderr && <pre className="whitespace-pre-wrap text-warn">{cell.result.stderr}</pre>}
                  {cell.result.outputs?.length ? <StoredOutputs outputs={cell.result.outputs} /> : null}
                  {!cell.result.outputs?.length && cell.result.result && Object.keys(cell.result.mime || {}).length === 0 && <pre className="whitespace-pre-wrap text-accent">{cell.result.result}</pre>}
                  {cell.result.error && <pre className="whitespace-pre-wrap">{cell.result.error}</pre>}
                </div>
              )}
              {!cell.result?.outputs?.length && cell.result?.mime && Object.keys(cell.result.mime).length > 0 && <div className="mt-2"><NotebookMimeOutput mime={cell.result.mime} label={t("notebook.output", { index: index + 1 })} /></div>}
            </section>
          ))}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-[var(--surface-inset)]">
        <div className="flex items-center justify-between border-b border-faint px-3 py-1 text-[10px] text-muted">
          <span className="flex items-center gap-1.5"><TerminalSquare size={11} /> {t("notebook.sharedKernel")}</span>
          <span className="max-w-32 truncate font-mono" title={notebookId}>{notebookId}</span>
        </div>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitDraft(); }
          }}
          placeholder={t("notebook.kernelInputPlaceholder")}
          spellCheck={false}
          rows={Math.max(2, Math.min(7, draft.split("\n").length))}
          className="block w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-5 text-text outline-none placeholder:text-muted/60"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2">
          {(["python", "r"] as const).filter((language) => interpreters?.[language]).map((language) => (
            <button key={language} type="button" onClick={() => setDraftLanguage(language)} className={cn("h-7 rounded-md px-2 text-[10px] font-medium uppercase transition-colors", draftLanguage === language ? "bg-[var(--surface-selected)] text-text" : "text-muted hover:bg-surface-2 hover:text-text")}>{language}</button>
          ))}
          <span className="ml-1 text-[10px] text-muted">{t("notebook.runShortcut")}</span>
          <div className="flex-1" />
          {runningCell ? (
            <button onClick={() => void interruptKernel(runningCell.language)} disabled={interrupting} className="flex h-8 items-center gap-1.5 rounded-lg bg-error px-3 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"><Square size={10} fill="currentColor" /> {t("common.stop")}</button>
          ) : (
            <button onClick={() => void submitDraft()} disabled={!draft.trim() || !interpreters?.[draftLanguage]} className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11px] font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"><Play size={11} /> {t("common.run")}</button>
          )}
        </div>
      </footer>
    </div>
  );
}

function mimeBundle(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
