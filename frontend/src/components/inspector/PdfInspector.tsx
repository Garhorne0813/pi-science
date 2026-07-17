import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PdfInspector as PdfInspectorT } from "../../types/thread";
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
  const url = data.url ?? (data.path ? previewUrl(data.path, undefined, cwd) : null);
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
