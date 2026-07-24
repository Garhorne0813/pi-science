import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { BookOpen, Play, Square, RefreshCw, ExternalLink } from "lucide-react";
import { cn } from "../../lib/cn";
import { useUiStore } from "../../lib/store";
import { fileInspectorForPath } from "../../lib/artifacts";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useTranslation } from "react-i18next";

interface Notebook {
  path: string; name: string; size: number; modified: string;
}

interface JupyterStatus {
  running: boolean;
  port: number | null;
  url: string | null;
  cwd: string | null;
  matches_workspace: boolean;
  env_ready?: boolean;
}

export function NotebooksPage() {
  const { t } = useTranslation();
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [jupyter, setJupyter] = useState<JupyterStatus>({
    running: false,
    port: null,
    url: null,
    cwd: null,
    matches_workspace: true,
    env_ready: false,
  });
  const [starting, setStarting] = useState(false);
  const [jupyterError, setJupyterError] = useState<string | null>(null);
  const openInspector = useUiStore((state) => state.openInspector);

  const loadNotebooks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/notebooks?cwd=${encodeURIComponent(workspaceCwd)}`);
      setNotebooks(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [workspaceCwd]);

  const loadJupyterStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/notebooks/jupyter/status?cwd=${encodeURIComponent(workspaceCwd)}`);
      setJupyter(await res.json());
    } catch { /* ignore */ }
  }, [workspaceCwd]);

  useEffect(() => {
    void loadNotebooks();
    void loadJupyterStatus();
  }, [loadJupyterStatus, loadNotebooks]);

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
    setJupyterError(null);
    try {
      const res = await fetch(`/api/notebooks/jupyter/start?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Unable to start Jupyter Lab (${res.status})`);
      setJupyter({ ...data, matches_workspace: true });
    } catch (e) { setJupyterError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  };

  const stopJupyter = async () => {
    setJupyterError(null);
    try {
      const res = await fetch(`/api/notebooks/jupyter/stop?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Unable to stop Jupyter Lab (${res.status})`);
      setJupyter({ running: false, port: null, url: null, cwd: null, matches_workspace: true });
    } catch (e) { setJupyterError(e instanceof Error ? e.message : String(e)); }
  };

  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  return (
    <WorkspacePage>
        <WorkspacePageHeader
          title="Notebooks"
          description={`${notebooks.length} notebook${notebooks.length !== 1 ? "s" : ""} in workspace`}
          actions={
          <WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => void loadNotebooks()} />
          }
        />

        {/* Jupyter Server */}
        <div className={cn("mt-6 rounded-card border p-4 mb-6", jupyter.running && jupyter.matches_workspace ? "border-ok/40 bg-ok/5" : "border-border bg-surface")}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-text">Jupyter Lab</h2>
              <p className="text-xs text-muted mt-0.5">
                {jupyter.running
                  ? jupyter.matches_workspace
                    ? `Running on port ${jupyter.port}`
                    : `Running for another workspace: ${jupyter.cwd}`
                  : jupyter.env_ready ? "Environment ready" : "Environment not set up"}
              </p>
              {jupyterError && <p role="alert" className="mt-1 text-xs text-error">{jupyterError}</p>}
            </div>
            <div className="flex items-center gap-2">
              {jupyter.running && jupyter.matches_workspace ? (
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
              <button
                key={nb.path}
                type="button"
                onClick={() => openInspector(fileInspectorForPath(nb.path, nb.name, undefined, workspaceCwd))}
                className="flex min-h-11 w-full items-center gap-3 border-b border-faint px-4 py-2.5 text-left text-sm hover:bg-surface-2 last:border-b-0"
              >
                <BookOpen size={16} className="text-accent/60 shrink-0" />
                <span className="truncate text-text flex-1">{nb.path}</span>
                <span className="text-xs text-muted shrink-0">{timeAgo(nb.modified)}</span>
                <span className="text-xs text-muted shrink-0 w-16 text-right">{(nb.size / 1024).toFixed(1)} KB</span>
              </button>
            ))}
          </div>
        )}
    </WorkspacePage>
  );
}
