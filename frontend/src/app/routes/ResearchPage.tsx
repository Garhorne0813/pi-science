import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FlaskConical, Loader2, Pause, Play, X } from "lucide-react";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { projectMemoryApi, useResearchLoopDetail, useResearchLoops } from "../../lib/knowledge";
import { subscribeResearchInvalidation } from "../../lib/research";
import { cn } from "../../lib/ui";
import { useTranslation } from "react-i18next";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";

export function ResearchPage() {
  const { t } = useTranslation();
  const cwd = useRequiredWorkspaceCwd(); const navigate = useNavigate();
  const [pick, setPick] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const loopsResult = useResearchLoops(cwd); const loops = loopsResult.data?.loops ?? []; const loading = loopsResult.isFetching;
  // The selection follows the list: an explicit pick wins while it still exists, otherwise the first loop.
  const selected = pick && loops.some((loop) => loop.loop_id === pick) ? pick : loops[0]?.loop_id ?? null;
  const detailResult = useResearchLoopDetail(cwd, selected); const detail = selected ? detailResult.data ?? null : null;
  const loadError = loopsResult.error ?? detailResult.error;
  useEffect(() => { setError(loadError ? (loadError instanceof Error ? loadError.message : t("research.loadError")) : null); }, [loadError, t]);
  // SSE invalidation channel instead of fast polling: the server signal marks the
  // project-memory queries stale and the mounted queries refetch themselves. A slow
  // fallback poll covers environments where SSE dies silently. Keyed on loop_id +
  // terminal flag so refetches do not churn the EventSource connection.
  const detailId = detail?.loop_id ?? null; const detailTerminal = !detail || ["completed", "failed", "cancelled"].includes(detail.status);
  useEffect(() => {
    if (!detailId || detailTerminal) return;
    const unsubscribe = subscribeResearchInvalidation(cwd);
    const fallback = window.setInterval(() => { void loopsResult.refetch(); void detailResult.refetch(); }, 30_000);
    return () => { unsubscribe(); window.clearInterval(fallback); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query results are new objects each render
  }, [detailId, detailTerminal, cwd]);
  const action = async (name: "pause" | "resume" | "cancel") => { if (!selected || busy) return; setBusy(true); try { await projectMemoryApi.action(cwd, selected, name); await Promise.all([loopsResult.refetch(), detailResult.refetch()]); } catch (cause) { setError(cause instanceof Error ? cause.message : t("research.actionError")); } finally { setBusy(false); } };
  return <WorkspacePage><WorkspacePageHeader title={t("nav.research")} description={t("research.pageDescription")} actions={<><button type="button" onClick={() => navigate(`/workspace/${encodeURIComponent(cwd)}`)} className="min-h-9 rounded-input bg-accent px-3 text-xs text-accent-fg">{t("research.startFromConversation")}</button><WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => void loopsResult.refetch()} /></>} />
    {error && <div className="mt-4 rounded-input border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">{error}</div>}
    <div className="mt-6 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]"><aside className="space-y-2">{loading && !loops.length ? <div className="py-8 text-center text-sm text-muted"><Loader2 className="mx-auto mb-2 animate-spin" />{t("common.loading")}</div> : !loops.length ? <div className="ui-card-flat rounded-card border-dashed p-6 text-center text-sm text-muted"><FlaskConical className="mx-auto mb-2" />{t("research.empty")}</div> : loops.map((loop) => <button key={loop.loop_id} onClick={() => setPick(loop.loop_id)} className={cn("w-full rounded-input border p-3 text-left", selected === loop.loop_id ? "border-accent bg-accent/5" : "border-border bg-surface")}><div className="text-sm font-medium text-text">{loop.title}</div><div className="mt-1 text-xs text-muted">{t(`research.mode.${loop.task_type ?? "research_loop"}.label`)} · {t(`research.status.${loop.status}`, { defaultValue: loop.status })} · {t("research.revision", { revision: loop.revision })}</div></button>)}</aside>
      <main>{detail && <div className="ui-card-flat rounded-card p-5"><div className="flex flex-wrap justify-between gap-3"><div><div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-accent">{t(`research.mode.${detail.task_type ?? "research_loop"}.label`)}</div><h2 className="text-base font-semibold text-text">{detail.title}</h2><p className="mt-1 text-sm text-muted">{detail.objective}</p></div><span className="font-mono text-xs text-muted">{t(`research.status.${detail.status}`, { defaultValue: detail.status })}</span></div><div className="mt-4 flex flex-wrap gap-2">{detail.status === "running" && <ResearchAction onClick={() => void action("pause")} disabled={busy}><Pause size={12} /> {t("research.pauseAfterRun")}</ResearchAction>}{["paused", "needs_attention"].includes(detail.status) && <ResearchAction onClick={() => void action("resume")} disabled={busy}><Play size={12} /> {t("research.resume")}</ResearchAction>}{!["completed", "failed", "cancelled"].includes(detail.status) && <ResearchAction onClick={() => void action("cancel")} disabled={busy} danger><X size={12} /> {t("common.cancel")}</ResearchAction>}</div><h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted">{t("research.candidates")}</h3><div className="mt-2 space-y-2">{detail.candidates.map((candidate) => <div key={candidate.candidate_id} className="rounded-input bg-surface-2 p-3"><div className="flex justify-between gap-2"><span className="text-xs font-medium text-text">{candidate.proposal.approach_summary}</span><span className="font-mono text-[10px] text-muted">{t(`research.status.${candidate.status}`, { defaultValue: candidate.status })}</span></div>{candidate.evaluation?.metrics && <pre className="mt-2 overflow-auto text-[11px] text-muted">{JSON.stringify(candidate.evaluation.metrics, null, 2)}</pre>}</div>)}</div><h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted">{t("research.operations")}</h3><div className="mt-2 space-y-1">{detail.operations.slice().reverse().map((operation) => <div key={operation.operation_id} className="flex justify-between rounded-input border border-faint px-3 py-2 text-xs"><span>{operation.phase}</span><span className={operation.status === "failed" ? "text-error" : "text-muted"}>{t(`research.status.${operation.status}`, { defaultValue: operation.status })}</span></div>)}</div></div>}</main></div>
  </WorkspacePage>;
}

function ResearchAction({ danger = false, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return <button type="button" {...props} className={cn("flex min-h-9 items-center gap-1.5 rounded-input border px-3 text-xs disabled:opacity-50", danger ? "border-error/30 text-error" : "border-border text-muted hover:text-text")}>{children}</button>;
}
