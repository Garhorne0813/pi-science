import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TodoTask } from "@/lib/conversation/todos";
import { cn } from "@/lib/ui";
import { TodoTaskRow } from "./TodoTaskRow";

/** Shared read-only task list. Scrolls inside whatever max-height its shell
 *  gives it; the shell owns the scroll region. */
export function TodoTaskList({ tasks, compact = false }: { tasks: TodoTask[]; compact?: boolean }) {
  const { t } = useTranslation();
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const blockedIds = useMemo(() => {
    const set = new Set<number>();
    for (const task of tasks) {
      const depends = (task.blockedBy ?? []).some((id) => {
        const dependency = byId.get(id);
        return dependency !== undefined && dependency.status !== "completed";
      });
      if (depends) set.add(task.id);
    }
    return set;
  }, [tasks, byId]);

  return (
    <ul className={cn("overflow-y-auto", compact ? "space-y-0.5" : "space-y-1.5")}>
      {tasks.map((task) => (
        <TodoTaskRow key={task.id} task={task} blocked={blockedIds.has(task.id)} compact={compact} t={t} />
      ))}
    </ul>
  );
}
