import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Check, X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/ui";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useTranslation } from "react-i18next";
import { timeAgo } from "../../lib/shared";
import { queryClient } from "../../lib/client/query-client";
import { runLogQuery, runsQuery } from "../../lib/runs";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";

export function RunsPage() {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<Record<string, string>>({});

  const runsResult = useQuery(runsQuery(workspaceCwd));
  const runs = runsResult.data ?? [];
  const loading = runsResult.isFetching;

  const runsError = runsResult.error;
  useEffect(() => {
    if (runsError) toast(runsError instanceof Error ? runsError.message : t("runs.loadError"), "error");
  }, [runsError, t, toast]);

  const toggleLog = async (executionId: string) => {
    if (expanded[executionId]) {
      setExpanded((p) => ({ ...p, [executionId]: false }));
      return;
    }
    setExpanded((p) => ({ ...p, [executionId]: true }));
    if (!logs[executionId]) {
      try {
        const data = await queryClient.fetchQuery(runLogQuery(workspaceCwd, executionId));
        const log = [data.stdout, data.stderr].filter(Boolean).join("\n");
        setLogs((p) => ({ ...p, [executionId]: log || t("runs.noLog") }));
      } catch (error) {
        setLogs((p) => ({ ...p, [executionId]: t("runs.logLoadFailed") }));
        toast(error instanceof Error ? error.message : t("runs.logError"), "error");
      }
    }
  };

  const executionLabel = (run: (typeof runs)[number]) => {
    if (run.kind === "kernel_cell") {
      const notebook = typeof run.request.notebook_id === "string" ? run.request.notebook_id : "default";
      const code = typeof run.request.code === "string" ? run.request.code.trim().split("\n")[0] : "";
      return `${notebook} · ${code || run.surface}`;
    }
    return run.request.command?.join(" ") || String(run.request.tool || run.execution_id);
  };

  return (
    <WorkspacePage>
        <WorkspacePageHeader
          title={t("runs.title")}
          description={t("runs.count", { count: runs.length })}
          actions={
          <WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => void runsResult.refetch()} />
          }
        />

        <div className="mt-6">
        {loading ? (
          <div className="text-sm text-muted py-8 text-center"><Loader2 size={18} className="animate-spin mx-auto mb-2" /> {t("common.loading")}</div>
        ) : runs.length === 0 ? (
          <div className="text-center py-16">
            <Play size={40} className="mx-auto text-muted/30 mb-3" />
            <p className="text-sm text-muted">{t("runs.empty")}</p>
            <p className="text-xs text-muted mt-1">{t("runs.emptyHint")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {runs.map((r) => (
              <div key={r.execution_id} className="ui-card-flat overflow-hidden rounded-card">
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className={cn("shrink-0", r.status === "succeeded" ? "text-ok" : r.status === "running" || r.status === "pending" ? "text-warn" : "text-error")}>
                    {r.status === "succeeded" ? <Check size={16} /> : r.status === "running" || r.status === "pending" ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] text-text truncate">{executionLabel(r)}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted">
                      <span className="uppercase font-semibold tracking-wide text-accent">{r.surface}</span>
                      <span>{r.kind.replaceAll("_", " ")}</span>
                      <span>{timeAgo(r.started_at ?? r.created_at)}</span>
                      {(r.files.written.length > 0 || r.artifacts.some((item) => item.relation === "output")) && (
                        <span>{t("runs.outputCount", { count: Math.max(r.files.written.length, r.artifacts.filter((item) => item.relation === "output").length) })}</span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => toggleLog(r.execution_id)}
                    className="rounded-input px-2 py-1 text-xs text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1">
                    {expanded[r.execution_id] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {t("runs.log")}
                  </button>
                </div>
                {expanded[r.execution_id] && (
                  <div className="border-t border-faint px-4 py-3">
                    <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed text-text whitespace-pre-wrap">
                      {logs[r.execution_id] || t("common.loading")}
                    </pre>
                    {!!r.files.written.length && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="text-[10px] text-muted mr-1">{t("runs.outputs")}:</span>
                        {r.files.written.map((o, i) => (
                          <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text">
                            {o.path}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        </div>
    </WorkspacePage>
  );
}
