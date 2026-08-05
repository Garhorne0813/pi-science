import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, Clock3, ListTodo, Loader2 } from "lucide-react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { extractTodoSnapshot, visibleTasks, type TodoStatus, type TodoTask } from "@/lib/conversation/todos";
import { cn } from "@/lib/ui";

/** Status badge colors — always paired with a text label, never color alone. */
function statusClasses(status: TodoStatus): string {
  switch (status) {
    case "in_progress": return "border-accent/40 bg-accent/10 text-accent";
    case "completed": return "border-ok/40 bg-ok/10 text-ok";
    case "pending": return "border-border bg-surface-2 text-muted";
    case "deleted": return "border-border bg-surface-2 text-muted line-through";
  }
}

function StatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case "in_progress": return <Loader2 size={13} className="shrink-0 animate-spin text-accent" aria-hidden />;
    case "completed": return <CheckCircle2 size={13} className="shrink-0 text-ok" aria-hidden />;
    case "pending": return <Clock3 size={13} className="shrink-0 text-muted" aria-hidden />;
    case "deleted": return <Circle size={13} className="shrink-0 text-muted" aria-hidden />;
  }
}

function TaskRow({ task, t }: { task: TodoTask; t: (key: string, options?: Record<string, unknown>) => string }) {
  const statusLabel = t(`todo.status.${task.status}`);
  return (
    <li className="flex items-start gap-2 rounded-input border border-border bg-surface px-2.5 py-2">
      <div className="pt-0.5">
        <StatusIcon status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text" title={task.subject}>{task.subject}</span>
          <span className={cn("shrink-0 rounded-full border px-1.5 py-px text-[10px]", statusClasses(task.status))}>
            {statusLabel}
          </span>
        </div>
        {(task.description || (task.blockedBy?.length ?? 0) > 0 || task.owner) && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
            {task.description && <span className="min-w-0 truncate" title={task.description}>{task.description}</span>}
            {(task.blockedBy?.length ?? 0) > 0 && (
              <span>{t("todo.blockedBy", { ids: task.blockedBy!.map((id) => `#${id}`).join(", ") })}</span>
            )}
            {task.owner && <span>{t("todo.owner", { owner: task.owner })}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Read-only todo list rebuilt from the conversation's todo toolResult
 * snapshots (no live events exist). Rendered above the inspector content in
 * the right pane; hidden when the conversation has no visible tasks.
 */
export function TodoPanel() {
  const { t } = useTranslation();
  const blocks = useRuntimeStore((s) => s.thread.blocks);
  const tasks = useMemo(() => {
    const snapshot = extractTodoSnapshot(blocks);
    return snapshot ? visibleTasks(snapshot) : null;
  }, [blocks]);

  if (!tasks || tasks.length === 0) return null;

  return (
    <section aria-label={t("todo.title")} className="shrink-0 border-b border-border bg-surface/60 px-3 py-2.5">
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-text">
        <ListTodo size={14} className="text-accent" aria-hidden />
        {t("todo.title")}
        <span aria-hidden className="ml-auto rounded-full border border-border px-1.5 py-px text-[10px] text-muted">
          {tasks.filter((task) => task.status !== "completed").length}/{tasks.length}
        </span>
      </h2>
      <ul className="mt-2 space-y-1.5">
        {tasks.map((task) => <TaskRow key={task.id} task={task} t={t} />)}
      </ul>
    </section>
  );
}
