import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BarChart3, FlaskConical, Loader2, Pause, Play, X } from "lucide-react";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { projectMemoryApi, type ExperienceRecord, type ResearchLoop } from "../../lib/project-memory";
import { cn } from "../../lib/cn";

export function ResearchPage() {
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const cwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const navigate = useNavigate();
  const [loops, setLoops] = useState<ResearchLoop[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [experiences, setExperiences] = useState<ExperienceRecord[]>([]);
  const [frontier, setFrontier] = useState<ExperienceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await projectMemoryApi.loops(cwd);
      setLoops(data.loops);
      setSelected((current) => current && data.loops.some((loop) => loop.loop_id === current) ? current : data.loops[0]?.loop_id ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load research loops"); }
    finally { setLoading(false); }
  }, [cwd]);

  const loadDetail = useCallback(async (loopId: string) => {
    try {
      const detail = await projectMemoryApi.loop(cwd, loopId);
      setLoops((current) => current.map((loop) => loop.loop_id === loopId ? detail : loop));
      setExperiences(detail.experiences ?? []);
      setFrontier(detail.frontier ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load research details"); }
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selected) void loadDetail(selected); else { setExperiences([]); setFrontier([]); } }, [selected, loadDetail]);
  useEffect(() => {
    const active = loops.find((loop) => loop.loop_id === selected && ["running", "paused"].includes(loop.status));
    if (!active) return;
    const timer = window.setInterval(() => { void loadDetail(active.loop_id); }, 2000);
    return () => window.clearInterval(timer);
  }, [loops, selected, loadDetail]);

  const action = async (name: "pause" | "resume" | "cancel") => {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try { await projectMemoryApi.action(cwd, selected, name); await Promise.all([load(), loadDetail(selected)]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update research loop"); }
    finally { setBusy(false); }
  };

  const current = loops.find((loop) => loop.loop_id === selected);
  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title="Research"
        description="Observe and control durable research loops, candidates, evaluations, and the Pareto frontier."
        actions={<><button type="button" onClick={() => navigate(`/workspace/${encodeURIComponent(cwd)}`)} className="min-h-9 rounded-input bg-accent px-3 text-xs font-medium text-accent-fg">Start from conversation</button><WorkspacePageRefreshButton label="Refresh" loading={loading} onClick={() => void load()} /></>}
      />
      {error && <div className="mt-4 rounded-input border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">{error}</div>}
      <div className="mt-6 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-2">
          {loading && loops.length === 0 ? <div className="py-8 text-center text-sm text-muted"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />Loading…</div> : loops.length === 0 ? <div className="rounded-card border border-border bg-surface p-6 text-center"><FlaskConical size={28} className="mx-auto text-muted/40" /><p className="mt-2 text-sm text-muted">No research loops yet.</p></div> : loops.map((loop) => (
            <button key={loop.loop_id} type="button" onClick={() => setSelected(loop.loop_id)} className={cn("w-full rounded-card border p-3 text-left", selected === loop.loop_id ? "border-accent bg-accent/5" : "border-border bg-surface hover:bg-surface-2")}>
              <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-text">{loop.title}</span><span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-muted">{loop.status}</span></div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{loop.objective}</p>
            </button>
          ))}
        </aside>
        <main className="min-w-0">
          {!current ? <div className="rounded-card border border-border bg-surface p-8 text-center text-sm text-muted">Select a research loop.</div> : (
            <div className="space-y-4">
              <section className="rounded-card border border-border bg-surface p-5 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-serif text-xl text-text">{current.title}</h2><p className="mt-1 text-sm leading-6 text-muted">{current.objective}</p></div><div className="flex gap-2">{current.status === "running" && <Action label="Pause" icon={<Pause size={13} />} disabled={busy} onClick={() => void action("pause")} />}{current.status === "paused" && <Action label="Resume" icon={<Play size={13} />} disabled={busy} onClick={() => void action("resume")} />}{!["completed", "failed", "cancelled"].includes(current.status) && <Action label="Cancel" icon={<X size={13} />} disabled={busy} danger onClick={() => void action("cancel")} />}</div></div>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><Value label="Status" value={current.status} /><Value label="Candidates" value={`${experiences.length}/${current.budget.max_candidates}`} /><Value label="Mode" value={current.mode} /><Value label="Evaluator" value={current.evaluator_ref?.evaluator_id ?? "—"} /></div>
              </section>
              <section className="rounded-card border border-border bg-surface p-5 shadow-card"><h3 className="text-sm font-semibold text-text">Candidates</h3>{experiences.length === 0 ? <p className="mt-3 text-sm text-muted">No candidates have been proposed yet.</p> : <div className="mt-3 space-y-2">{experiences.map((experience) => <div key={experience.experience_id} className="rounded-input bg-surface-2 p-3"><div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-muted">{experience.candidate_id}</span><span className="text-[10px] uppercase text-muted">{experience.status}</span></div><p className="mt-1 text-sm text-text">{experience.approach_summary}</p><pre className="mt-2 overflow-auto text-[10px] text-muted">{JSON.stringify(experience.evaluation?.metrics ?? {}, null, 2)}</pre></div>)}</div>}</section>
              <section className="rounded-card border border-border bg-surface p-5 shadow-card"><h3 className="flex items-center gap-2 text-sm font-semibold text-text"><BarChart3 size={14} className="text-accent" />Pareto frontier</h3>{frontier.length === 0 ? <p className="mt-3 text-sm text-muted">No fully evaluated candidate is on the frontier yet.</p> : <div className="mt-3 grid gap-2 sm:grid-cols-2">{frontier.map((item) => <div key={item.experience_id} className="rounded-input border border-accent/20 bg-accent/5 p-3"><div className="font-mono text-[10px] text-muted">{item.candidate_id}</div><p className="mt-1 text-sm text-text">{item.approach_summary}</p></div>)}</div>}</section>
            </div>
          )}
        </main>
      </div>
    </WorkspacePage>
  );
}

function Action({ label, icon, disabled, danger, onClick }: { label: string; icon: React.ReactNode; disabled: boolean; danger?: boolean; onClick: () => void }) { return <button type="button" disabled={disabled} onClick={onClick} className={cn("flex min-h-9 items-center gap-1.5 rounded-input border px-3 text-xs disabled:opacity-50", danger ? "border-error/30 text-error" : "border-border text-muted")}>{icon}{label}</button>; }
function Value({ label, value }: { label: string; value: string }) { return <div className="rounded-input bg-surface-2 p-3"><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-1 truncate text-xs font-medium text-text">{value}</div></div>; }
