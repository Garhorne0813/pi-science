import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import { ListTodo, X } from "lucide-react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { cn, useUiStore } from "@/lib/ui";
import { todoViewModel } from "@/lib/conversation/todos";
import { TodoTaskList } from "./TodoTaskList";
import { TodoModeSwitch } from "./TodoStickyBar";
import { useTodoAutoOpenOnce } from "./useTodoAutoOpenOnce";
import { Icon, IconButton } from "../ui/Icon";

const TODO_POSITION_KEY = "pi-science.todo-widget-position";
const DRAG_THRESHOLD = 4;
const EDGE_GAP = 8;

type TodoPosition = { left: number; top: number };

function storedPosition(): TodoPosition | null {
  try {
    const value = JSON.parse(localStorage.getItem(TODO_POSITION_KEY) ?? "null") as Partial<TodoPosition> | null;
    return value && Number.isFinite(value.left) && Number.isFinite(value.top)
      ? { left: Number(value.left), top: Number(value.top) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Mode B: a floating pill button in the corner with live progress, expanding
 * into a popover card with the full task list. Auto-expands once per todo
 * streak (see useTodoAutoOpenOnce); Escape / outside press close it (Radix).
 */
export function TodoWidget() {
  const { t } = useTranslation();
  const mode = useUiStore((s) => s.todoUiMode);
  const blocks = useRuntimeStore((s) => s.thread.blocks);
  const threadLoaded = useRuntimeStore((s) => s.thread.loaded);
  const cwd = useRuntimeStore((s) => s.cwd);
  const sessionId = useRuntimeStore((s) => s.activeSessionId);
  const vm = useMemo(() => todoViewModel(blocks), [blocks]);
  const hasOpenTasks = Boolean(vm && !vm.allCompleted);
  const { open, setOpen, close } = useTodoAutoOpenOnce(hasOpenTasks, `${cwd}:${sessionId ?? ""}`, threadLoaded);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const positionRef = useRef<TodoPosition | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [position, setPosition] = useState<TodoPosition | null>(() => storedPosition());
  positionRef.current = position;

  const constrainPosition = useCallback((candidate: TodoPosition): TodoPosition => {
    const button = triggerRef.current;
    const parent = button?.parentElement;
    if (!button || !parent) return candidate;
    const parentRect = parent.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      left: Math.min(Math.max(EDGE_GAP, candidate.left), Math.max(EDGE_GAP, parentRect.width - buttonRect.width - EDGE_GAP)),
      top: Math.min(Math.max(EDGE_GAP, candidate.top), Math.max(EDGE_GAP, parentRect.height - buttonRect.height - EDGE_GAP)),
    };
  }, []);

  const updatePosition = useCallback((candidate: TodoPosition, persist = false) => {
    const next = constrainPosition(candidate);
    positionRef.current = next;
    setPosition(next);
    if (persist) localStorage.setItem(TODO_POSITION_KEY, JSON.stringify(next));
  }, [constrainPosition]);

  useEffect(() => {
    const button = triggerRef.current;
    const parent = button?.parentElement;
    if (!button || !parent) return;
    const keepInBounds = () => {
      const current = positionRef.current;
      if (!current) return;
      const next = constrainPosition(current);
      if (next.left === current.left && next.top === current.top) return;
      positionRef.current = next;
      setPosition(next);
      localStorage.setItem(TODO_POSITION_KEY, JSON.stringify(next));
    };
    const observer = new ResizeObserver(keepInBounds);
    observer.observe(parent);
    observer.observe(button);
    keepInBounds();
    return () => observer.disconnect();
  }, [constrainPosition]);

  if (mode !== "fab" || !vm || vm.allCompleted) return null;

  const activeLabel = vm.activeTask ? (vm.activeTask.activeForm || vm.activeTask.subject) : null;
  const summary = `${vm.percent}% · ${vm.completed}/${vm.total}`;

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          style={position ? { left: position.left, top: position.top } : undefined}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const parentRect = event.currentTarget.parentElement?.getBoundingClientRect();
            if (!parentRect) return;
            const buttonRect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originLeft: buttonRect.left - parentRect.left,
              originTop: buttonRect.top - parentRect.top,
              moved: false,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const deltaX = event.clientX - drag.startX;
            const deltaY = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
            if (!drag.moved) close();
            drag.moved = true;
            suppressClickRef.current = true;
            event.preventDefault();
            updatePosition({ left: drag.originLeft + deltaX, top: drag.originTop + deltaY });
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (drag.moved && positionRef.current) updatePosition(positionRef.current, true);
            dragRef.current = null;
          }}
          onPointerCancel={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            dragRef.current = null;
            suppressClickRef.current = false;
          }}
          onClick={(event) => {
            if (!suppressClickRef.current) return;
            suppressClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
          }}
          className={cn(
            "ui-card absolute z-[90] flex min-h-primary max-w-[min(360px,calc(100vw-24px))] touch-none cursor-grab items-center gap-2 rounded-full px-panel transition-colors hover:bg-surface-2 active:cursor-grabbing",
            position ? "right-auto bottom-auto" : "right-5 bottom-5",
          )}
        >
          <Icon icon={ListTodo} size="md" className="shrink-0 text-accent" />
          <span
            role="progressbar"
            aria-valuenow={vm.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("todo.title")}
            className="shrink-0 text-xs font-medium text-text"
          >
            {summary}
          </span>
          {vm.allCompleted ? (
            <span className="shrink-0 text-ui-meta text-ok">{t("todo.allCompleted")}</span>
          ) : activeLabel ? (
            <span className="min-w-0 truncate text-ui-meta text-muted" title={activeLabel}>{activeLabel}</span>
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="end"
          className="ui-popover z-[95] w-[min(320px,calc(100vw-24px))] rounded-card outline-none"
        >
          <div className="flex min-h-nav items-center gap-compact border-b border-faint px-2 py-compact">
            <h2 className="shrink-0 text-ui-meta font-medium text-text">{t("todo.title")}</h2>
            <span
              role="progressbar"
              aria-valuenow={vm.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="shrink-0 text-ui-micro text-muted"
            >
              {summary}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <TodoModeSwitch />
              <Popover.Close asChild>
                <IconButton icon={X} label={t("todo.close")} size="compact" />
              </Popover.Close>
            </div>
          </div>
          <div className="max-h-[min(56vh,420px)] overflow-y-auto p-compact">
            <TodoTaskList tasks={vm.tasks} compact />
          </div>
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
