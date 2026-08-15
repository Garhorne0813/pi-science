import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { File, FileText, FileSpreadsheet, FileImage, FileCode2, NotebookPen, ChevronDown, ChevronUp, ArrowUpRight } from "lucide-react";
import { previewUrl, readArtifact } from "../../lib/files";
import { fileInspectorForPath } from "../../lib/artifacts";
import { useUiStore } from "../../lib/ui";
import type { TurnArtifactItem } from "../../types/thread";
import { codeSnippet, markdownSnippet, parseCsvSnippet, parseTsvSnippet, type CsvSnippet } from "../../lib/conversation/turn-artifact-snippet";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { MoleculeThumb } from "./MoleculeThumb";

const MAX_VISIBLE = 6;
const SNIPPET_BYTES = 8192;
const PREVIEW_HEIGHT = "h-[55px]";

/** Claude Science card shell: solid surface, 12px radius, inset ring only
 *  (no blur, no outer shadow, no hover lift). Ring uses native black/white
 *  opacities because theme tokens are CSS variables (opacity modifiers are
 *  no-ops); the focus ring is the Claude Science blue with the inset ring kept. */
const CARD =
  "group relative flex w-[128px] shrink-0 flex-col overflow-hidden rounded-[12px] bg-surface text-left ring-1 ring-inset ring-black/10 focus-visible:ring-2 focus-visible:ring-[#2a78d6] dark:ring-white/10";
const FILENAME_BAR = "flex h-[25px] min-w-0 items-center gap-0.5 px-2";

function fileIcon(kind: string) {
  switch (kind) {
    case "image": return FileImage;
    case "table": return FileSpreadsheet;
    case "notebook": return NotebookPen;
    case "code": return FileCode2;
    case "text": return FileText;
    default: return File;
  }
}

/** Which snippet renderer applies to this artifact, or null for icon-only. */
function snippetKindFor(item: TurnArtifactItem): "table" | "markdown" | "code" | "structure" | null {
  const ext = item.path.split(".").pop()?.toLowerCase() ?? "";
  if (item.kind === "table") return ext === "csv" || ext === "tsv" ? "table" : null;
  if (item.kind === "code" || item.kind === "notebook") return "code";
  if (item.kind === "text") return ext === "md" ? "markdown" : "code";
  if (item.kind === "structure") return "structure";
  return null;
}

/** Filename split at the last dot so the extension survives truncation. */
function FilenameLabel({ filename }: { filename: string }) {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  return (
    <>
      <span className="min-w-0 truncate text-[10.5px] font-medium text-text">{base}</span>
      {ext && <span className="shrink-0 text-[10.5px] font-medium text-muted">{ext}</span>}
    </>
  );
}

/** Hover/focus affordance: a small open button floats over the top-right
 *  corner (mirrors Claude Science; the whole card is clickable, so this is
 *  decorative). */
function OpenAffordance() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-[6px] bg-white/90 text-black/70 opacity-0 shadow-[0_2px_8px_rgba(0,0,0,0.18)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 dark:bg-black/90 dark:text-white/80 dark:shadow-[0_2px_8px_rgba(0,0,0,0.35)]"
    >
      <ArrowUpRight size={14} />
    </span>
  );
}

