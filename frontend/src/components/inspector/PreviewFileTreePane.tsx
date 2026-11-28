import { useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { cn, useUiStore } from "@/lib/ui";
import { FileBrowser } from "../sidebar/FileBrowser";
import { PreviewPaneControls } from "./PreviewPaneControls";

const TREE_MIN_WIDTH = 180;
const TREE_MAX_WIDTH = 340;

function clampTreeWidth(width: number) {
  return Math.min(TREE_MAX_WIDTH, Math.max(TREE_MIN_WIDTH, Math.round(width)));
}

export function PreviewFileTreePane({
  cwd,
  conversationKey,
  split,
}: {
  cwd: string;
  conversationKey?: string | null;
  split: boolean;
}) {
  const { t } = useTranslation();
  const width = useUiStore((state) => state.previewFileTreeWidth);
  const side = useUiStore((state) => state.previewFileTreeSide);
  const setWidth = useUiStore((state) => state.setPreviewFileTreeWidth);
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  return (
    <section
      aria-label={t("files.tree")}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col bg-surface",
        split
          ? cn(
              "absolute inset-y-0 z-20 w-[min(82vw,var(--file-tree-width))] shadow-xl lg:relative lg:z-auto lg:w-[var(--file-tree-width)] lg:shrink-0 lg:shadow-none",
              side === "left"
                ? "left-0 border-r border-border lg:order-none"
                : "right-0 border-l border-border lg:order-2",
            )
          : "min-w-0 flex-1",
      )}
      style={{ "--file-tree-width": `${clampTreeWidth(width)}px` } as CSSProperties}
    >
      {!split && (
        <div className="relative flex h-11 shrink-0 items-center border-b border-border bg-surface px-3">
          <span className="text-ui-label font-medium text-text">{t("files.tree")}</span>
          <PreviewPaneControls embedded showFileTreeToggle />
        </div>
      )}
      <div className="min-h-0 flex-1 px-1 pb-1">
        <FileBrowser cwd={cwd} embedded mode="pane" conversationKey={conversationKey} />
      </div>
      {split && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("files.resize", { defaultValue: "Resize file tree" })}
          aria-valuemin={TREE_MIN_WIDTH}
          aria-valuemax={TREE_MAX_WIDTH}
          aria-valuenow={clampTreeWidth(width)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { pointerId: event.pointerId, x: event.clientX, width };
          }}
          onPointerMove={(event) => {
            if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
            const delta = event.clientX - dragRef.current.x;
            setWidth(clampTreeWidth(dragRef.current.width + (side === "left" ? delta : -delta)));
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            dragRef.current = null;
          }}
          onPointerCancel={() => { dragRef.current = null; }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const delta = side === "left"
              ? (event.key === "ArrowRight" ? 16 : -16)
              : (event.key === "ArrowLeft" ? 16 : -16);
            setWidth(clampTreeWidth(width + delta));
          }}
          className={cn(
            "group absolute inset-y-0 z-30 hidden w-2 cursor-col-resize touch-none lg:block",
            side === "left" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
          )}
        >
          <span className={cn("absolute inset-y-0 w-px bg-transparent transition-colors group-hover:bg-accent/50", side === "left" ? "left-1/2" : "right-1/2")} />
        </div>
      )}
    </section>
  );
}
