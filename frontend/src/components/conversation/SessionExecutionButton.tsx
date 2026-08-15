import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sessionRunsQuery } from "../../lib/runs";
import { subscribeExecutionInvalidation } from "../../lib/runs/execution-events";
import { cn } from "../../lib/ui";

export function SessionExecutionButton({ cwd, sessionId, active, onToggle }: { cwd: string; sessionId?: string; active: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { data: runs = [] } = useQuery({
    ...sessionRunsQuery(cwd, sessionId ?? ""),
    enabled: Boolean(sessionId),
  });

  useEffect(() => {
    if (!sessionId) return;
    return subscribeExecutionInvalidation(cwd);
  }, [cwd, sessionId]);

  if (!sessionId) return null;
  const running = runs.filter((run) => run.status === "pending" || run.status === "running").length;
  const failed = runs.some((run) => ["failed", "timed_out", "interrupted", "lost"].includes(run.status));
  const label = running > 0
    ? t("runs.sessionActive", { count: running })
    : t("runs.sessionButton", { count: runs.length });

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onToggle}
      className={cn(
        "group flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium transition-colors",
        active
          ? "border-accent/30 bg-accent/10 text-accent"
          : "border-transparent text-muted hover:border-border hover:bg-surface-2 hover:text-text",
      )}
    >
      <span className="relative">
        <Activity size={14} strokeWidth={1.8} />
        {(running > 0 || failed) && (
          <span className={cn(
            "absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-bg",
            running > 0 ? "animate-pulse bg-accent" : "bg-error",
          )} />
        )}
      </span>
      {runs.length > 0 && <span className="tabular-nums">{running || runs.length}</span>}
    </button>
  );
}
