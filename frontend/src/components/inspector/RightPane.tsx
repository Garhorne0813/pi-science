import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { INSPECTOR_MAX, INSPECTOR_MIN, useUiStore } from "@/lib/ui";
import { cn } from "@/lib/ui";

/** Dragging the divider below this pane width minimizes the pane while keeping
 *  its open tabs, matching the preview visibility button. */
const COLLAPSE_BELOW = 280;

/** The pane may never squeeze the conversation out on small windows. */
const MAX_FRACTION = 0.7;

/**
 * Resizable preview pane that can sit on either side of the conversation.
 * Its conversation-facing divider drags within [INSPECTOR_MIN, INSPECTOR_MAX]
 * (persisted); dragging toward the pane minimizes it. Maximized, the pane
 * covers all layout space to the right of the sidebar while conversation hides.
 */
export function RightPane({
  children,
  onMinimize,
  side = "right",
}: {
  children: React.ReactNode;
  onMinimize: () => void;
  side?: "left" | "right";
}) {
  const { t } = useTranslation();
  // Field-level selectors so unrelated UI-store writes do not re-render the pane.
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const inspectorMaximized = useUiStore((s) => s.inspectorMaximized);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  const setInspectorMaximized = useUiStore((s) => s.setInspectorMaximized);
  // Live width changes are applied directly once per animation frame. This
  // avoids reconciling the (potentially expensive) preview tree on every
  // pointermove; the persisted store is only written on pointer-up.
  const [dragging, setDragging] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const dragFrameRef = useRef<number | null>(null);

  // Maximized never outlives the pane — closing it returns the next pane
  // (possibly for a different artifact or session) to the normal split.
  useEffect(() => () => setInspectorMaximized(false), [setInspectorMaximized]);
  useEffect(() => () => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
  }, []);

  const clamp = (w: number) =>
    Math.max(
      INSPECTOR_MIN,
      Math.min(w, INSPECTOR_MAX, Math.round(window.innerWidth * MAX_FRACTION)),
    );

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragWidthRef.current = inspectorWidth;
    setDragging(true);
  };

  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const paneLeft = paneRef.current?.getBoundingClientRect().left ?? 0;
    // A right-side pane grows toward the left; a left-side pane grows toward
    // the right, so the same divider gesture maps to opposite width formulas.
    const w = side === "right" ? window.innerWidth - e.clientX : e.clientX - paneLeft;
    if (w < COLLAPSE_BELOW) {
      // Snap to the hidden state without discarding tabs. The pane unmounts,
      // which also ends the drag, and can be restored from the header button.
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
      dragWidthRef.current = null;
      setDragging(false);
      onMinimize();
      return;
    }
    const nextWidth = clamp(w);
    dragWidthRef.current = nextWidth;
    e.currentTarget.setAttribute("aria-valuenow", String(nextWidth));
    if (dragFrameRef.current === null) {
      // The sentinel also keeps synchronous requestAnimationFrame shims used
      // in tests from leaving a stale frame id behind.
      dragFrameRef.current = -1;
      const frame = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        const liveWidth = dragWidthRef.current;
        if (liveWidth !== null && paneRef.current) paneRef.current.style.width = `${liveWidth}px`;
      });
      if (dragFrameRef.current !== null) dragFrameRef.current = frame;
    }
  };

  const onDividerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const nextWidth = dragWidthRef.current;
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    if (nextWidth !== null) {
      if (paneRef.current) paneRef.current.style.width = `${nextWidth}px`;
      setInspectorWidth(nextWidth);
    }
    dragWidthRef.current = null;
    setDragging(false);
  };

  const onDividerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = side === "right"
      ? (e.key === "ArrowLeft" ? 16 : -16)
      : (e.key === "ArrowRight" ? 16 : -16);
    setInspectorWidth(clamp(inspectorWidth + delta));
  };

  if (inspectorMaximized) {
    return <div className="relative h-full min-w-0 flex-1 bg-surface">{children}</div>;
  }

  return (
    <div
      ref={paneRef}
      className={cn(
        "relative hidden h-full shrink-0 lg:block",
        side === "left" && "order-1",
        dragging && "will-change-[width] select-none",
      )}
      style={{ width: inspectorWidth }}
    >
      <div className={cn("h-full", dragging && "pointer-events-none")}>{children}</div>
      {/* Drag divider: resize within [INSPECTOR_MIN, INSPECTOR_MAX]; dragging
          toward the pane minimizes it while retaining its tabs. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("shell.resizePane")}
        aria-valuemin={INSPECTOR_MIN}
        aria-valuemax={INSPECTOR_MAX}
        aria-valuenow={inspectorWidth}
        tabIndex={0}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onPointerCancel={onDividerPointerUp}
        onKeyDown={onDividerKeyDown}
        className={cn(
          "group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none select-none",
          side === "right" ? "left-0" : "right-0",
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 w-[2px] transition-colors",
            side === "right" ? "left-0" : "right-0",
            dragging ? "bg-accent/60" : "bg-transparent group-hover:bg-accent/40",
          )}
        />
      </div>
    </div>
  );
}
