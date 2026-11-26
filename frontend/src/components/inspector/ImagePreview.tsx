import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Maximize, Scan, Minus, Plus, ScanLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Icon";
import { ViewerToolbar, ViewerStatusBar } from "./PreviewFrame";
import { clampImageScale, imageScaleLimits } from "./image-scale";

import { imagePoint, pixelRect, type PixelPoint, type PixelRect } from "./image-region";
import { RegionAskError, type RegionAskFailureKind } from "./image-region-ask";

/** A failed attachment keeps the two failure modes apart: the workspace
 *  refusing the upload is not the same problem as a dropped connection. */
const REGION_FAILURE_KEYS: Record<RegionAskFailureKind, string> = {
  network: "filePreview.regionFailedNetwork",
  rejected: "filePreview.regionFailedRejected",
  unknown: "filePreview.regionFailed",
  send: "filePreview.regionQuestionFailed",
};

/** Image magnification is independent of file focus and document typography. */
export function ImagePreview({
  url,
  filename,
  onAsk,
}: {
  url: string;
  filename: string;
  onAsk?: (image: HTMLImageElement, rect: PixelRect, question: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const composing = useRef(false);
  const drag = useRef<{ start: PixelPoint; id: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [rect, setRect] = useState<PixelRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [question, setQuestion] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<RegionAskFailureKind | null>(null);
  const cancel = () => {
    drag.current = null;
    setSelecting(false);
    setRect(null);
    setFailure(null);
    setDragging(false);
    setQuestion("");
    composing.current = false;
  };
  const ask = async () => {
    const text = question.trim();
    if (
      !image.current ||
      !rect?.width ||
      !rect.height ||
      !onAsk ||
      inFlight.current ||
      !text ||
      dragging
    )
      return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      if (await onAsk(image.current, rect, text)) cancel();
    } catch (cause) {
      // Keep the original error in the console; the alert only carries the category.
      console.error("Could not submit the image region question", cause);
      setFailure(cause instanceof RegionAskError ? cause.kind : "unknown");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () =>
      setBounds({
        width: Math.max(1, el.clientWidth - 32),
        height: Math.max(1, el.clientHeight - 32),
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit =
    size.width && size.height
      ? Math.min(bounds.width / size.width, bounds.height / size.height, 1)
      : 1;
  const current = scale ?? fit;
  const { min, max } = imageScaleLimits(fit, 4, current);
  const selected = selecting && !dragging && Boolean(rect?.width && rect.height);
  useLayoutEffect(() => {
    const el = viewport.current;
    const img = image.current;
    const editor = form.current;
    if (!selected || !el || !img || !editor || !rect) return;
    const place = () => {
      const view = el.getBoundingClientRect();
      const bounds = img.getBoundingClientRect();
      const left = bounds.left - view.left + rect.x * current;
      const right = left + rect.width * current;
      const top = bounds.top - view.top + rect.y * current;
      const bottom = top + rect.height * current;
      const visible = right > 0 && left < el.clientWidth && bottom > 0 && top < el.clientHeight;
      editor.style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;
      const gap = 8;
      const maxLeft = Math.max(gap, el.clientWidth - editor.offsetWidth - gap);
      const maxTop = Math.max(gap, el.clientHeight - editor.offsetHeight - gap);
      const above = top - editor.offsetHeight - gap;
      const y = bottom + gap <= maxTop || above < gap ? bottom + gap : above;
      editor.style.left = `${el.offsetLeft + Math.min(maxLeft, Math.max(gap, left))}px`;
      editor.style.top = `${el.offsetTop + Math.min(maxTop, Math.max(gap, y))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(editor);
    observer.observe(el);
    el.addEventListener("scroll", place, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", place);
    };
  }, [current, rect, selected]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setScale((previous) => {
        const next = previous ?? fit;
        return clampImageScale(
          next * Math.exp(-event.deltaY * 0.002),
          imageScaleLimits(fit, 4, next),
        );
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit]);
  function moveRegion(event: React.KeyboardEvent) {
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = offsets[event.key];
    if (!direction || saving) return;
    event.preventDefault();
    const initial = rect ?? {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(size.width / 4)),
      height: Math.max(1, Math.round(size.height / 4)),
    };
    const dx = direction[0] * Math.max(1, Math.round(size.width / 100));
    const dy = direction[1] * Math.max(1, Math.round(size.height / 100));
    if (event.shiftKey) {
      setRect({
        ...initial,
        width: Math.max(1, Math.min(size.width - initial.x, initial.width + dx)),
        height: Math.max(1, Math.min(size.height - initial.y, initial.height + dy)),
      });
    } else {
      setRect({
        ...initial,
        x: Math.max(0, Math.min(size.width - initial.width, initial.x + dx)),
        y: Math.max(0, Math.min(size.height - initial.height, initial.y + dy)),
      });
    }
  }
  const reset = (next: number | null) => {
    setScale(next);
    viewport.current?.scrollTo?.({ left: 0, top: 0 });
  };
  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if (selecting && !saving && e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <ViewerToolbar aria-label={t("filePreview.imageToolbar")}>
        <IconButton
          icon={Maximize}
          label={t("filePreview.fitImage")}
          size="compact"
          aria-pressed={scale === null}
          onClick={() => reset(null)}
        />
        <IconButton
          icon={Scan}
          label={t("filePreview.actualImage")}
          size="compact"
          aria-pressed={scale === 1}
          onClick={() => reset(1)}
        />
        <IconButton
          icon={Minus}
          label={t("filePreview.zoomOut")}
          size="compact"
          disabled={current <= min}
          onClick={() => setScale(clampImageScale(current / 1.2, { min, max }))}
        />
        <span className="text-ui-caption tabular-nums text-muted">
          {Math.round(current * 100)}%
        </span>
        <IconButton
          icon={Plus}
          label={t("filePreview.zoomIn")}
          size="compact"
          disabled={current >= max}
          onClick={() => setScale(clampImageScale(current * 1.2, { min, max }))}
        />
        {onAsk && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-input px-2 py-1 text-xs text-text hover:bg-surface-2 disabled:opacity-50"
            aria-pressed={selecting}
            disabled={!size.width || saving || failed}
            onClick={() => (selecting ? cancel() : setSelecting(true))}
          >
            <ScanLine size={14} aria-hidden="true" />
            {t("filePreview.selectRegion")}
          </button>
        )}
      </ViewerToolbar>
      {failure && (
        <p role="alert" className="px-3 text-xs text-error-text">
          {t(REGION_FAILURE_KEYS[failure])}
        </p>
      )}
      <div ref={viewport} className="min-h-0 flex-1 overflow-auto bg-surface-2">
        {failed ? (
          <p role="alert" className="p-4 text-ui-body text-error-text">
            {t("filePreview.imageFailed")}
          </p>
        ) : (
          <div className="flex min-h-full min-w-full w-max items-center justify-center p-4">
            <div className="relative inline-flex">
              <img
                ref={image}
                src={url}
                alt={filename}
                draggable={false}
                onError={() => setFailed(true)}
                onLoad={(event) =>
                  setSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                style={
                  size.width
                    ? {
                        width: size.width * current,
                        height: size.height * current,
                        maxWidth: "none",
                      }
                    : { maxWidth: "100%" }
                }
              />
              {selecting && (
                <div
                  role="group"
                  aria-label={t("filePreview.regionKeyboard")}
                  title={t("filePreview.regionKeyboard")}
                  tabIndex={0}
                  onKeyDown={moveRegion}
                  className="absolute inset-0 touch-none cursor-crosshair focus-visible:outline-accent"
                  onPointerDown={(event) => {
                    if (saving || event.button !== 0 || drag.current || !image.current) return;
                    const start = imagePoint(image.current, event.clientX, event.clientY);
                    drag.current = { start, id: event.pointerId };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging(true);
                    setRect(null);
                    setFailure(null);
                  }}
                  onPointerMove={(event) => {
                    if (drag.current && drag.current.id === event.pointerId && image.current)
                      setRect(
                        pixelRect(
                          drag.current.start,
                          imagePoint(image.current, event.clientX, event.clientY),
                        ),
                      );
                  }}
                  onPointerUp={(event) => {
                    if (!drag.current || drag.current.id !== event.pointerId || !image.current)
                      return;
                    setRect(
                      pixelRect(
                        drag.current.start,
                        imagePoint(image.current, event.clientX, event.clientY),
                      ),
                    );
                    drag.current = null;
                    setDragging(false);
                  }}
                  onLostPointerCapture={() => {
                    if (drag.current) {
                      drag.current = null;
                      setRect(null);
                      setDragging(false);
                    }
                  }}
                >
                  {rect && (
                    <span
                      className="pointer-events-none absolute border-2 border-accent bg-accent/15"
                      style={{
                        left: `${(100 * rect.x) / size.width}%`,
                        top: `${(100 * rect.y) / size.height}%`,
                        width: `${(100 * rect.width) / size.width}%`,
                        height: `${(100 * rect.height) / size.height}%`,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {selected && (
        <form
          ref={form}
          aria-label={t("filePreview.askRegion")}
          className="absolute z-10 flex w-[min(20rem,calc(100%-1.5rem))] items-end gap-2 rounded-input border border-border bg-surface p-2 shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <textarea
            rows={2}
            value={question}
            readOnly={saving}
            aria-label={t("filePreview.askRegion")}
            placeholder={t("filePreview.regionQuestionPlaceholder")}
            className="min-w-0 flex-1 resize-none rounded-input bg-surface-2 px-2 py-1.5 text-sm text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
            onChange={(event) => setQuestion(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing ||
                composing.current
              )
                return;
              event.preventDefault();
              void ask();
            }}
          />
          <button
            type="submit"
            aria-label={t("conversation.sendMessage")}
            disabled={saving || !question.trim()}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-fill text-accent-fg disabled:bg-surface-2 disabled:text-muted"
          >
            {saving ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUp size={16} aria-hidden="true" />
            )}
          </button>
        </form>
      )}
      <ViewerStatusBar>
        {selecting && <span>{t("filePreview.regionHint")}</span>}
        {size.width > 0 && (
          <span>
            {size.width} × {size.height} px
          </span>
        )}
      </ViewerStatusBar>
    </div>
  );
}
