import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, Code2, Eye, ExternalLink, FileSearch, History, Loader2, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FilePreviewInspector as FilePreviewInspectorT, FileRoot } from "../../types/thread";
import { previewKindForName, type PreviewKind } from "@/lib/artifacts";
import {
  base64ToBytes,
  openArtifactExternally,
  previewUrl,
  probeLargeFile,
  readArtifact,
  writeArtifact,
  type LargeFilePointer,
} from "@/lib/files";
import { parseTableFile } from "@/lib/shared";
import { formatNumber } from "@/i18n/format";
import { CodeViewer } from "@/components/code-viewer/CodeViewer";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { ProvenancePanel } from "./ProvenancePanel";
import { TablePreview } from "./TablePreview";
import { TableChart } from "./TableChart";
import { canChart } from "@/lib/shared";
const DocxView = lazy(() => import("./OfficePreview").then((module) => ({ default: module.DocxView })));
const PptxView = lazy(() => import("./OfficePreview").then((module) => ({ default: module.PptxView })));
const XlsxView = lazy(() => import("./OfficePreview").then((module) => ({ default: module.XlsxView })));
const MoleculeView = lazy(() => import("./MoleculeView").then((module) => ({ default: module.MoleculeView })));
const MeshView = lazy(() => import("./MeshView").then((module) => ({ default: module.MeshView })));
import { GenomeView } from "./GenomeView";
import { FitsView } from "./FitsView";
import { DosView } from "./DosView";
import { BandView } from "./BandView";
import { QCodeView } from "./QCodeView";
import { AnomalyMapView } from "./AnomalyMapView";
import { PhaseView } from "./PhaseView";
import { useScrollMemory } from "@/lib/ui";
import { cn } from "@/lib/ui";
import { previewPolicy } from "@/lib/artifacts/preview-policy";

/**
 * Right-pane preview for any workspace file. Strategy (no format conversion):
 * pdf / image / html — served from the local file server (http://127.0.0.1)
 * and rendered by the webview's NATIVE viewers via <iframe>/<img>;
 * csv/tsv — parsed to a table; docx/xlsx/pptx — local JS renderers fed raw
 * bytes; everything else — code/text.
 */
