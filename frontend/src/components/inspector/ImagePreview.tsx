import { useEffect, useRef, useState } from "react";
import { Maximize, Scan, Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Icon";
import { ViewerToolbar, ViewerStatusBar } from "./PreviewFrame";
import { clampImageScale, imageScaleLimits } from "./image-scale";

/** Image magnification is independent of file focus and document typography. */
export function ImagePreview({ url, filename }: { url: string; filename: string }) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setBounds({ width: Math.max(1, el.clientWidth - 32), height: Math.max(1, el.clientHeight - 32) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = size.width && size.height ? Math.min(bounds.width / size.width, bounds.height / size.height, 1) : 1;
  const current = scale ?? fit;
  const { min, max } = imageScaleLimits(fit, 4, current);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setScale((previous) => {
        const next = previous ?? fit;
        return clampImageScale(next * Math.exp(-event.deltaY * 0.002), imageScaleLimits(fit, 4, next));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit]);
  const reset = (next: number | null) => {
    setScale(next);
    viewport.current?.scrollTo?.({ left: 0, top: 0 });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerToolbar aria-label={t("filePreview.imageToolbar")}>
        <IconButton icon={Maximize} label={t("filePreview.fitImage")} size="compact" aria-pressed={scale === null} onClick={() => reset(null)} />
        <IconButton icon={Scan} label={t("filePreview.actualImage")} size="compact" aria-pressed={scale === 1} onClick={() => reset(1)} />
        <IconButton icon={Minus} label={t("filePreview.zoomOut")} size="compact" disabled={current <= min} onClick={() => setScale(clampImageScale(current / 1.2, { min, max }))} />
        <span className="text-ui-caption tabular-nums text-muted">{Math.round(current * 100)}%</span>
        <IconButton icon={Plus} label={t("filePreview.zoomIn")} size="compact" disabled={current >= max} onClick={() => setScale(clampImageScale(current * 1.2, { min, max }))} />
      </ViewerToolbar>
      <div ref={viewport} className="min-h-0 flex-1 overflow-auto bg-surface-2">
        {failed ? <p role="alert" className="p-4 text-ui-body text-error-text">{t("filePreview.imageFailed")}</p> : (
          <div className="flex min-h-full min-w-full w-max items-center justify-center p-4">
            <img src={url} alt={filename} draggable={false} onError={() => setFailed(true)} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} style={size.width ? { width: size.width * current, height: size.height * current, maxWidth: "none" } : { maxWidth: "100%" }} />
          </div>
        )}
      </div>
      <ViewerStatusBar>{size.width > 0 && <span>{size.width} × {size.height} px</span>}</ViewerStatusBar>
    </div>
  );
}
