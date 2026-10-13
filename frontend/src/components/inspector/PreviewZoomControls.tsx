import { Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Icon";

export const clampPreviewScale = (scale: number) => Math.max(0.25, Math.min(4, Math.round(scale * 100) / 100));

export function PreviewZoomControls({ scale, onChange }: { scale: number; onChange: (scale: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-input bg-surface-2" role="group" aria-label={t("filePreview.fontSize")}>
      <IconButton icon={Minus} label={t("filePreview.zoomOut")} size="compact" disabled={scale <= 0.25} onClick={() => onChange(clampPreviewScale(scale - 0.1))} />
      <button type="button" className="min-w-12 rounded-input px-1 text-ui-caption tabular-nums text-muted hover:text-text" aria-label={t("filePreview.resetZoom")} title={t("filePreview.resetZoom")} onClick={() => onChange(1)}>{Math.round(scale * 100)}%</button>
      <IconButton icon={Plus} label={t("filePreview.zoomIn")} size="compact" disabled={scale >= 4} onClick={() => onChange(clampPreviewScale(scale + 0.1))} />
    </div>
  );
}
