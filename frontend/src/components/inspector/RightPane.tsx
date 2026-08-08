import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { INSPECTOR_MAX, INSPECTOR_MIN, useUiStore } from "@/lib/ui";
import { cn } from "@/lib/ui";

/** Dragging the divider below this pane width closes the pane — the same
 *  snap-shut behaviour as the sidebar. Sits below INSPECTOR_MIN for a clear snap. */
const COLLAPSE_BELOW = 280;

/** The pane may never squeeze the conversation out on small windows. */
const MAX_FRACTION = 0.7;

/**
 * Resizable right pane hosting an inspector or the session Files browser.
 * The left-edge divider drags within [INSPECTOR_MIN, INSPECTOR_MAX] (persisted);
 * dragging it far right snaps the pane closed. Maximized, the pane covers the
 * all layout space to the right of the sidebar while the conversation hides.
 */
export function RightPane({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
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
    // The pane ends at the window's right edge, so the width is whatever is
    // right of the pointer.
    const w = window.innerWidth - e.clientX;
    if (w < COLLAPSE_BELOW) {
      // Snap closed — the pane unmounts, which also ends the drag.
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
      dragWidthRef.current = null;
      setDragging(false);
      onClose();
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
    const delta = e.key === "ArrowLeft" ? 16 : -16;
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
        dragging && "will-change-[width] select-none",
      )}
      style={{ width: inspectorWidth }}
    >
      <div className={cn("h-full", dragging && "pointer-events-none")}>{children}</div>
      {/* Drag divider: resize within [INSPECTOR_MIN, INSPECTOR_MAX]; dragging
          far right snaps the pane closed. */}
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
        className="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none select-none"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-[2px] transition-colors",
            dragging ? "bg-accent/60" : "bg-transparent group-hover:bg-accent/40",
          )}
        />
      </div>
    </div>
  );
}
