import { useState } from "react";
import type { AutoResearchSnapshot, ResearchNode } from "@pi-science/contracts";
import { BarChart3, Check, FileText, FlaskConical, GitBranch, Loader2, Pause, Play, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { fileInspectorForPath } from "../../lib/artifacts";

export type ResearchStarter = "research_loop" | "optimize" | "compare" | "evaluate" | "reproduce";
const modes: ResearchStarter[] = ["research_loop", "optimize", "compare", "evaluate", "reproduce"];

export function ResearchModePicker({ selected, disabled, onSelect, className }: { selected: ResearchStarter | null; disabled?: boolean; onSelect: (mode: ResearchStarter, prompt: string) => void; className?: string }) {
  const { t } = useTranslation();
  return <div className={cn("flex flex-wrap gap-2 px-1 pb-1", className)} aria-label={t("research.conversationMode")}>{modes.map((mode) => <button key={mode} type="button" disabled={disabled} aria-pressed={selected === mode} onClick={() => onSelect(mode, t(`research.mode.${mode}.prompt`))} className={cn("flex h-7 min-h-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors disabled:opacity-50", selected === mode ? "border-accent bg-accent-fill text-accent-fg" : "border-border bg-surface text-muted hover:text-text")}><FlaskConical size={13} /> {t(`research.mode.${mode}.label`)}</button>)}</div>;
}

export interface ResearchLoopDraft {
  taskType: ResearchStarter;
  title: string;
  objective: string;
  constraints: string[];
  maxExperiments: number;
  maxWallSeconds: number;
  maxParallel: number;
}

/** Setup card shown before the durable graph is created. */
export function ResearchLoopDraftCard({ draft, busy, onCancel, onConfirm }: { draft: ResearchLoopDraft; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return <section className="ui-card-accent rounded-card p-4">
    <div className="flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-text"><GitBranch size={15} className="text-accent" /> Auto Research setup</h3><p className="mt-1 text-xs leading-5 text-muted">A supervisor will grow a durable research graph and schedule bounded workers.</p></div><button type="button" onClick={onCancel} disabled={busy} aria-label={t("research.cancelSetup")} className="min-h-9 min-w-9 text-muted hover:text-text"><X size={15} /></button></div>
    <div className="mt-4 rounded-input border border-border/70 bg-surface px-4 py-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("research.objective")}</div><p className="mt-1 text-sm leading-6 text-text">{draft.objective}</p></div>
    <div className="mt-3 grid gap-3 sm:grid-cols-3"><Status label="Experiment budget" value={String(draft.maxExperiments)} /><Status label="Time budget" value={`${Math.ceil(draft.maxWallSeconds / 60)} min`} /><Status label="Parallel workers" value={String(draft.maxParallel)} /></div>
    {draft.constraints.length > 0 && <div className="mt-3 text-xs leading-5 text-muted">Constraints: {draft.constraints.join(" · ")}</div>}
    <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onCancel} disabled={busy} className="min-h-9 rounded-input border border-border px-3 text-xs text-muted">{t("common.cancel")}</button><button type="button" onClick={onConfirm} disabled={busy} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent-fill px-3 text-xs font-medium text-accent-fg disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t("research.createStart")}</button></div>
  </section>;
}

