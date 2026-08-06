import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { File, FileText, FileSpreadsheet, FileImage, FileCode2, NotebookPen, ChevronDown, ChevronUp } from "lucide-react";
import { previewUrl } from "../../lib/files";
import { fileInspectorForPath } from "../../lib/artifacts";
import { useUiStore } from "../../lib/ui";
import type { TurnArtifactItem } from "../../types/thread";

const MAX_VISIBLE = 6;

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
        className="group relative block w-[104px] shrink-0 overflow-hidden rounded-card border border-border bg-surface text-left transition-colors hover:border-accent/60"
        aria-label={`${filename} (${item.path})`}
      >
        <img
          src={previewUrl(item.path, "workspace", cwd ?? "")}
          alt={filename}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="h-[68px] w-full object-cover transition-opacity group-hover:opacity-80"
        />
        <span className="block truncate border-t border-faint px-1.5 py-1 text-[10px] text-muted group-hover:text-text">{filename}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className="group flex w-[104px] shrink-0 flex-col items-center gap-1 rounded-card border border-border bg-surface px-2 py-2 text-left transition-colors hover:border-accent/60"
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
      <div className="flex flex-wrap gap-2">
        {visible.map((item) => <ArtifactMiniCard key={item.path} item={item} cwd={cwd} />)}
        {extra > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-[104px] shrink-0 flex-col items-center justify-center gap-1 rounded-card border border-dashed border-border bg-surface/50 px-2 py-2 text-[10px] text-muted transition-colors hover:border-accent/60 hover:text-text"
          >
            <span className="text-xs font-medium">+{extra}</span>
            <span className="flex items-center gap-0.5"><ChevronDown size={12} aria-hidden />{t("conversation.more")}</span>
          </button>
        )}
        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-[104px] shrink-0 flex-col items-center justify-center gap-1 rounded-card border border-dashed border-border bg-surface/50 px-2 py-2 text-[10px] text-muted transition-colors hover:border-accent/60 hover:text-text"
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
