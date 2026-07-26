import { BarChart3, Check, FlaskConical, Loader2, Pause, Play, RotateCcw, X } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ExperienceRecord, ResearchLoop } from "../../lib/project-memory";

export type ResearchStarter = "research_loop" | "optimize" | "compare" | "evaluate" | "reproduce";

const modes: Array<{ kind: ResearchStarter; label: string; prompt: string }> = [
  { kind: "research_loop", label: "Research loop", prompt: "Describe the research objective and how success should be measured." },
  { kind: "optimize", label: "Optimize", prompt: "Describe what to optimize and the target metric." },
  { kind: "compare", label: "Compare approaches", prompt: "Describe the approaches or design space to compare." },
  { kind: "evaluate", label: "Evaluate results", prompt: "Describe the existing result and the evaluation metric." },
  { kind: "reproduce", label: "Reproduce experiment", prompt: "Describe the experiment, inputs, and expected result." },
];

export function ResearchModePicker({ selected, disabled, onSelect }: { selected: ResearchStarter | null; disabled?: boolean; onSelect: (mode: ResearchStarter, prompt: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2" aria-label="Conversation mode">
      {modes.map((mode) => (
        <button
          key={mode.kind}
          type="button"
          disabled={disabled}
          aria-pressed={selected === mode.kind}
          onClick={() => onSelect(mode.kind, mode.prompt)}
          className={cn(
            "flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-50",
            selected === mode.kind ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted hover:text-text",
          )}
        >
          <FlaskConical size={13} /> {mode.label}
        </button>
      ))}
    </div>
  );
}

export interface ResearchLoopDraft {
  title: string;
  objective: string;
  metric: string;
  direction: "maximize" | "minimize";
  maxCandidates: number;
  maxWallSeconds: number;
}

export function ResearchLoopDraftCard({ draft, busy, onChange, onCancel, onConfirm }: {
  draft: ResearchLoopDraft;
  busy: boolean;
  onChange: (draft: ResearchLoopDraft) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <section className="rounded-card border border-accent/30 bg-accent/5 p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text"><FlaskConical size={15} className="text-accent" /> Confirm research loop</h3>
          <p className="mt-1 text-xs leading-5 text-muted">Creating the draft is safe. Confirming will preflight and start trusted local execution.</p>
        </div>
        <button type="button" onClick={onCancel} disabled={busy} aria-label="Cancel research loop setup" className="text-muted hover:text-text"><X size={15} /></button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-muted sm:col-span-2">Title<input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} className="mt-1 min-h-9 w-full rounded-input border border-border bg-surface px-3 text-sm text-text" /></label>
        <label className="text-xs text-muted sm:col-span-2">Objective<textarea value={draft.objective} onChange={(event) => onChange({ ...draft, objective: event.target.value })} rows={3} className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text" /></label>
        <label className="text-xs text-muted">Metric<input value={draft.metric} onChange={(event) => onChange({ ...draft, metric: event.target.value })} className="mt-1 min-h-9 w-full rounded-input border border-border bg-surface px-3 text-sm text-text" /></label>
        <label className="text-xs text-muted">Direction<select value={draft.direction} onChange={(event) => onChange({ ...draft, direction: event.target.value as ResearchLoopDraft["direction"] })} className="mt-1 min-h-9 w-full rounded-input border border-border bg-surface px-3 text-sm text-text"><option value="maximize">Maximize</option><option value="minimize">Minimize</option></select></label>
        <label className="text-xs text-muted">Maximum candidates<input type="number" min={1} max={100} value={draft.maxCandidates} onChange={(event) => onChange({ ...draft, maxCandidates: Math.max(1, Number(event.target.value) || 1) })} className="mt-1 min-h-9 w-full rounded-input border border-border bg-surface px-3 text-sm text-text" /></label>
        <label className="text-xs text-muted">Maximum runtime (minutes)<input type="number" min={1} max={1440} value={Math.ceil(draft.maxWallSeconds / 60)} onChange={(event) => onChange({ ...draft, maxWallSeconds: Math.max(60, (Number(event.target.value) || 1) * 60) })} className="mt-1 min-h-9 w-full rounded-input border border-border bg-surface px-3 text-sm text-text" /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="min-h-9 rounded-input border border-border px-3 text-xs text-muted">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy || !draft.title.trim() || !draft.objective.trim() || !draft.metric.trim()} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Create and start</button>
      </div>
    </section>
  );
}

export function ResearchLoopStatusCard({ loop, experiences, busy, onRefresh, onAction, onOpenDetails }: {
  loop: ResearchLoop;
  experiences: ExperienceRecord[];
  busy: boolean;
  onRefresh: () => void;
  onAction: (action: "pause" | "resume" | "cancel") => void;
  onOpenDetails: () => void;
}) {
  const current = experiences[0];
  const metrics = current?.evaluation?.metrics as Record<string, { value?: number }> | undefined;
  const latestMetric = metrics ? Object.entries(metrics)[0] : undefined;
  return (
    <section className="rounded-card border border-accent/30 bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><FlaskConical size={15} className="text-accent" /><h3 className="text-sm font-semibold text-text">{loop.title}</h3><span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">{loop.status}</span></div>
          <p className="mt-1 text-xs leading-5 text-muted">{loop.objective}</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={busy} aria-label="Refresh research loop" className="text-muted hover:text-text disabled:opacity-50"><RotateCcw size={14} className={busy ? "animate-spin" : ""} /></button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatusValue label="Candidates" value={`${experiences.length}/${loop.budget.max_candidates}`} />
        <StatusValue label="Current stage" value={current?.status ?? "Awaiting candidate"} />
        <StatusValue label={latestMetric?.[0] ?? "Latest metric"} value={latestMetric?.[1]?.value == null ? "—" : String(latestMetric[1].value)} />
        <StatusValue label="Mode" value={loop.mode} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {loop.status === "running" && <button type="button" disabled={busy} onClick={() => onAction("pause")} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 text-xs text-muted"><Pause size={12} /> Pause</button>}
        {loop.status === "paused" && <button type="button" disabled={busy} onClick={() => onAction("resume")} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 text-xs text-muted"><Play size={12} /> Resume</button>}
        {!['completed', 'failed', 'cancelled'].includes(loop.status) && <button type="button" disabled={busy} onClick={() => onAction("cancel")} className="flex min-h-8 items-center gap-1 rounded-input border border-error/30 px-2.5 text-xs text-error"><X size={12} /> Cancel</button>}
        <button type="button" onClick={onOpenDetails} className="flex min-h-8 items-center gap-1 rounded-input border border-border px-2.5 text-xs text-muted"><BarChart3 size={12} /> Detailed view</button>
      </div>
    </section>
  );
}

function StatusValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-input bg-surface-2 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-0.5 truncate text-xs font-medium text-text" title={value}>{value}</div></div>;
}
