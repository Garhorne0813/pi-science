import { CheckCircle2, Circle, Clock3, Loader2 } from "lucide-react";
import type { TFunction } from "i18next";
import { cn } from "@/lib/ui";
import type { TodoStatus, TodoTask } from "@/lib/conversation/todos";

function StatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case "in_progress": return <Loader2 size={13} className="shrink-0 animate-spin text-accent" aria-hidden />;
    case "completed": return <CheckCircle2 size={13} className="shrink-0 text-ok" aria-hidden />;
    case "pending": return <Clock3 size={13} className="shrink-0 text-muted" aria-hidden />;
    case "deleted": return <Circle size={13} className="shrink-0 text-muted" aria-hidden />;
  }
}

function statusLabel(status: TodoStatus, t: TFunction): string {
  return t(`todo.status.${status}`);
}

/** One task row in the shared todo list. Not a button — rows are read-only. */
export function TodoTaskRow({ task, blocked, t }: { task: TodoTask; blocked: boolean; t: TFunction }) {
  return (
    <li className={cn(
      "flex items-start gap-2.5 rounded-input border bg-surface px-2.5 py-2",
      task.status === "in_progress" ? "border-accent" : "border-border",
    )}>
      <div className="pt-0.5">
        <StatusIcon status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text" title={task.subject}>
            {task.subject}
          </span>
          <span className={cn(
            "shrink-0 rounded-full border px-1.5 py-px text-[10px]",
            task.status === "in_progress" ? "border-accent text-accent"
              : task.status === "completed" ? "border-faint text-ok"
                : "border-faint text-muted",
          )}>
            {statusLabel(task.status, t)}
          </span>
        </div>
        {(task.description || (task.blockedBy?.length ?? 0) > 0 || task.owner) && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
            {task.description && <span className="min-w-0 truncate" title={task.description}>{task.description}</span>}
            {blocked && <span className="text-warn">{t("todo.blocked")}</span>}
            {(task.blockedBy?.length ?? 0) > 0 && (
              <span className="text-muted">{t("todo.blockedBy", { ids: task.blockedBy!.map((id) => `#${id}`).join(", ") })}</span>
            )}
            {task.owner && <span className="text-muted">{t("todo.owner", { owner: task.owner })}</span>}
          </div>
        )}
      </div>
    </li>
  );
}
