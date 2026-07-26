import { Search, X } from "lucide-react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { PdfInspector as PdfInspectorT } from "../../types/thread";
import { apiRequest } from "@/lib/api";
import { previewUrl } from "@/lib/files";
import { PaneTitlebarInset } from "./RightPane";

export function PdfInspector({
  data,
  onClose,
  controls,
  cwd,
}: {
  data: PdfInspectorT;
  onClose: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const title = data.filename ?? data.path?.split("/").pop() ?? "PDF";
  const baseUrl = data.url ?? (data.path ? previewUrl(data.path, undefined, cwd) : null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ page: number; snippet: string }>>([]);
  const [page, setPage] = useState<number | undefined>(data.page);
  const url = baseUrl ? `${baseUrl}${page ? `#page=${page}` : ""}` : null;
  // A user-triggered POST that indexes on demand — a mutation, not a cached read.
  const searchMutation = useMutation({
    mutationFn: (term: string) => apiRequest<{ results?: Array<{ page: number; snippet: string }> }>(
      `/api/pdfs/search?${new URLSearchParams({ cwd: cwd || "." })}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: data.path, query: term }) },
    ),
    onSuccess: (payload) => setResults(payload.results || []),
    onError: () => setResults([]),
  });
  const searching = searchMutation.isPending;
  const search = () => {
    if (!data.path || !query.trim()) return;
    searchMutation.mutate(query.trim());
  };
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <PaneTitlebarInset />
        <span className="truncate text-sm font-medium text-text">{title}</span>
        <div className="flex-1" />
        {controls}
        <button className="text-text hover:opacity-60" aria-label={t("shell.closeInspector")} onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      {data.path && <div className="flex gap-2 border-b border-border bg-surface px-4 py-2"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") search(); }} placeholder="Search pages" className="min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-2 py-1 text-xs text-text outline-none" /><button type="button" onClick={() => search()} disabled={searching || !query.trim()} className="rounded-input bg-accent px-2 py-1 text-xs text-accent-fg disabled:opacity-40"><Search size={13} /></button></div>}
      {results.length > 0 && <div className="max-h-36 overflow-y-auto border-b border-border bg-surface-2 px-4 py-2">{results.map((result) => <button type="button" key={`${result.page}-${result.snippet}`} onClick={() => setPage(result.page)} className="block w-full truncate py-1 text-left text-[11px] text-muted hover:text-text"><span className="mr-2 font-mono text-accent">p.{result.page}</span>{result.snippet}</button>)}</div>}

      {url ? (
        <iframe title={title} src={url} className="min-h-0 flex-1 bg-white" />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
          PDF path is unavailable.
        </div>
      )}
    </div>
  );
}
