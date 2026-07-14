import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { BookOpen, Play, Square, RefreshCw, ExternalLink } from "lucide-react";
import { cn } from "../../lib/cn";

interface Notebook {
  path: string; name: string; size: number; modified: string;
}

interface JupyterStatus {
  running: boolean; port: number; url: string | null; env_ready?: boolean;
}

export function NotebooksPage() {
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [jupyter, setJupyter] = useState<JupyterStatus>({ running: false, port: 8888, url: null, env_ready: false });
  const [starting, setStarting] = useState(false);

  const loadNotebooks = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/notebooks?cwd=${encodeURIComponent(workspaceCwd)}`);
      setNotebooks(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const loadJupyterStatus = async () => {
    try {
      const res = await fetch("/api/notebooks/jupyter/status");
      setJupyter(await res.json());
    } catch (e) { /* ignore */ }
  };

  useEffect(() => { loadNotebooks(); loadJupyterStatus(); }, [workspaceCwd]);

  const [setupProgress, setSetupProgress] = useState<string[]>([]);
  const [settingUp, setSettingUp] = useState(false);

  const setupJupyterEnv = async () => {
    setSettingUp(true);
    setSetupProgress([]);
    try {
      const eventSource = new EventSource("/api/notebooks/jupyter/setup");
      eventSource.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.status === "done") {
          setSetupProgress((p) => [...p, "✅ " + d.text]);
          eventSource.close();
          setSettingUp(false);
          loadJupyterStatus();
        } else if (d.status === "error") {
          setSetupProgress((p) => [...p, "❌ " + d.text]);
          eventSource.close();
          setSettingUp(false);
        } else {
          setSetupProgress((p) => [...p, d.text]);
        }
      };
      eventSource.onerror = () => {
        eventSource.close();
        setSettingUp(false);
      };
    } catch (e) { console.error(e); setSettingUp(false); }
  };

  const startJupyter = async () => {
    setStarting(true);
    try {
      const res = await fetch(`/api/notebooks/jupyter/start?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "POST" });
      if (res.ok) {
        setJupyter(await res.json());
      } else {
        const err = await res.json();
        alert(err.detail || "Failed to start Jupyter");
      }
    } catch (e) { console.error(e); }
    finally { setStarting(false); }
  };

  const stopJupyter = async () => {
    try {
      await fetch("/api/notebooks/jupyter/stop", { method: "POST" });
      setJupyter({ running: false, port: 8888, url: null });
    } catch (e) { console.error(e); }
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
            <h1 className="font-serif text-xl text-text">Notebooks</h1>
            <p className="mt-1 text-sm text-muted">{notebooks.length} notebook{notebooks.length !== 1 ? "s" : ""} in workspace</p>
          </div>
          <button onClick={loadNotebooks} className="rounded-input px-2 py-1 text-xs text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {/* Jupyter Server */}
        <div className={cn("rounded-card border p-4 mb-6", jupyter.running ? "border-ok/40 bg-ok/5" : "border-border bg-surface")}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-text">Jupyter Lab</h2>
              <p className="text-xs text-muted mt-0.5">
                {jupyter.running ? `Running on port ${jupyter.port}` :
                 jupyter.env_ready ? "Environment ready" : "Environment not set up"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {jupyter.running ? (
                <>
                  <a href={jupyter.url!} target="_blank" className="rounded-input px-3 py-1.5 text-xs text-link hover:bg-surface-2 flex items-center gap-1">
                    <ExternalLink size={12} /> Open
                  </a>
                  <button onClick={stopJupyter} className="rounded-input px-3 py-1.5 text-xs text-error hover:bg-error/10 flex items-center gap-1">
                    <Square size={12} /> Stop
                  </button>
                </>
              ) : jupyter.env_ready ? (
                <button onClick={startJupyter} disabled={starting}
                  className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40 flex items-center gap-1">
                  {starting ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />} Start
                </button>
              ) : (
                <button onClick={setupJupyterEnv} disabled={settingUp}
                  className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40 flex items-center gap-1">
                  {settingUp ? <RefreshCw size={12} className="animate-spin" /> : "⚡"} Setup Jupyter
                </button>
              )}
            </div>
          </div>
          {setupProgress.length > 0 && (
            <div className="mt-3 rounded-input bg-surface-2 p-3 max-h-32 overflow-y-auto">
              {setupProgress.map((line: string, i: number) => (
                <div key={i} className="font-mono text-[11px] text-muted">{line}</div>
              ))}
            </div>
          )}
        </div>

        {/* Notebook list */}
        {loading ? (
          <div className="text-sm text-muted py-8 text-center">Loading…</div>
        ) : notebooks.length === 0 ? (
          <div className="text-center py-16">
            <BookOpen size={40} className="mx-auto text-muted/30 mb-3" />
            <p className="text-sm text-muted">No notebooks found</p>
            <p className="text-xs text-muted mt-1">Create a .ipynb file or start Jupyter Lab to create one.</p>
          </div>
        ) : (
          <div className="rounded-card border border-border bg-surface overflow-hidden">
            {notebooks.map((nb) => (
              <div key={nb.path} className="flex items-center gap-3 px-4 py-2.5 border-b border-faint last:border-b-0 hover:bg-surface-2 text-sm">
                <BookOpen size={16} className="text-accent/60 shrink-0" />
                <span className="truncate text-text flex-1">{nb.path}</span>
                <span className="text-xs text-muted shrink-0">{timeAgo(nb.modified)}</span>
                <span className="text-xs text-muted shrink-0 w-16 text-right">{(nb.size / 1024).toFixed(1)} KB</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
