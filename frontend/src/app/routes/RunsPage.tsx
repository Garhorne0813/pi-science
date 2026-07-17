import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Play, Check, X, Loader2, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";

interface Run {
  runId: string;
  command: string;
  surface: string;
  host: string;
  status: string;
  startedAt: string;
  outputs: { path: string; size?: number }[];
  log?: string;
}

export function RunsPage() {
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<Record<string, string>>({});

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/runs?cwd=${encodeURIComponent(workspaceCwd)}`);
      setRuns(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [workspaceCwd]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const toggleLog = async (runId: string) => {
    if (expanded[runId]) {
      setExpanded((p) => ({ ...p, [runId]: false }));
      return;
    }
    setExpanded((p) => ({ ...p, [runId]: true }));
    if (!logs[runId]) {
      try {
        const res = await fetch(`/api/runs/${runId}/log?cwd=${encodeURIComponent(workspaceCwd)}`);
        const data = await res.json();
        setLogs((p) => ({ ...p, [runId]: data.log || "(no log)" }));
      } catch { setLogs((p) => ({ ...p, [runId]: "(error loading log)" })); }
    }
  };

  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[900px] px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-serif text-xl text-text">Runs</h1>
            <p className="mt-1 text-sm text-muted">{runs.length} experiment run{runs.length !== 1 ? "s" : ""}</p>
          </div>
          <button onClick={() => void loadRuns()} className="rounded-input px-2 py-1 text-xs text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-muted py-8 text-center"><Loader2 size={18} className="animate-spin mx-auto mb-2" /> Loading…</div>
        ) : runs.length === 0 ? (
          <div className="text-center py-16">
            <Play size={40} className="mx-auto text-muted/30 mb-3" />
            <p className="text-sm text-muted">No runs yet</p>
            <p className="text-xs text-muted mt-1">Runs are recorded automatically when the agent executes commands.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {runs.map((r) => (
              <div key={r.runId} className="rounded-card border border-border bg-surface overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className={cn("shrink-0", r.status === "ok" ? "text-ok" : r.status === "running" ? "text-warn" : "text-error")}>
                    {r.status === "ok" ? <Check size={16} /> : r.status === "running" ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] text-text truncate">{r.command}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted">
                      <span className="uppercase font-semibold tracking-wide text-accent">{r.surface}</span>
                      {r.host && <span>{r.host}</span>}
                      <span>{timeAgo(r.startedAt)}</span>
                      {r.outputs.length > 0 && <span>{r.outputs.length} output{r.outputs.length !== 1 ? "s" : ""}</span>}
                    </div>
                  </div>
                  <button onClick={() => toggleLog(r.runId)}
                    className="rounded-input px-2 py-1 text-xs text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1">
                    {expanded[r.runId] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Log
                  </button>
                </div>
                {expanded[r.runId] && (
                  <div className="border-t border-faint px-4 py-3">
                    <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed text-text whitespace-pre-wrap">
                      {logs[r.runId] || "Loading…"}
                    </pre>
                    {r.outputs.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="text-[10px] text-muted mr-1">Outputs:</span>
                        {r.outputs.map((o, i) => (
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
    </div>
  );
}