export function FilePreviewInspector({
  data,
  onClose,
  controls,
  cwd,
  showTitle = true,
  showClose = true,
  showOpenExternally = true,
  contentZoom = 1,
}: {
  data: FilePreviewInspectorT;
  onClose: () => void;
  /** Pane-level header buttons (e.g. maximize), rendered before Close. */
  controls?: React.ReactNode;
  cwd: string;
  /** The outer multi-file tab strip already shows the filename. */
  showTitle?: boolean;
  /** Multi-file tabs provide their own close control. */
  showClose?: boolean;
  /** Multi-file tabs keep the content header focused on preview actions. */
  showOpenExternally?: boolean;
  /** Scale applied to preview content while keeping the toolbar unchanged. */
  contentZoom?: number;
}) {
  const { t } = useTranslation();
  const kind = previewKindForName(data.filename);
  const policy = previewPolicy(kind);
  const needsUrl = policy.load.includes("url");
  const needsText = policy.load.includes("text");
  const needsBytes = policy.load.includes("bytes");

  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(data.content ?? null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">(policy.defaultTab);
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    // Reset per-file state up front: the same inspector instance is reused when
    // the user opens a different file, and the async loads below only fill in
    // what the NEW file needs — without this, the previous file's text/url/bytes
    // would linger and bleed into the new preview.
    setText(data.content ?? null);
    setUrl(null);
    setBytes(null);
    setEditing(false);
    editPathRef.current = null;
    setDraft(null);
    setSaveError(null);
    setSaveNotice(null);
    (async () => {
      try {
        if (needsUrl) {
          const u = previewUrl(data.path, data.root, cwd);
          if (cancelled) return;
          setUrl(u);
          // Browser dev has no local server; html can still preview inline content.
          if (!u && kind !== "html") {
            setError(t("filePreview.fileUnavailable"));
          }
        }
        if (needsText && data.content === undefined) {
          const f = await readArtifact(data.path, data.root, cwd);
          if (cancelled) return;
          if (f && f.encoding === "utf8") setText(f.data);
          else if (f) setError(t("filePreview.binaryTextUnsupported"));
          else setError(t("filePreview.fileUnavailable"));
        }
        if (needsBytes) {
          const f = await readArtifact(data.path, data.root, cwd);
          if (cancelled) return;
          if (f && f.encoding === "base64") setBytes(base64ToBytes(f.data));
          else setError(t("filePreview.fileUnavailable"));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` intentionally excluded: this effect loads a file, not a UI label; a
    // locale switch mid-load shouldn't re-trigger a network/disk read to refresh
    // an error string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, data.path, data.content, data.root, kind, needsUrl, needsText, needsBytes]);

  const canToggle = policy.supportsCode;

  // Editable text files: plain code/text, markdown, csv and html (html stays
  // read-only in its browser preview tab — editing happens on the code tab).
  const editable = (kind === "text" || kind === "markdown" || kind === "table" || kind === "html") && !loading && !error && text !== null;
  const canSave = editing && draft !== null && !saving;

  // The inspector instance is reused across files (the same component stays
  // mounted while data.path changes), so the edit session must be scoped to
  // the path that was open when editing started. A save that resolves after
  // the user opened a different file must not write or apply state to the new
  // file.
  const editPathRef = useRef<string | null>(null);

  const startEdit = () => {
    if (text === null) return;
    editPathRef.current = data.path;
    setDraft(text);
    setSaveError(null);
    setSaveNotice(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    editPathRef.current = null;
    setEditing(false);
    setDraft(null);
    setSaveError(null);
    setSaveNotice(null);
  };

  const saveEdit = async () => {
    if (draft === null || saving) return;
    const targetPath = editPathRef.current;
    if (!targetPath) return;
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    try {
      await writeArtifact(targetPath, data.root, cwd, draft);
      // The save may have resolved after the user switched to another file in
      // the same inspector instance — only apply the result when the path is
      // still the one being edited.
      if (editPathRef.current !== targetPath) return;
      setText(draft);
      setEditing(false);
      editPathRef.current = null;
      setDraft(null);
      setSaveNotice(t("filePreview.saved"));
      window.setTimeout(() => setSaveNotice(null), 2000);
    } catch (cause) {
      if (editPathRef.current !== targetPath) return;
      setSaveError(cause instanceof Error ? t("filePreview.saveFailed", { message: cause.message }) : String(cause));
    } finally {
      setSaving(false);
    }
  };

  // Where the user was in this file, restored when they come back to it —
  // history browsing keeps its own offset so the two don't clobber each other.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(
    scrollRef,
    showHistory ? `history:${data.path}` : `file:${data.path}`,
    showHistory || !loading,
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        {showTitle && <span className="truncate text-sm font-medium text-text">{data.filename}</span>}
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
          {data.artifact || t("filePreview.file")}
        </span>
        {canToggle && (
          <div className="ml-2 flex items-center gap-1 rounded-input bg-surface-2 p-0.5">
            {/* eslint-disable-next-line i18next/no-literal-string -- "preview" is an internal tab id, not display text (the visible label is t("filePreview.tabs.preview")) */}
            <ToggleBtn active={tab === "preview"} onClick={() => setTab("preview")}>
              <Eye size={13} /> {t("filePreview.tabs.preview")}
            </ToggleBtn>
            {/* eslint-disable-next-line i18next/no-literal-string -- "code" is an internal tab id, not display text (the visible label is t("filePreview.tabs.code")) */}
            <ToggleBtn active={tab === "code"} onClick={() => setTab("code")}>
              <Code2 size={13} /> {t("filePreview.tabs.code")}
            </ToggleBtn>
          </div>
        )}
        <div className="flex-1" />
        {saveNotice && <span className="mr-1 text-xs text-ok">{saveNotice}</span>}
        {editing ? (
          <>
            <button
              className="flex items-center gap-1 rounded-input bg-accent px-2.5 py-1 text-xs text-accent-fg hover:opacity-90 disabled:opacity-50"
              aria-label={t("filePreview.save")}
              onClick={() => void saveEdit()}
              disabled={!canSave}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              {t("filePreview.save")}
            </button>
            <button
              className="flex items-center gap-1 rounded-input border border-border px-2.5 py-1 text-xs text-muted hover:text-text"
              aria-label={t("filePreview.cancel")}
              onClick={cancelEdit}
              disabled={saving}
            >
              {t("filePreview.cancel")}
            </button>
          </>
        ) : (
          editable && !showHistory && (
            <button
              className="text-text hover:opacity-60"
              aria-label={t("filePreview.edit")}
              title={t("filePreview.edit")}
              onClick={startEdit}
            >
              <Pencil size={14} strokeWidth={1.5} />
            </button>
          )
        )}
        <button
          className={cn(showHistory ? "text-accent" : "text-text hover:opacity-60")}
          aria-label={t("filePreview.versionHistory")}
          title={t("filePreview.versionHistory")}
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          <History size={14} strokeWidth={1.5} />
        </button>
        {showOpenExternally && kind !== "html" && (
          <button
            className="text-text hover:opacity-60"
            aria-label={t("common.open")}
            title={t("filePreview.openExternally")}
            onClick={() => void openArtifactExternally(data.path, data.root, cwd)}
          >
            <ExternalLink size={14} strokeWidth={1.5} />
          </button>
        )}
        {controls}
        {showClose && (
          <button className="text-text hover:opacity-60" aria-label={t("common.close")} onClick={onClose}>
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto bg-surface-2">
        <div className="h-full min-h-full" style={{ zoom: contentZoom }}>
        {showHistory && <ProvenancePanel path={data.path} language={data.language} cwd={cwd} />}
        {!showHistory && editing && draft !== null && (
          <div className="flex h-full flex-col">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-surface p-4 font-mono text-[12.5px] leading-[1.55] text-text outline-none"
              aria-label={`Edit ${data.filename}`}
            />
            {saveError && <div className="border-t border-border px-4 py-2 text-xs text-error">{saveError}</div>}
          </div>
        )}
        {!showHistory && !editing && loading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> {t("filePreview.loadingFile", { filename: data.filename })}
          </div>
        )}
        {!showHistory && !editing && !loading && error && (
          <PreviewError
            error={error}
            filename={data.filename}
            path={data.path}
            root={data.root}
            cwd={cwd}
            onOpenExternally={kind === "html" ? undefined : () => void openArtifactExternally(data.path, data.root, cwd)}
          />
        )}
        {!showHistory && !editing && !loading && !error && (
          <Suspense fallback={<Note text={t("filePreview.loadingScientificViewer")} />}>
            <Body
              kind={kind}
              url={url}
              text={text}
              bytes={bytes}
              showCode={tab === "code"}
              filename={data.filename}
              path={data.path}
              language={data.language}
            />
          </Suspense>
        )}
        </div>
      </div>
    </div>
  );
}

function Body({
  kind,
  url,
  text,
  bytes,
  showCode,
  filename,
  path,
  language,
}: {
  kind: PreviewKind;
  url: string | null;
  text: string | null;
  bytes: ArrayBuffer | null;
  showCode: boolean;
  filename: string;
  path: string;
  language?: string;
}) {
  const { t } = useTranslation();
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    // Office views scroll internally (the outer pane never does), so they
    // carry their own scroll memory, keyed apart from the outer container's.
    if (!bytes) return <Note text={t("filePreview.loading")} />;
    if (kind === "docx") return <DocxView bytes={bytes} scrollKey={`office:${path}`} />;
    if (kind === "xlsx") return <XlsxView bytes={bytes} scrollKey={`office:${path}`} />;
    return <PptxView bytes={bytes} scrollKey={`office:${path}`} />;
  }
  if (kind === "mesh") {
    return bytes !== null ? (
      <Suspense fallback={<div className="p-4 text-sm text-muted">{t("filePreview.loading3dViewer")}</div>}>
        <MeshView filename={filename} bytes={bytes} />
      </Suspense>
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "fits") {
    return bytes !== null ? (
      <FitsView filename={filename} bytes={bytes} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "dos") {
    return bytes !== null ? (
      <DosView filename={filename} bytes={bytes} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "bands") {
    return bytes !== null ? (
      <BandView filename={filename} bytes={bytes} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "qcode") {
    return text !== null ? (
      <QCodeView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "anomaly") {
    return text !== null ? (
      <AnomalyMapView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "phase") {
    return text !== null ? (
      <PhaseView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "molecule") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language={language} />
        </div>
      ) : (
        <Note text={t("filePreview.openInDesktop")} />
      );
    }
    return text !== null ? (
      <MoleculeView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "genome") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language={language} />
        </div>
      ) : (
        <Note text={t("filePreview.openInDesktop")} />
      );
    }
    return text !== null ? (
      <GenomeView filename={filename} text={text} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "markdown") {
    if (showCode) {
      return text !== null ? (
        <div className="p-3">
          <CodeViewer code={text} language="markdown" />
        </div>
      ) : (
        <Note text={t("filePreview.openInDesktop")} />
      );
    }
    // A document reads as a page: white paper, black text, whatever the app
    // theme — the same document-neutral canvas the Office previews use.
    return text !== null ? (
      <div className="min-h-full px-6 py-8">
        <div className="mx-auto max-w-[760px] rounded-sm bg-white px-12 py-11 shadow-[0_1px_4px_rgba(0,0,0,.25)] max-sm:px-6 max-sm:py-7">
          <MarkdownViewer variant="document">{text}</MarkdownViewer>
        </div>
      </div>
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "html" && showCode) {
    return text !== null ? (
      <div className="p-3">
        <CodeViewer code={text} language="html" />
      </div>
    ) : (
      <Note text={t("filePreview.openInDesktop")} />
    );
  }
  if (kind === "html") {
    // Served URL preferred (relative assets resolve); srcdoc as browser fallback.
    // `allow-same-origin` is needed so the iframe shares the parent origin,
    // which lets the browser send a full Referer header (with query string)
    // on subresource requests — the backend extracts cwd from it to locate
    // the correct workspace for relative CSS/JS/image references.
    if (url) {
      return (
        <iframe
          title={t("filePreview.htmlPreview")}
          src={url}
          sandbox="allow-scripts allow-same-origin"
          className="h-full min-h-[480px] w-full bg-white"
        />
      );
    }
    if (text !== null) {
      return (
        <iframe
          title={t("filePreview.htmlPreview")}
          srcDoc={text}
          sandbox="allow-scripts allow-same-origin"
          className="h-full min-h-[480px] w-full bg-white"
        />
      );
    }
    return <Note text={t("filePreview.loading")} />;
  }
  if (kind === "pdf") {
    // The webview's native PDF viewer (WKWebView / WebView2) renders the served URL.
    return url ? (
      <iframe title={t("filePreview.pdfPreview")} src={url} className="h-full min-h-[480px] w-full" />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "image") {
    return url ? (
      <div className="flex items-center justify-center min-h-full p-4">
        <img src={url} alt={filename} className="max-w-full max-h-full rounded-sm bg-white shadow-card object-contain" />
      </div>
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "video") {
    // The local file server answers Range requests, so the native <video>
    // element streams and seeks straight from http://127.0.0.1.
    return url ? (
      <div className="flex justify-center p-4">
        <video
          src={url}
          controls
          className="max-h-[80vh] max-w-full rounded-sm bg-black shadow-card"
        />
      </div>
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  if (kind === "table") {
    return text !== null ? (
      <TableView table={parseTableFile(filename, text)} />
    ) : (
      <Note text={t("filePreview.loading")} />
    );
  }
  return text !== null ? (
    <div className="p-3">
      <CodeViewer code={text} language={language} />
    </div>
  ) : (
    <Note text={t("filePreview.loading")} />
  );
}

function Note({ text }: { text: string }) {
  return <div className="p-4 text-sm text-muted">{text}</div>;
}

/** Tabular file preview with a Table ↔ Chart toggle. The Chart tab appears only
 *  when the data has a numeric column to plot (P1-5 native chart surface). */
function TableView({ table }: { table: import("@/lib/shared").ParsedTable }) {
  const { t } = useTranslation();
  const [view, setView] = useState<"table" | "chart">("table");
  const chartable = canChart(table);
  return (
    <div className="flex h-full flex-col">
      {chartable && (
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          {/* eslint-disable-next-line i18next/no-literal-string -- "table" is an internal view id, not display text (the visible label is t("filePreview.tableView.table")) */}
          <ToggleBtn active={view === "table"} onClick={() => setView("table")}>
            {t("filePreview.tableView.table")}
          </ToggleBtn>
          {/* eslint-disable-next-line i18next/no-literal-string -- "chart" is an internal view id, not display text (the visible label is t("filePreview.tableView.chart")) */}
          <ToggleBtn active={view === "chart"} onClick={() => setView("chart")}>
            {t("filePreview.tableView.chart")}
          </ToggleBtn>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {view === "chart" && chartable ? (
          <TableChart table={table} />
        ) : (
          <TablePreview table={table} />
        )}
      </div>
    </div>
  );
}

/** Preview errors. A "too large" file gets a helpful card — the preview is
 *  capped so a huge file can't lock the app. The user can open it in the OS
 *  app, or **inspect it without loading**: the large-file probe returns a
 *  compact memory pointer (schema / shape / sample / key numbers) by streaming
 *  and sampling, so even a 90 GB file is introspected, never loaded. */
export function PreviewError({
  error,
  filename,
  path,
  root,
  cwd,
  onOpenExternally,
}: {
  error: string;
  filename: string;
  path?: string;
  root?: FileRoot;
  cwd: string;
  onOpenExternally?: () => void;
}) {
  const { t } = useTranslation();
  const tooLarge = /too large/i.test(error);
  const [pointer, setPointer] = useState<LargeFilePointer | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const inspect = async () => {
    if (!path) return;
    setProbing(true);
    setProbeError(null);
    try {
      const result = await probeLargeFile(path, root, cwd);
      if (result) setPointer(result);
      else setProbeError(t("filePreview.inspectFailed"));
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  if (!tooLarge) return <div className="p-4 text-sm text-muted">{error}</div>;
  return (
    <div className="p-4">
      <div className="rounded-card border border-border bg-surface p-4 text-sm text-muted">
        <div className="mb-1 font-medium text-text">{t("filePreview.tooLargeTitle", { filename })}</div>
        <p className="mb-3">{t("filePreview.tooLargeBody")}</p>
        <div className="flex flex-wrap gap-2">
          {path && (
            <button
              className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text hover:bg-surface disabled:opacity-60"
              onClick={() => void inspect()}
              disabled={probing}
            >
              {probing ? <Loader2 size={13} className="animate-spin" /> : <FileSearch size={13} />}
              {t("filePreview.inspectWithoutLoading")}
            </button>
          )}
          {onOpenExternally && (
            <button
              className="inline-flex items-center gap-1.5 rounded-input border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text hover:bg-surface"
              onClick={onOpenExternally}
            >
              <ExternalLink size={13} /> {t("common.open")}
            </button>
          )}
        </div>
        {probeError && <div className="mt-3 text-[13px] text-error">{probeError}</div>}
        {pointer && <LargeFilePointerPanel p={pointer} />}
      </div>
    </div>
  );
}

/** Render the probe's memory pointer as a compact, readable fact sheet. */
function LargeFilePointerPanel({ p }: { p: LargeFilePointer }) {
  const { t } = useTranslation();
  if (p.error) return <div className="mt-3 text-[13px] text-error">{p.error}</div>;
  const fmt = (n: number) => formatNumber(n);
  const rows: [string, string][] = [];
  if (p.format) rows.push([t("filePreview.pointer.format"), p.format]);
  if (p.size) rows.push([t("filePreview.pointer.size"), p.size + (p.gzipped ? ` ${t("filePreview.pointer.gzipped")}` : "")]);
  if (p.approx_rows !== undefined) rows.push([t("filePreview.pointer.approxRows"), fmt(p.approx_rows)]);
  const exactRows = p.num_rows ?? p.n_rows ?? p.rows;
  if (exactRows !== undefined) rows.push([t("filePreview.pointer.rows"), fmt(exactRows)]);
  if (p.approx_reads !== undefined) rows.push([t("filePreview.pointer.approxReads"), fmt(p.approx_reads)]);
  if (p.approx_sequences !== undefined) rows.push([t("filePreview.pointer.approxSequences"), fmt(p.approx_sequences)]);
  if (p.approx_variants !== undefined) rows.push([t("filePreview.pointer.approxVariants"), fmt(p.approx_variants)]);
  if (p.n_columns !== undefined) rows.push([t("filePreview.pointer.columns"), fmt(p.n_columns)]);
  if (p.read_length)
    rows.push([
      t("filePreview.pointer.readLength"),
      t("filePreview.pointer.readLengthValue", {
        min: p.read_length.min,
        max: p.read_length.max,
        mean: p.read_length.mean,
      }),
    ]);
  if (p.samples?.length) rows.push([t("filePreview.pointer.samples"), p.samples.join(", ")]);

  return (
    <div className="mt-3 rounded-input border border-border bg-surface-2 p-3">
      {p.hint && <div className="mb-2 text-[13px] text-text">{p.hint}</div>}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all font-mono text-text">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.columns && p.columns.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[12px] text-muted">{t("filePreview.pointer.schema")}</div>
          <div className="flex flex-wrap gap-1">
            {p.columns.slice(0, 40).map((c) => (
              <span key={c.name} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-text">
                {c.name} <span className="text-muted">{c.dtype}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {p.datasets && p.datasets.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[12px] text-muted">{t("filePreview.pointer.datasets")}</div>
          <div className="flex flex-col gap-0.5 font-mono text-[11.5px] text-text">
            {p.datasets.slice(0, 20).map((d) => (
              <span key={d.path}>{d.path} <span className="text-muted">[{d.shape.join("×")}] {d.dtype}</span></span>
            ))}
          </div>
        </div>
      )}
      {p.sample_ids && p.sample_ids.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[12px] text-muted">{t("filePreview.pointer.sampleIds")}</div>
          <div className="font-mono text-[11.5px] text-text">{p.sample_ids.slice(0, 5).join(", ")}</div>
        </div>
      )}
      {p.note && <div className="mt-2 text-[11.5px] italic text-muted">{p.note}</div>}
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-1 text-xs",
        active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
