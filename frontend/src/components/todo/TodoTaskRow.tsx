import { CheckCircle2, Circle, Clock3, Loader2 } from "lucide-react";
import type { TFunction } from "i18next";
import { cn } from "@/lib/ui";
import type { TodoStatus, TodoTask } from "@/lib/conversation/todos";

function StatusIcon({ status, compact }: { status: TodoStatus; compact: boolean }) {
  const size = compact ? 12 : 13;
  switch (status) {
    case "in_progress": return <Loader2 size={size} className="shrink-0 animate-spin text-accent" aria-hidden />;
    case "completed": return <CheckCircle2 size={size} className="shrink-0 text-ok" aria-hidden />;
    case "pending": return <Clock3 size={size} className="shrink-0 text-muted" aria-hidden />;
    case "deleted": return <Circle size={size} className="shrink-0 text-muted" aria-hidden />;
  }
}

function statusLabel(status: TodoStatus, t: TFunction): string {
  return t(`todo.status.${status}`);
}

/** One task row in the shared todo list. Not a button — rows are read-only. */
export function TodoTaskRow({ task, blocked, compact = false, t }: { task: TodoTask; blocked: boolean; compact?: boolean; t: TFunction }) {
  return (
    <li className={cn(
      "flex items-start border bg-surface",
      compact ? "gap-2 rounded-md px-2 py-1.5" : "gap-2.5 rounded-input px-2.5 py-2",
      task.status === "in_progress"
        ? compact ? "border-accent/30 bg-accent/5" : "border-accent"
        : compact ? "border-transparent" : "border-border",
    )}>
      <div className={compact ? "pt-px" : "pt-0.5"}>
        <StatusIcon status={task.status} compact={compact} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("flex flex-wrap items-center gap-y-0.5", compact ? "gap-x-1.5" : "gap-x-2")}>
          <span className={cn("min-w-0 flex-1 truncate font-medium text-text", compact ? "text-[11px]" : "text-xs")} title={task.subject}>
            {task.subject}
          </span>
          <span className={cn(
            "shrink-0 text-[10px]",
            !compact && "rounded-full border px-1.5 py-px",
            task.status === "in_progress" ? cn("text-accent", !compact && "border-accent")
              : task.status === "completed" ? cn("text-ok", !compact && "border-faint")
                : cn("text-muted", !compact && "border-faint"),
          )}>
            {statusLabel(task.status, t)}
          </span>
        </div>
        {(task.description || (task.blockedBy?.length ?? 0) > 0 || task.owner) && (
          <div className={cn("flex flex-wrap gap-y-0.5 text-muted", compact ? "mt-px gap-x-2 text-[10px]" : "mt-0.5 gap-x-3 text-[11px]")}>
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
