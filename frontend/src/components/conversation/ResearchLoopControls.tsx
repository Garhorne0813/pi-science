import { BarChart3, Check, FlaskConical, Loader2, Pause, Play, RotateCcw, X } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ExperienceRecord, ResearchLoop, ResearchTaskType } from "../../lib/project-memory";
import { useTranslation } from "react-i18next";

export type ResearchStarter = ResearchTaskType;

const modes: ResearchStarter[] = ["research_loop", "optimize", "compare", "evaluate", "reproduce"];

export function ResearchModePicker({ selected, disabled, onSelect, className }: { selected: ResearchStarter | null; disabled?: boolean; onSelect: (mode: ResearchStarter, prompt: string) => void; className?: string }) {
  const { t } = useTranslation();
  return <div className={cn("flex flex-wrap gap-2 px-1 pb-2", className)} aria-label={t("research.conversationMode")}>{modes.map((mode) => <button key={mode} type="button" disabled={disabled} aria-pressed={selected === mode} onClick={() => onSelect(mode, t(`research.mode.${mode}.prompt`))} className={cn("flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-50", selected === mode ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted hover:text-text")}><FlaskConical size={13} /> {t(`research.mode.${mode}.label`)}</button>)}</div>;
}

export interface ResearchLoopDraft { taskType: Extract<ResearchTaskType, "research_loop" | "optimize">; title: string; objective: string; successCriterion: string; planSteps: string[]; metric: string; direction: "maximize" | "minimize"; maxCandidates: number; maxWallSeconds: number }

export function ResearchLoopDraftCard({ draft, busy, onCancel, onConfirm }: { draft: ResearchLoopDraft; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return <section className="rounded-card border border-accent/30 bg-accent/5 p-4 shadow-card">
    <div className="flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-text"><FlaskConical size={15} className="text-accent" /> {t("research.confirmTitle", { mode: t(`research.mode.${draft.taskType}.label`) })}</h3><p className="mt-1 text-xs leading-5 text-muted">{t("research.confirmDescription")}</p></div><button type="button" onClick={onCancel} disabled={busy} aria-label={t("research.cancelSetup")} className="min-h-9 min-w-9 text-muted hover:text-text"><X size={15} /></button></div>
    <div className="mt-4 rounded-input border border-border/70 bg-surface px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("research.objective")}</div>
      <p className="mt-1 text-sm leading-6 text-text">{draft.objective}</p>
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <div className="rounded-input bg-surface-2 px-4 py-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("research.autoSuccessCriterion")}</div><p className="mt-1 text-xs leading-5 text-text">{draft.successCriterion}</p></div>
      <div className="rounded-input bg-surface-2 px-4 py-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("research.autoLimits")}</div><p className="mt-1 text-xs leading-5 text-text">{t("research.autoLimitsValue", { rounds: draft.maxCandidates, minutes: Math.ceil(draft.maxWallSeconds / 60) })}</p></div>
    </div>
    <div className="mt-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("research.autoPlan")}</div>
      <ol className="mt-2 space-y-2">{draft.planSteps.map((step, index) => <li key={`${index}-${step}`} className="flex gap-2 text-xs leading-5 text-muted"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 font-mono text-[10px] text-accent">{index + 1}</span><span>{step}</span></li>)}</ol>
    </div>
    <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onCancel} disabled={busy} className="min-h-9 rounded-input border border-border px-3 text-xs text-muted">{t("common.cancel")}</button><button type="button" onClick={onConfirm} disabled={busy} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {t("research.createStart")}</button></div>
  </section>;
}

export function ResearchLoopStatusCard({ loop, candidates, busy, onRefresh, onAction, onOpenDetails }: { loop: ResearchLoop; candidates: ExperienceRecord[]; busy: boolean; onRefresh: () => void; onAction: (action: "pause" | "resume" | "cancel") => void; onOpenDetails: () => void }) {
  const { t } = useTranslation();
  const current = candidates.at(-1); const metrics = current?.evaluation?.metrics; const latestMetric = metrics ? Object.entries(metrics)[0] : undefined;
  return <section className="rounded-card border border-accent/30 bg-surface p-4 shadow-card">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><FlaskConical size={15} className="text-accent" /><h3 className="text-sm font-semibold text-text">{loop.title}</h3><span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">{t(`research.status.${loop.status}`, { defaultValue: loop.status })}</span></div><p className="mt-1 text-xs leading-5 text-muted">{loop.objective}</p></div><button type="button" onClick={onRefresh} disabled={busy} aria-label={t("research.refresh")} className="min-h-9 min-w-9 text-muted hover:text-text"><RotateCcw size={14} className={busy ? "animate-spin" : ""} /></button></div>
    {loop.status === "pausing" && <p className="mt-2 text-xs text-warn">{t("research.pausingHint")}</p>}
    {loop.status === "needs_attention" && <p className="mt-2 text-xs text-error">{t("research.needsAttention", { reason: loop.stop_reason })}</p>}
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Status label={t("research.candidates")} value={`${candidates.length}/${loop.budget.max_candidates}`} /><Status label={t("research.currentStage")} value={t(`research.status.${current?.status ?? "planning"}`, { defaultValue: current?.status ?? t("research.planning") })} /><Status label={latestMetric?.[0] ?? t("research.latestMetric")} value={latestMetric?.[1]?.value == null ? "—" : String(latestMetric[1].value)} /><Status label={t("research.modeLabel")} value={t(`research.mode.${loop.task_type ?? "research_loop"}.label`)} /></div>
    <div className="mt-3 flex flex-wrap gap-2">{loop.status === "running" && <Action onClick={() => onAction("pause")} disabled={busy}><Pause size={12} /> {t("research.pauseAfterRun")}</Action>}{["paused", "needs_attention"].includes(loop.status) && <Action onClick={() => onAction("resume")} disabled={busy}><Play size={12} /> {t("research.resume")}</Action>}{!["completed", "failed", "cancelled"].includes(loop.status) && <button type="button" disabled={busy} onClick={() => onAction("cancel")} className="flex min-h-9 items-center gap-1 rounded-input border border-error/30 px-2.5 text-xs text-error"><X size={12} /> {t("common.cancel")}</button>}<Action onClick={onOpenDetails}><BarChart3 size={12} /> {t("research.details")}</Action></div>
  </section>;
}

function Status({ label, value }: { label: string; value: string }) { return <div className="rounded-input bg-surface-2 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-0.5 truncate text-xs font-medium text-text" title={value}>{value}</div></div>; }
function Action({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" {...props} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 text-xs text-muted disabled:opacity-50">{children}</button>; }
