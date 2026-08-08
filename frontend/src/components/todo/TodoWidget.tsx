import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import { ListTodo, X } from "lucide-react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { useUiStore } from "@/lib/ui";
import { todoViewModel } from "@/lib/conversation/todos";
import { TodoTaskList } from "./TodoTaskList";
import { TodoModeSwitch } from "./TodoStickyBar";
import { useTodoAutoOpenOnce } from "./useTodoAutoOpenOnce";

/**
 * Mode B: a floating pill button in the corner with live progress, expanding
 * into a popover card with the full task list. Auto-expands once per todo
 * streak (see useTodoAutoOpenOnce); Escape / outside press close it (Radix).
 */
export function TodoWidget() {
  const { t } = useTranslation();
  const mode = useUiStore((s) => s.todoUiMode);
  const blocks = useRuntimeStore((s) => s.thread.blocks);
  const cwd = useRuntimeStore((s) => s.cwd);
  const sessionId = useRuntimeStore((s) => s.activeSessionId);
  const vm = useMemo(() => todoViewModel(blocks), [blocks]);
  const { open, setOpen, close } = useTodoAutoOpenOnce(Boolean(vm), `${cwd}:${sessionId ?? ""}`);

  if (mode !== "fab" || !vm) return null;

  const activeLabel = vm.activeTask ? (vm.activeTask.activeForm || vm.activeTask.subject) : null;
  const summary = `${vm.percent}% · ${vm.completed}/${vm.total}`;

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="fixed right-5 bottom-5 z-[90] flex min-h-10 max-w-[min(360px,calc(100vw-24px))] items-center gap-2 rounded-full border border-border bg-surface px-3 shadow-card transition-colors hover:bg-surface-2"
        >
          <ListTodo size={15} className="shrink-0 text-accent" aria-hidden />
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
            <span className="shrink-0 text-[11px] text-ok">{t("todo.allCompleted")}</span>
          ) : activeLabel ? (
            <span className="min-w-0 truncate text-[11px] text-muted" title={activeLabel}>{activeLabel}</span>
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="end"
          className="z-[95] w-[min(320px,calc(100vw-24px))] rounded-card border border-border bg-surface shadow-card outline-none"
        >
          <div className="flex items-center gap-1.5 border-b border-faint px-2 py-1.5">
            <h2 className="shrink-0 text-[11px] font-medium text-text">{t("todo.title")}</h2>
            <span
              role="progressbar"
              aria-valuenow={vm.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="shrink-0 text-[10px] text-muted"
            >
              {summary}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <TodoModeSwitch />
              <Popover.Close asChild>
                <button
                  type="button"
                  aria-label={t("todo.close")}
                  className="rounded-input p-0.5 text-muted transition-colors hover:bg-surface-2 hover:text-text"
                >
                  <X size={12} aria-hidden />
                </button>
              </Popover.Close>
            </div>
          </div>
          <div className="max-h-[min(56vh,420px)] overflow-y-auto p-1.5">
            <TodoTaskList tasks={vm.tasks} compact />
          </div>
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
