import { useEffect, useState } from "react";
import { INSPECTOR_MAX, INSPECTOR_MIN, useUiStore } from "@/lib/store";
import { cn } from "@/lib/cn";

/** Dragging the divider below this pane width closes the pane — the same
 *  snap-shut behaviour as the sidebar. Sits below INSPECTOR_MIN for a clear snap. */
const COLLAPSE_BELOW = 280;

/** The pane may never squeeze the conversation out on small windows. */
const MAX_FRACTION = 0.7;

/**
 * Resizable right pane hosting an inspector or the session Files browser.
 * The left-edge divider drags within [INSPECTOR_MIN, INSPECTOR_MAX] (persisted);
 * dragging it far right snaps the pane closed. Maximized, the pane covers the
 * whole window — sidebar and conversation stay mounted underneath.
 */
export function RightPane({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Field-level selectors so unrelated UI-store writes do not re-render the pane.
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const inspectorMaximized = useUiStore((s) => s.inspectorMaximized);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  const setInspectorMaximized = useUiStore((s) => s.setInspectorMaximized);
  // While dragging, the live width lives here; the store (and localStorage)
  // are only written on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = dragWidth !== null;

  // Maximized never outlives the pane — closing it returns the next pane
  // (possibly for a different artifact or session) to the normal split.
  useEffect(() => () => setInspectorMaximized(false), [setInspectorMaximized]);

  const clamp = (w: number) =>
    Math.max(
      INSPECTOR_MIN,
      Math.min(w, INSPECTOR_MAX, Math.round(window.innerWidth * MAX_FRACTION)),
    );

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragWidth(inspectorWidth);
  };

  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    // The pane ends at the window's right edge, so the width is whatever is
    // right of the pointer.
    const w = window.innerWidth - e.clientX;
    if (w < COLLAPSE_BELOW) {
      // Snap closed — the pane unmounts, which also ends the drag.
      setDragWidth(null);
      onClose();
      return;
    }
    setDragWidth(clamp(w));
  };

  const onDividerPointerUp = () => {
    if (!dragging) return;
    setInspectorWidth(dragWidth);
    setDragWidth(null);
  };

  if (inspectorMaximized) {
    // The pane header stays the top row; no extra strip above it.
    return <div className="fixed inset-0 z-40 bg-surface">{children}</div>;
  }

  return (
    <div
      className="relative hidden h-full shrink-0 lg:block"
      style={{ width: dragWidth ?? inspectorWidth }}
    >
      <div className="h-full">{children}</div>
      {/* Drag divider: resize within [INSPECTOR_MIN, INSPECTOR_MAX]; dragging
          far right snaps the pane closed. */}
      <div
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onPointerCancel={onDividerPointerUp}
        className="group absolute inset-y-0 left-0 z-10 w-[5px] cursor-col-resize"
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
