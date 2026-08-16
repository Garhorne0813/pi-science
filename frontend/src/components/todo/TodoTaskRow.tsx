import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { TFunction } from "i18next";
import { cn } from "@/lib/ui";
import type { TodoStatus, TodoTask } from "@/lib/conversation/todos";
import { Icon } from "../ui/Icon";

function StatusIcon({ status, compact }: { status: TodoStatus; compact: boolean }) {
  const size = compact ? "xs" : "sm";
  switch (status) {
    case "in_progress": return <Icon icon={Loader2} size={size} className="shrink-0 animate-spin text-accent" />;
    case "completed": return <Icon icon={CheckCircle2} size={size} className="shrink-0 text-ok-text" />;
    case "pending": return <Icon icon={Circle} size={size} className="shrink-0 text-muted" />;
    case "deleted": return <Icon icon={Circle} size={size} className="shrink-0 text-muted" />;
  }
}

function statusLabel(status: TodoStatus, t: TFunction): string {
  return t(`todo.status.${status}`);
}

/** One task row in the shared todo list. Not a button — rows are read-only. */
export function TodoTaskRow({ task, blocked, compact = false, t }: { task: TodoTask; blocked: boolean; compact?: boolean; t: TFunction }) {
  return (
    <li className={cn(
      "flex items-start",
      compact ? "gap-2 rounded-input px-2 py-1.5" : "gap-2.5 rounded-input border bg-surface px-2.5 py-2",
      task.status === "in_progress"
        ? compact ? "bg-accent/5" : "border-accent"
        : !compact && "border-border",
    )}>
      <div className={compact ? "pt-px" : "pt-0.5"}>
        <StatusIcon status={task.status} compact={compact} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("flex flex-wrap items-center gap-y-0.5", compact ? "gap-x-1.5" : "gap-x-2")}>
          <span className={cn(
            "min-w-0 flex-1 truncate text-text",
            compact ? "text-ui-caption" : "font-medium text-ui-caption",
          )} title={task.subject}>
            {task.subject}
          </span>
          <span className={cn(
            "shrink-0 text-ui-micro",
            compact ? "sr-only" : "rounded-full border px-1.5 py-px",
            task.status === "in_progress" ? cn("text-accent", !compact && "border-accent")
              : task.status === "completed" ? cn("text-ok-text", !compact && "border-faint")
                : cn("text-muted", !compact && "border-faint"),
          )}>
            {statusLabel(task.status, t)}
          </span>
        </div>
        {!compact && (task.description || (task.blockedBy?.length ?? 0) > 0 || task.owner) && (
          <div className={cn("flex flex-wrap gap-y-0.5 text-muted", compact ? "mt-px gap-x-2 text-ui-micro" : "mt-0.5 gap-x-3 text-ui-meta")}>
            {task.description && <span className="min-w-0 truncate" title={task.description}>{task.description}</span>}
            {blocked && <span className="text-warn-text">{t("todo.blocked")}</span>}
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
