import { useEffect, useMemo, useState } from "react";
import type { AutoResearchSnapshot, ResearchNode } from "@pi-science/contracts";
import { useNavigate } from "react-router-dom";
import { FlaskConical, GitBranch, Loader2, Pause, Play, X } from "lucide-react";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { ResearchDecisionCard, ResearchResultCard } from "../../components/conversation/ResearchLoopControls";
import { researchGraphApi, subscribeResearchGraphEvents, useResearchGraph, useResearchGraphs } from "../../lib/research";
import { cn } from "../../lib/ui";
import { useTranslation } from "react-i18next";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";

const terminal = new Set(["completed", "failed", "cancelled"]);

export function ResearchPage() {
  const { t } = useTranslation();
  const cwd = useRequiredWorkspaceCwd();
  const navigate = useNavigate();
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRead = useResearchGraphs(cwd);
  const graphs = listRead.data?.research ?? [];
  const selected = pick && graphs.some((graph) => graph.research_id === pick) ? pick : graphs[0]?.research_id ?? null;
  const detailRead = useResearchGraph(cwd, selected);
  const detail = detailRead.data ?? null;

  useEffect(() => {
    const loadError = listRead.error ?? detailRead.error;
    setError(loadError ? (loadError instanceof Error ? loadError.message : t("research.loadError")) : null);
  }, [detailRead.error, listRead.error, t]);

  useEffect(() => {
    if (!detail || terminal.has(detail.status)) return;
    const unsubscribe = subscribeResearchGraphEvents(cwd);
    const fallback = window.setInterval(() => { void listRead.refetch(); void detailRead.refetch(); }, 30_000);
    return () => { unsubscribe(); window.clearInterval(fallback); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query result wrappers change every render
  }, [cwd, detail?.research_id, detail?.status]);

  const act = async (action: "pause" | "resume" | "cancel") => {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try { await researchGraphApi.action(cwd, selected, action); await Promise.all([listRead.refetch(), detailRead.refetch()]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("research.actionError")); }
    finally { setBusy(false); }
  };
  const resolve = async (nodeId: string, resolution: string) => {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try { await researchGraphApi.resolveInput(cwd, selected, nodeId, resolution); await Promise.all([listRead.refetch(), detailRead.refetch()]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("research.actionError")); }
    finally { setBusy(false); }
  };

  return <WorkspacePage>
    <WorkspacePageHeader title={t("nav.research")} description="Durable research graphs coordinated by a Pi supervisor and bounded workers." actions={<><button type="button" onClick={() => navigate(`/workspace/${encodeURIComponent(cwd)}`)} className="min-h-9 rounded-input bg-accent-fill px-3 text-xs text-accent-fg">{t("research.startFromConversation")}</button><WorkspacePageRefreshButton label={t("common.refresh")} loading={listRead.isFetching} onClick={() => void listRead.refetch()} /></>} />
    {error && <div className="mt-4 rounded-input border border-error/30 bg-error/5 px-3 py-2 text-sm text-error-text">{error}</div>}
    <div className="mt-6 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="space-y-2">{listRead.isFetching && !graphs.length ? <div className="py-8 text-center text-sm text-muted"><Loader2 className="mx-auto mb-2 animate-spin" />{t("common.loading")}</div> : !graphs.length ? <div className="ui-card-flat rounded-card border-dashed p-6 text-center text-sm text-muted"><FlaskConical className="mx-auto mb-2" />{t("research.empty")}</div> : graphs.map((graph) => <button key={graph.research_id} onClick={() => setPick(graph.research_id)} className={cn("w-full rounded-input border p-3 text-left", selected === graph.research_id ? "border-accent bg-accent/5" : "border-border bg-surface")}><div className="text-sm font-medium text-text">{graph.title}</div><div className="mt-1 text-xs text-muted">{graph.status} · rev {graph.revision} · {graph.nodes.length} nodes</div></button>)}</aside>
      <main>{detail && <ResearchGraphDetail graph={detail} cwd={cwd} busy={busy} onAction={(action) => void act(action)} onResolve={(nodeId, resolution) => void resolve(nodeId, resolution)} />}</main>
    </div>
  </WorkspacePage>;
}

function ResearchGraphDetail({ graph, cwd, busy, onAction, onResolve }: { graph: AutoResearchSnapshot; cwd: string; busy: boolean; onAction: (action: "pause" | "resume" | "cancel") => void; onResolve: (nodeId: string, resolution: string) => void }) {
  const grouped = useMemo(() => {
    const result = new Map<ResearchNode["kind"], ResearchNode[]>();
    graph.nodes.forEach((node) => result.set(node.kind, [...(result.get(node.kind) ?? []), node]));
    return result;
  }, [graph.nodes]);
  const decision = graph.nodes.find((node): node is Extract<ResearchNode, { kind: "decision" }> => node.kind === "decision" && node.status === "ready" && !node.resolution);
  return <div className="space-y-4">
    <section className="ui-card-flat rounded-card p-5"><div className="flex flex-wrap justify-between gap-3"><div><div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-accent"><GitBranch size={12} /> Research graph</div><h2 className="text-base font-semibold text-text">{graph.title}</h2><p className="mt-1 text-sm leading-6 text-muted">{graph.objective}</p></div><span className="font-mono text-xs text-muted">{graph.status} · rev {graph.revision}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="Experiments" value={`${graph.usage.experiments_started}/${graph.budget.max_experiments}`} /><Metric label="Completed" value={String(graph.usage.experiments_completed)} /><Metric label="Model tokens" value={String(graph.usage.model_tokens)} /><Metric label="Claims / evidence" value={`${graph.claims.length} / ${graph.evidence.length}`} /></div>
      {graph.current_activity && <p className="mt-3 text-xs text-muted">Current activity: {graph.current_activity}</p>}
      <div className="mt-4 flex flex-wrap gap-2">{graph.status === "running" && <ResearchAction onClick={() => onAction("pause")} disabled={busy}><Pause size={12} /> Pause</ResearchAction>}{graph.status === "paused" && <ResearchAction onClick={() => onAction("resume")} disabled={busy}><Play size={12} /> Resume</ResearchAction>}{!terminal.has(graph.status) && <ResearchAction onClick={() => onAction("cancel")} disabled={busy} danger><X size={12} /> Cancel</ResearchAction>}</div>
      {decision && <ResearchDecisionCard node={decision} busy={busy} onResolve={(resolution) => onResolve(decision.node_id, resolution)} />}
      {terminal.has(graph.status) && <ResearchResultCard research={graph} cwd={cwd} />}
    </section>
    <section className="ui-card-flat rounded-card p-5"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Research graph</h3><span className="text-[10px] text-muted">{graph.nodes.length} nodes · {graph.edges.length} edges</span></div>
      <div className="mt-3 space-y-5">{Array.from(grouped.entries()).map(([kind, nodes]) => <div key={kind}><div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-accent">{kind}</div><div className="grid gap-2 xl:grid-cols-2">{nodes.map((node) => <NodeCard key={node.node_id} node={node} incoming={graph.edges.filter((edge) => edge.to === node.node_id).map((edge) => edge.relation)} />)}</div></div>)}</div>
    </section>
    {graph.claims.length > 0 && <section className="ui-card-flat rounded-card p-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Claims</h3><div className="mt-3 space-y-2">{graph.claims.map((claim) => <div key={claim.claim_id} className="rounded-input border border-faint p-3"><div className="flex justify-between gap-3 text-xs"><span className="text-text">{claim.statement}</span><span className="shrink-0 font-mono text-muted">{Math.round(claim.confidence * 100)}%</span></div><div className="mt-1 text-[10px] text-muted">{claim.status}{claim.scope ? ` · ${claim.scope}` : ""}</div></div>)}</div></section>}
  </div>;
}

function NodeCard({ node, incoming }: { node: ResearchNode; incoming: string[] }) {
  const body = node.kind === "question" ? node.question : node.kind === "hypothesis" ? node.statement : node.kind === "literature" ? node.question : node.kind === "experiment" ? node.spec.objective : node.kind === "analysis" ? `${node.target_node_ids.length} target(s)` : node.kind === "verification" ? `Verify ${node.target_node_id}` : node.kind === "decision" ? node.reason : node.summary || "Synthesis pending";
  return <div className="rounded-input border border-border bg-surface p-3"><div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-muted">{node.node_id.slice(-8)}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px]", ["succeeded", "verified"].includes(node.status) ? "bg-ok/10 text-ok-text" : node.status === "failed" ? "bg-error/10 text-error-text" : "bg-surface-2 text-muted")}>{node.status}</span></div><p className="mt-2 line-clamp-3 text-xs leading-5 text-text">{body}</p>{incoming.length > 0 && <div className="mt-2 text-[10px] text-muted">← {incoming.join(", ")}</div>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-input bg-surface-2 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-0.5 text-xs font-medium text-text">{value}</div></div>; }
function ResearchAction({ danger = false, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) { return <button type="button" {...props} className={cn("flex min-h-9 items-center gap-1.5 rounded-input border px-3 text-xs disabled:opacity-50", danger ? "border-error/30 text-error-text" : "border-border text-muted hover:text-text")}>{children}</button>; }
