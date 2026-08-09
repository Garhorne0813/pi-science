import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ListTodo, Minimize2, Pin } from "lucide-react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { useUiStore } from "@/lib/ui";
import { todoViewModel } from "@/lib/conversation/todos";
import { cn } from "@/lib/ui";
import { TodoTaskList } from "./TodoTaskList";
import { useTodoAutoOpenOnce } from "./useTodoAutoOpenOnce";
import { Icon, IconButton } from "../ui/Icon";

/** Mode-switch control shared by both widgets (kept tiny so the streak/auto
 *  open semantics live in one place per widget). */
export function TodoModeSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const mode = useUiStore((s) => s.todoUiMode);
  const setTodoUiMode = useUiStore((s) => s.setTodoUiMode);
  const target = mode === "sticky" ? "fab" : "sticky";
  const label = t("todo.switchMode", { mode: t(`todo.mode.${target}`) });
  return (
    <IconButton
      icon={target === "fab" ? Minimize2 : Pin}
      label={label}
      size="compact"
      onClick={() => setTodoUiMode(target)}
      className={cn("border border-border", className)}
    />
  );
}

/**
 * Mode A: a compact progress bar floating above the conversation thread
 * (absolute overlay, takes no document-flow space). Shows percent +
 * completed/total + the active task's active form; clicking the bar opens the
 * task list in a popover panel below it (independent scroll region).
 */
export function TodoStickyBar() {
  const { t } = useTranslation();
  const mode = useUiStore((s) => s.todoUiMode);
  const blocks = useRuntimeStore((s) => s.thread.blocks);
  const threadLoaded = useRuntimeStore((s) => s.thread.loaded);
  const cwd = useRuntimeStore((s) => s.cwd);
  const sessionId = useRuntimeStore((s) => s.activeSessionId);
  const vm = useMemo(() => todoViewModel(blocks), [blocks]);
  const hasOpenTasks = Boolean(vm && !vm.allCompleted);
  const { open, setOpen, close } = useTodoAutoOpenOnce(hasOpenTasks, `${cwd}:${sessionId ?? ""}`, threadLoaded);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") close();
  }, [close]);

  if (mode !== "sticky" || !vm || vm.allCompleted) return null;

  const activeLabel = vm.activeTask ? (vm.activeTask.activeForm || vm.activeTask.subject) : null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-3 top-3 z-30 mx-auto max-w-[760px]"
      onKeyDown={onKeyDown}
    >
      <div className="ui-card rounded-card">
        <div className="flex items-center gap-1.5 pr-2 pl-1">
          <button
            type="button"
            onClick={() => (open ? close() : setOpen(true))}
            aria-expanded={open}
            aria-controls="todo-sticky-list"
            className="flex min-h-header min-w-0 flex-1 items-center gap-2 rounded-input px-2 py-2 text-left transition-colors hover:bg-surface-2 md:min-h-9"
          >
            <Icon icon={ListTodo} size="sm" className="shrink-0 text-accent" />
            <span
              role="progressbar"
              aria-valuenow={vm.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t("todo.title")}
              className="shrink-0 text-xs font-medium text-text"
            >
              {vm.percent}% · {vm.completed}/{vm.total}
            </span>
            {vm.allCompleted ? (
              <span className="shrink-0 text-ui-meta text-ok">{t("todo.allCompleted")}</span>
            ) : activeLabel ? (
              <span className="min-w-0 flex-1 truncate text-ui-meta text-muted" title={activeLabel}>
                {activeLabel}
              </span>
            ) : null}
            <Icon icon={ChevronDown} size="sm" className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} />
          </button>
          <TodoModeSwitch />
        </div>
      </div>
      {open && (
        <div
          id="todo-sticky-list"
          className="ui-popover absolute left-0 right-0 top-full mt-1 max-h-[min(42vh,360px)] overflow-y-auto rounded-card p-compact"
        >
          <TodoTaskList tasks={vm.tasks} compact />
        </div>
      )}
    </div>
  );
}