/** Capped first-bytes read of a workspace file for the snippet card. */
function useSnippet(path: string, cwd?: string, enabled = true) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; text: string }>({ status: "loading" });
  useEffect(() => {
    if (!enabled || !cwd) {
      setState({ status: "error" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void readArtifact(path, "workspace", cwd, SNIPPET_BYTES)
      .then((file) => {
        if (cancelled) return;
        if (!file || file.encoding !== "utf8" || !file.data) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", text: file.data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [path, cwd, enabled]);
  return state;
}

/** First non-empty value's rough type: numeric → "123", otherwise "abc". */
function columnTypeHint(row: string[], index: number): "abc" | "123" {
  const value = row[index];
  if (value !== undefined && value.trim() !== "" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim())) return "123";
  return "abc";
}

/** Claude Science style CSV summary badge: rows · columns, field type hints
 *  and the first few column names, then "+N more" for the rest. */
function TableSummary({ data }: { data: CsvSnippet }) {
  const { t } = useTranslation();
  const rowsLabel = data.truncated ? `${data.rowCount}+` : String(data.rowCount);
  const firstDataRow = data.rows[0] ?? [];
  const visibleColumns = data.columns.slice(0, 3);
  const remaining = Math.max(0, data.columnCount - visibleColumns.length);
  return (
    <div className="flex h-full flex-col justify-center gap-1 overflow-hidden">
      <div className="truncate text-[9px] leading-tight text-muted">
        {t("conversation.rowsCols", { rows: rowsLabel, columns: data.columnCount })}
      </div>
      {visibleColumns.length > 0 && (
        <div className="flex flex-wrap gap-0.5 overflow-hidden">
          {visibleColumns.map((column, index) => (
            <span key={index} className="flex max-w-[52px] items-center gap-0.5 rounded-[4px] bg-surface px-1 py-0.5 text-[9px] leading-tight text-muted">
              <span className="shrink-0 font-mono text-[8px] text-accent">{columnTypeHint(firstDataRow, index)}</span>
              <span className="truncate">{column}</span>
            </span>
          ))}
          {remaining > 0 && (
            <span className="text-[9px] leading-tight text-muted">{t("conversation.moreColumns", { count: remaining })}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Icon-only card: centered icon over a darker preview area, filename bar
 *  below (same 128×80 shell as content cards). */
function IconCard({ item, cwd, Icon }: { item: TurnArtifactItem; cwd?: string; Icon: ReturnType<typeof fileIcon> }) {
  const openInspector = useUiStore((state) => state.openInspector);
  const filename = item.path.split("/").pop() ?? item.path;
  const open = () => {
    if (!cwd) return;
    openInspector(fileInspectorForPath(item.path, filename, "workspace", cwd));
  };
  return (
    <button
      type="button"
      onClick={open}
      className={CARD}
      aria-label={`${filename} (${item.path})`}
    >
      <OpenAffordance />
      <div className={`flex ${PREVIEW_HEIGHT} items-center justify-center bg-surface-2`}>
        <Icon size={18} className="text-accent" aria-hidden />
      </div>
      <span className={FILENAME_BAR}>
        <FilenameLabel filename={filename} />
      </span>
    </button>
  );
}

function SnippetCard({ item, cwd }: { item: TurnArtifactItem; cwd?: string }) {
  const openInspector = useUiStore((state) => state.openInspector);
  const { t } = useTranslation();
  const filename = item.path.split("/").pop() ?? item.path;
  const [structureFailed, setStructureFailed] = useState(false);
  const snippet = useSnippet(item.path, cwd, snippetKindFor(item) !== "structure");
  const open = () => {
    if (!cwd) return;
    openInspector(fileInspectorForPath(item.path, filename, "workspace", cwd));
  };

  const ready = snippet.status === "ready";

  if (snippetKindFor(item) === "structure") {
    if (structureFailed || !cwd) return <IconCard item={item} cwd={cwd} Icon={fileIcon(item.kind)} />;
    return (
      <button
        type="button"
        onClick={open}
        className={CARD}
        aria-label={`${filename} (${item.path})`}
      >
        <OpenAffordance />
        <div className={`relative ${PREVIEW_HEIGHT} overflow-hidden bg-surface-2`}>
          <MoleculeThumb path={item.path} cwd={cwd} filename={filename} onError={() => setStructureFailed(true)} />
        </div>
        <span className={FILENAME_BAR}>
          <FilenameLabel filename={filename} />
        </span>
      </button>
    );
  }

  let body: ReactNode;
  if (snippet.status === "loading") {
    body = <div className="h-full w-full animate-pulse rounded-[6px] bg-surface-2" aria-hidden />;
  } else if (snippet.status === "error") {
    return <IconCard item={item} cwd={cwd} Icon={fileIcon(item.kind)} />;
  } else if (snippetKindFor(item) === "table") {
    const data = item.path.toLowerCase().endsWith(".tsv") ? parseTsvSnippet(snippet.text) : parseCsvSnippet(snippet.text);
    body = <TableSummary data={data} />;
  } else if (snippetKindFor(item) === "markdown") {
    const excerpt = markdownSnippet(snippet.text);
    body = (
      <div className="overflow-hidden text-[10px] leading-snug text-muted">
        <MarkdownViewer
          variant="chat"
          codeChrome={false}
          resourceContext={cwd ? { cwd, documentPath: item.path } : undefined}
          className="text-[10px] leading-snug [&_p]:my-1 [&_h1]:mb-1 [&_h1]:mt-0 [&_h2]:mb-1 [&_h2]:mt-0 [&_h3]:mb-1 [&_h3]:mt-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-1 [&_table]:my-1 [&_code]:text-[9px]"
        >
          {excerpt.markdown}
        </MarkdownViewer>
        {excerpt.truncated && <span className="text-[8px] text-muted">…</span>}
      </div>
    );
  } else {
    const excerpt = codeSnippet(snippet.text, 4);
    body = (
      <pre className="h-full overflow-hidden font-mono text-[9px] leading-[1.45] text-muted" aria-label={t("conversation.codeSnippet")}>
        {excerpt.code}
        {excerpt.truncated && "\n…"}
      </pre>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className={CARD}
      aria-label={`${filename} (${item.path})`}
    >
      <OpenAffordance />
      <div className={`relative ${PREVIEW_HEIGHT} overflow-hidden bg-surface-2 p-1.5`}>
        {body}
        {ready && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-surface-2 to-transparent" />
        )}
        {ready && snippetKindFor(item) === "code" && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-3 bg-gradient-to-l from-surface-2 to-transparent" />
        )}
      </div>
      <span className={FILENAME_BAR}>
        <FilenameLabel filename={filename} />
      </span>
    </button>
  );
}

function ArtifactMiniCard({ item, cwd }: { item: TurnArtifactItem; cwd?: string }) {
  const openInspector = useUiStore((state) => state.openInspector);
  const filename = item.path.split("/").pop() ?? item.path;
  const Icon = fileIcon(item.kind);
  const [imageFailed, setImageFailed] = useState(false);
  const isImage = item.kind === "image" && !imageFailed;

  const open = () => {
    if (!cwd) return;
    openInspector(fileInspectorForPath(item.path, filename, "workspace", cwd));
  };

  if (isImage) {
    return (
      <button
        type="button"
        onClick={open}
        className={CARD}
        aria-label={`${filename} (${item.path})`}
      >
        <OpenAffordance />
        <div className={`relative ${PREVIEW_HEIGHT} overflow-hidden bg-surface-2 p-1.5`}>
          <img
            src={previewUrl(item.path, "workspace", cwd ?? "")}
            alt={filename}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-contain"
          />
        </div>
        <span className={FILENAME_BAR}>
          <FilenameLabel filename={filename} />
        </span>
      </button>
    );
  }

  if (snippetKindFor(item)) {
    return <SnippetCard item={item} cwd={cwd} />;
  }

  return <IconCard item={item} cwd={cwd} Icon={Icon} />;
}

/** Compact strip of files a turn produced, shown after the final assistant
 *  message (Claude Science style). Clicking a card opens the file in the
 *  right-side inspector. */
export function TurnArtifactStrip({ artifacts, cwd }: { artifacts: TurnArtifactItem[]; cwd?: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const visible = useMemo(() => (expanded ? artifacts : artifacts.slice(0, MAX_VISIBLE)), [artifacts, expanded]);
  const extra = artifacts.length - visible.length;

  if (!artifacts.length) return null;

  return (
    <section aria-label={t("conversation.generatedFiles")} className="mt-3.5">
      <div className="mb-1.5 text-[10.5px] font-medium tracking-[0.02em] text-muted">
        {t("conversation.generatedFilesLabel", { count: artifacts.length })}
      </div>
      <div className="flex flex-wrap gap-2">
        {visible.map((item) => <ArtifactMiniCard key={item.path} item={item} cwd={cwd} />)}
        {extra > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-[128px] shrink-0 flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-border bg-surface px-2 py-2 text-[10px] text-muted transition-colors hover:border-accent hover:text-text"
          >
            <span className="text-xs font-medium">+{extra}</span>
            <span className="flex items-center gap-0.5"><ChevronDown size={12} aria-hidden />{t("conversation.more")}</span>
          </button>
        )}
        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-[128px] shrink-0 flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-border bg-surface px-2 py-2 text-[10px] text-muted transition-colors hover:border-accent hover:text-text"
          >
            <span className="flex items-center gap-0.5"><ChevronUp size={12} aria-hidden />{t("conversation.collapse")}</span>
          </button>
        )}
      </div>
    </section>
  );
}

/** Render helper for ConversationBlocks: nothing to prepare here, keeps the
 *  strip dumb and stateless at the block level. */
export function renderArtifactSummary(block: { artifacts: TurnArtifactItem[]; kind: string }, cwd?: string) {
  return <TurnArtifactStrip artifacts={block.artifacts} cwd={cwd} />;
}
