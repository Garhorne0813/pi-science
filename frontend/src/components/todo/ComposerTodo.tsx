import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { todoViewModel } from "@/lib/conversation/todos";
import { cn } from "@/lib/ui";
import { TodoTaskList } from "./TodoTaskList";

function ProgressRing({ percent }: { percent: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);

  return (
    <svg viewBox="0 0 18 18" aria-hidden className="h-[18px] w-[18px] shrink-0 -rotate-90">
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent/15" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="text-accent transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
}

/** A composer-anchored todo summary. The full list is a transient preview:
 * hover/focus reveals it, leaving the combined trigger/panel region hides it.
 * Touch users can toggle it with a tap. */
export function ComposerTodo() {
  const { t } = useTranslation();
  const blocks = useRuntimeStore((s) => s.thread.blocks);
  const vm = useMemo(() => todoViewModel(blocks), [blocks]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const lastPointerTypeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!vm || vm.allCompleted) setPreviewOpen(false);
  }, [vm]);

  if (!vm || vm.allCompleted || !vm.activeTask || vm.activeIndex === null) return null;

  const activeLabel = vm.activeTask.activeForm || vm.activeTask.subject;

  return (
    <div className="relative z-40 mx-auto flex max-w-[760px] justify-center pb-2">
      <div
        className="relative"
        onMouseEnter={() => setPreviewOpen(true)}
        onMouseLeave={() => setPreviewOpen(false)}
        onFocus={() => {
          if (lastPointerTypeRef.current === "touch" || lastPointerTypeRef.current === "pen") return;
          setPreviewOpen(true);
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setPreviewOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          setPreviewOpen(false);
        }}
      >
        {previewOpen && (
          <div
            id="composer-todo-preview"
            role="region"
            aria-label={t("todo.title")}
            className="absolute bottom-full left-1/2 w-max min-w-[240px] max-w-[min(380px,calc(100vw-48px))] -translate-x-1/2 pb-2"
          >
            <div className="ui-popover max-h-[min(42vh,360px)] overflow-y-auto rounded-card p-2 shadow-lg">
              <TodoTaskList tasks={vm.tasks} compact />
            </div>
          </div>
        )}

        <button
          type="button"
          aria-expanded={previewOpen}
          aria-controls="composer-todo-preview"
          aria-label={`${t("todo.title")}: ${activeLabel}`}
          onPointerDown={(event) => { lastPointerTypeRef.current = event.pointerType; }}
          onClick={() => {
            // Mouse interaction is hover-only. Click remains a fallback for
            // touch and keyboard users, where hover does not exist.
            if (lastPointerTypeRef.current !== "touch" && lastPointerTypeRef.current !== "pen") {
              lastPointerTypeRef.current = null;
              return;
            }
            setPreviewOpen((open) => !open);
            lastPointerTypeRef.current = null;
          }}
          className={cn(
            "ui-card flex h-9 max-w-[min(560px,calc(100vw-48px))] items-center gap-2 rounded-full px-3 text-left shadow-sm transition-colors",
            "hover:border-accent/25 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
          )}
        >
          <span
            role="progressbar"
            aria-valuenow={vm.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("todo.summary", { completed: vm.completed, total: vm.total })}
          >
            <ProgressRing percent={vm.percent} />
          </span>
          <span className="shrink-0 text-xs font-semibold text-text">
            {t("todo.position", { current: vm.activeIndex, total: vm.total })}
          </span>
          <span aria-hidden className="text-xs text-muted">·</span>
          <span className="min-w-0 truncate text-xs text-muted" title={activeLabel}>{activeLabel}</span>
        </button>
      </div>
    </div>
  );
}
