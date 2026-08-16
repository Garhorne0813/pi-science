import { useEffect, useRef, useState, type CSSProperties } from "react";
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

  // A persisted width is only valid for the viewport it was saved in: shrinking
  // the window re-clamps the stored width so the pane can never squeeze the
  // conversation out on a smaller screen.
  useEffect(() => {
    const onResize = () => {
      const current = useUiStore.getState().inspectorWidth;
      const next = clamp(current);
      if (next !== current) setInspectorWidth(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setInspectorWidth]);

  // On small screens the pane is a full-screen overlay, so it must present
  // dialog semantics; the desktop split pane stays a plain region.
  const [mobileOverlay, setMobileOverlay] = useState(() =>
    window.matchMedia("(max-width: 1023.98px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023.98px)");
    const update = () => setMobileOverlay(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Full-screen dialog focus contract: move focus into the overlay when it
  // appears, trap Tab inside it, close on Escape, and hand focus back to the
  // element that opened it when it unmounts or resizes back to a split pane.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!mobileOverlay) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    paneRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [mobileOverlay]);

  const onOverlayKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onMinimize();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = e.currentTarget.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

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
      role={mobileOverlay ? "dialog" : undefined}
      aria-modal={mobileOverlay || undefined}
      aria-label={mobileOverlay ? t("filePreview.openFiles") : undefined}
      tabIndex={mobileOverlay ? -1 : undefined}
      onKeyDown={mobileOverlay ? onOverlayKeyDown : undefined}
      className={cn(
        "fixed inset-0 z-50 block h-full w-full bg-surface outline-none lg:relative lg:inset-auto lg:z-auto lg:w-[var(--inspector-width)] lg:shrink-0",
        side === "left" && "order-1",
        dragging && "will-change-[width] select-none",
      )}
      style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
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
        tabIndex={mobileOverlay ? -1 : 0}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onPointerCancel={onDividerPointerUp}
        onKeyDown={onDividerKeyDown}
        className={cn(
          "group absolute inset-y-0 z-10 hidden w-2 cursor-col-resize touch-none select-none lg:block",
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
