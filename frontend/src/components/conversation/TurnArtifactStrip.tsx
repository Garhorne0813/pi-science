import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { File, FileText, FileSpreadsheet, FileImage, FileCode2, NotebookPen, ChevronDown, ChevronUp } from "lucide-react";
import { previewUrl, readArtifact } from "../../lib/files";
import { fileInspectorForPath } from "../../lib/artifacts";
import { useUiStore } from "../../lib/ui";
import type { TurnArtifactItem } from "../../types/thread";
import { codeSnippet, markdownSnippet, parseCsvSnippet, parseTsvSnippet, type CsvSnippet } from "../../lib/conversation/turn-artifact-snippet";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";

const MAX_VISIBLE = 6;
const SNIPPET_BYTES = 8192;
const SNIPPET_HEIGHT = "h-[88px]";

/** Apple-style glass card shell: translucent surface + blur + soft shadow.
 *  Theme colors are CSS variables (opacity modifiers are no-ops), so the
 *  translucency uses native white/black with dark: overrides. */
const GLASS =
  "rounded-card border border-white/20 bg-white/45 shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl transition-colors hover:bg-white/60 dark:border-white/10 dark:bg-black/25 dark:hover:bg-black/35";
const GLASS_FILENAME_BAR = "border-t border-white/15 dark:border-white/10";

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
function snippetKindFor(item: TurnArtifactItem): "table" | "markdown" | "code" | null {
  const ext = item.path.split(".").pop()?.toLowerCase() ?? "";
  if (item.kind === "table") return ext === "csv" || ext === "tsv" ? "table" : null;
  if (item.kind === "code" || item.kind === "notebook") return "code";
  if (item.kind === "text") return ext === "md" ? "markdown" : "code";
  return null;
}

/** Capped first-bytes read of a workspace file for the snippet card. */
function useSnippet(path: string, cwd?: string) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; text: string }>({ status: "loading" });
  useEffect(() => {
    if (!cwd) {
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
  }, [path, cwd]);
  return state;
}

function MiniTable({ data }: { data: CsvSnippet }) {
  const rowCount = Math.max(data.rows.length, 1);
  return (
    <table className="table-fixed w-full border-collapse text-[9px] leading-tight text-muted">
      <thead>
        <tr>
          {data.columns.slice(0, 5).map((column, index) => (
            <th key={index} className="max-w-[34px] truncate border-b border-border px-0.5 py-0.5 text-left font-medium text-text">{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.slice(0, Math.max(1, rowCount - 1)).map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className="max-w-[34px] truncate border-b border-faint px-0.5 py-0.5">{cell}</td>
            ))}
          </tr>
        ))}
        {data.truncated && (
          <tr><td colSpan={5} className="px-0.5 pt-0.5 text-[8px] text-muted/70">…</td></tr>
        )}
      </tbody>
    </table>
  );
}

/** Icon-only card (unchanged look): unknown/binary/document types. */
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
      className={`group flex w-full shrink-0 flex-col items-center gap-1 px-2 py-2 text-left ${GLASS}`}
      aria-label={`${filename} (${item.path})`}
    >
      <Icon size={16} className="text-accent" aria-hidden />
      <span className="block w-full truncate text-center text-[10px] text-muted group-hover:text-text" title={item.path}>{filename}</span>
      {item.size > 0 && (
        <span className="text-[9px] text-muted/70">{item.size >= 1024 * 1024 ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(item.size / 1024))} KB`}</span>
      )}
    </button>
  );
}

function SnippetCard({ item, cwd }: { item: TurnArtifactItem; cwd?: string }) {
  const openInspector = useUiStore((state) => state.openInspector);
  const { t } = useTranslation();
  const filename = item.path.split("/").pop() ?? item.path;
  const snippet = useSnippet(item.path, cwd);
  const open = () => {
    if (!cwd) return;
    openInspector(fileInspectorForPath(item.path, filename, "workspace", cwd));
  };

  const ready = snippet.status === "ready";

  let body: ReactNode;
  if (snippet.status === "loading") {
    body = <div className="h-full w-full animate-pulse rounded-input bg-surface-2" aria-hidden />;
  } else if (snippet.status === "error") {
    return <IconCard item={item} cwd={cwd} Icon={fileIcon(item.kind)} />;
  } else if (snippetKindFor(item) === "table") {
    const data = item.path.toLowerCase().endsWith(".tsv") ? parseTsvSnippet(snippet.text) : parseCsvSnippet(snippet.text);
    body = <MiniTable data={data} />;
  } else if (snippetKindFor(item) === "markdown") {
    const excerpt = markdownSnippet(snippet.text);
    body = (
      <div className="overflow-hidden text-[10px] leading-snug text-muted">
        <MarkdownViewer
          variant="chat"
          resourceContext={cwd ? { cwd, documentPath: item.path } : undefined}
          className="text-[10px] leading-snug [&_p]:my-1 [&_h1]:mb-1 [&_h1]:mt-0 [&_h2]:mb-1 [&_h2]:mt-0 [&_h3]:mb-1 [&_h3]:mt-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-1 [&_table]:my-1 [&_code]:text-[9px]"
        >
          {excerpt.markdown}
        </MarkdownViewer>
        {excerpt.truncated && <span className="text-[8px] text-muted/70">…</span>}
      </div>
    );
  } else {
    const excerpt = codeSnippet(snippet.text);
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
      className={`group flex w-full shrink-0 flex-col overflow-hidden text-left ${GLASS}`}
      aria-label={`${filename} (${item.path})`}
    >
      <div className={`relative ${SNIPPET_HEIGHT} overflow-hidden p-1.5`}>
        {body}
        {ready && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-white/45 to-transparent dark:from-black/25" />
        )}
      </div>
      <span className={`block truncate px-1.5 py-1 text-[10px] text-muted group-hover:text-text ${GLASS_FILENAME_BAR}`}>{filename}</span>
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
        className={`group relative block w-full shrink-0 overflow-hidden text-left ${GLASS}`}
        aria-label={`${filename} (${item.path})`}
      >
        <img
          src={previewUrl(item.path, "workspace", cwd ?? "")}
          alt={filename}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="h-[68px] w-full object-cover transition-opacity group-hover:opacity-80"
        />
        <span className={`block truncate px-1.5 py-1 text-[10px] text-muted group-hover:text-text ${GLASS_FILENAME_BAR}`}>{filename}</span>
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
    <section aria-label={t("conversation.generatedFiles")} className="mt-1">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
        {visible.map((item) => <ArtifactMiniCard key={item.path} item={item} cwd={cwd} />)}
        {extra > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-full shrink-0 flex-col items-center justify-center gap-1 rounded-card border border-dashed border-white/20 bg-white/35 px-2 py-2 text-[10px] text-muted shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl transition-colors hover:border-accent/60 hover:bg-white/55 hover:text-text dark:border-white/10 dark:bg-black/20 dark:hover:bg-black/30"
          >
            <span className="text-xs font-medium">+{extra}</span>
            <span className="flex items-center gap-0.5"><ChevronDown size={12} aria-hidden />{t("conversation.more")}</span>
          </button>
        )}
        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-full shrink-0 flex-col items-center justify-center gap-1 rounded-card border border-dashed border-white/20 bg-white/35 px-2 py-2 text-[10px] text-muted shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl transition-colors hover:border-accent/60 hover:bg-white/55 hover:text-text dark:border-white/10 dark:bg-black/20 dark:hover:bg-black/30"
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