/** User-input node card. Resolving it resumes the supervisor from durable state. */
export function ResearchDecisionCard({ node, busy, onResolve }: { node: Extract<ResearchNode, { kind: "decision" }>; busy: boolean; onResolve: (resolution: string) => void }) {
  const [resolution, setResolution] = useState("");
  return <div className="mt-3 rounded-input border border-warn/30 bg-warn/5 p-3">
    <div className="text-xs font-semibold text-text">Decision required</div><p className="mt-1 text-xs leading-5 text-muted">{node.reason}</p>
    {node.options.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{node.options.map((option) => <button key={option} type="button" onClick={() => setResolution(option)} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:text-text">{option}</button>)}</div>}
    <div className="mt-2 flex gap-2"><input value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="Your decision…" className="min-h-9 min-w-0 flex-1 rounded-input border border-border bg-surface px-3 text-xs text-text" /><button type="button" disabled={busy || !resolution.trim()} onClick={() => onResolve(resolution)} className="rounded-input bg-accent-fill px-3 text-xs text-accent-fg disabled:opacity-50">Continue</button></div>
  </div>;
}

export function ResearchResultCard({ research, cwd }: { research: AutoResearchSnapshot; cwd: string }) {
  const { t } = useTranslation();
  const openInspector = useUiStore((state) => state.openInspector);
  const synthesis = research.nodes.findLast((node) => node.kind === "synthesis" && node.status === "succeeded");
  const summary = synthesis?.kind === "synthesis" ? synthesis.summary : research.stop_reason;
  const reportPath = research.report_path;
  return <div className="mt-3 rounded-input border border-ok/30 bg-ok/5 p-3"><div className="flex items-center justify-between gap-2"><div className="text-xs font-semibold text-text">Research result</div>{reportPath && <button type="button" onClick={() => openInspector(fileInspectorForPath(reportPath, reportPath.split("/").pop(), undefined, cwd))} className="flex min-h-8 items-center gap-1.5 rounded-input border border-ok/30 bg-surface px-2.5 text-xs text-ok-text hover:bg-ok/10"><FileText size={13} /> {t("research.openReport")}</button>}</div>{summary && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted">{summary}</p>}{research.best_result && <pre className="mt-2 max-h-36 overflow-auto text-[11px] text-muted">{JSON.stringify(research.best_result, null, 2)}</pre>}<div className="mt-2 text-[10px] text-muted">{research.claims.length} claims · {research.evidence.length} evidence records</div></div>;
}

export function ResearchLoopStatusCard({ loop, cwd, busy, onRefresh, onAction, onResolveInput, onOpenDetails }: { loop: AutoResearchSnapshot; cwd: string; busy: boolean; onRefresh: () => void; onAction: (action: "pause" | "resume" | "cancel") => void; onResolveInput?: (nodeId: string, resolution: string) => void; onOpenDetails: () => void }) {
  const { t } = useTranslation();
  const running = loop.nodes.filter((node) => node.status === "running");
  const resolved = loop.nodes.filter((node) => ["succeeded", "verified"].includes(node.status));
  const decision = loop.nodes.find((node): node is Extract<ResearchNode, { kind: "decision" }> => node.kind === "decision" && node.status === "ready" && !node.resolution);
  return <section className="ui-card-flat rounded-card border-accent/30 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><GitBranch size={15} className="text-accent" /><h3 className="text-sm font-semibold text-text">{loop.title}</h3><span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">{loop.status}</span></div><p className="mt-1 text-xs leading-5 text-muted">{loop.objective}</p></div><button type="button" onClick={onRefresh} disabled={busy} aria-label={t("research.refresh")} className="min-h-9 min-w-9 text-muted hover:text-text"><RotateCcw size={14} className={busy ? "animate-spin" : ""} /></button></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Status label="Graph nodes" value={String(loop.nodes.length)} /><Status label="Resolved" value={String(resolved.length)} /><Status label="Experiments" value={`${loop.usage.experiments_started}/${loop.budget.max_experiments}`} /><Status label="Active" value={running.length ? running.map((node) => node.kind).join(", ") : loop.current_activity ?? "—"} /></div>
    {decision && onResolveInput && <ResearchDecisionCard node={decision} busy={busy} onResolve={(resolution) => onResolveInput(decision.node_id, resolution)} />}
    {["completed", "failed"].includes(loop.status) && <ResearchResultCard research={loop} cwd={cwd} />}
    <div className="mt-3 flex flex-wrap gap-2">{loop.status === "running" && <Action onClick={() => onAction("pause")} disabled={busy}><Pause size={12} /> Pause</Action>}{["paused", "input_required"].includes(loop.status) && <Action onClick={() => onAction("resume")} disabled={busy || loop.status === "input_required"}><Play size={12} /> Resume</Action>}{!["completed", "failed", "cancelled"].includes(loop.status) && <button type="button" disabled={busy} onClick={() => onAction("cancel")} className="flex min-h-9 items-center gap-1 rounded-input border border-error/30 px-2.5 text-xs text-error-text"><X size={12} /> {t("common.cancel")}</button>}<Action onClick={onOpenDetails}><BarChart3 size={12} /> {t("research.details")}</Action></div>
  </section>;
}

function Status({ label, value }: { label: string; value: string }) { return <div className="rounded-input bg-surface-2 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-0.5 truncate text-xs font-medium text-text" title={value}>{value}</div></div>; }
function Action({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" {...props} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 text-xs text-muted disabled:opacity-50">{children}</button>; }
