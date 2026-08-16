import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Play, Square, RefreshCw, ExternalLink, CheckCircle2 } from "lucide-react";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { fileInspectorForPath } from "../../lib/artifacts";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useTranslation } from "react-i18next";
import { timeAgo } from "../../lib/shared";
import { apiRequest } from "../../lib/client/api";
import { queryClient } from "../../lib/client/query-client";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";
import { openJsonEventStream } from "../../lib/client/event-stream";

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

interface WorkspaceEnvironment {
  ready: boolean;
  virtual_env: string;
  python: string;
  error?: string;
}

interface JupyterSetupEvent {
  status: "done" | "error" | string;
  text: string;
}

const IDLE_JUPYTER: JupyterStatus = { running: false, port: null, url: null, cwd: null, matches_workspace: true, env_ready: false };

const notebooksQuery = (cwd: string) => ({ queryKey: ["notebooks", cwd], queryFn: () => apiRequest<Notebook[]>(`/api/notebooks?cwd=${encodeURIComponent(cwd)}`), staleTime: 0 });
const jupyterQuery = (cwd: string) => ({ queryKey: ["notebooks", "jupyter", cwd], queryFn: () => apiRequest<JupyterStatus>(`/api/notebooks/jupyter/status?cwd=${encodeURIComponent(cwd)}`), staleTime: 0 });
const environmentQuery = (cwd: string) => ({ queryKey: ["environments", cwd], queryFn: () => apiRequest<WorkspaceEnvironment>(`/api/environments/workspace?cwd=${encodeURIComponent(cwd)}`), staleTime: 0 });

export function NotebooksPage() {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const workspaceCwd = useRequiredWorkspaceCwd();
  // Jupyter status and the workspace environment are also written by the start/stop
  // and provision actions, so the cache — not local state — holds the current value.
  const notebooksResult = useQuery(notebooksQuery(workspaceCwd));
  const jupyterResult = useQuery(jupyterQuery(workspaceCwd));
  const environmentResult = useQuery(environmentQuery(workspaceCwd));
  const notebooks = notebooksResult.data ?? [];
  const loading = notebooksResult.isFetching;
  const jupyter = jupyterResult.data ?? IDLE_JUPYTER;
  const environment = environmentResult.data ?? null;
  const [starting, setStarting] = useState(false);
  const [provisioningEnvironment, setProvisioningEnvironment] = useState(false);
  const [jupyterError, setJupyterError] = useState<string | null>(null);
  const openInspector = useUiStore((state) => state.openInspector);

  const notebooksError = notebooksResult.error;
  const jupyterStatusError = jupyterResult.error;
  const environmentError = environmentResult.error;
  useEffect(() => { if (notebooksError) toast(notebooksError instanceof Error ? notebooksError.message : t("notebooks.loadError"), "error"); }, [notebooksError, t, toast]);
  useEffect(() => { if (jupyterStatusError) setJupyterError(jupyterStatusError instanceof Error ? jupyterStatusError.message : t("notebooks.jupyterStatusError")); }, [jupyterStatusError, t]);
  useEffect(() => { if (environmentError) toast(environmentError instanceof Error ? environmentError.message : t("notebooks.environmentError"), "error"); }, [environmentError, t, toast]);

  const provisionWorkspaceEnvironment = async () => {
    setProvisioningEnvironment(true);
    try {
      const data = await apiRequest<WorkspaceEnvironment>(`/api/environments/workspace?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "POST" });
      queryClient.setQueryData(environmentQuery(workspaceCwd).queryKey, data);
      toast(t("notebooks.environmentReady"), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("notebooks.environmentCreateError"), "error");
    } finally {
      setProvisioningEnvironment(false);
    }
  };

  const [setupProgress, setSetupProgress] = useState<string[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const closeSetupStreamRef = useRef<(() => void) | null>(null);
  useEffect(() => () => closeSetupStreamRef.current?.(), []);

  const setupJupyterEnv = async () => {
    closeSetupStreamRef.current?.();
    setSettingUp(true);
    setSetupProgress([]);
    try {
      closeSetupStreamRef.current = openJsonEventStream<JupyterSetupEvent>(`/api/notebooks/jupyter/setup?cwd=${encodeURIComponent(workspaceCwd)}`, {
        onMessage: (d) => {
        if (d.status === "done") {
          setSetupProgress((p) => [...p, "✅ " + d.text]);
          closeSetupStreamRef.current?.();
          closeSetupStreamRef.current = null;
          setSettingUp(false);
          void jupyterResult.refetch();
        } else if (d.status === "error") {
          setSetupProgress((p) => [...p, "❌ " + d.text]);
          closeSetupStreamRef.current?.();
          closeSetupStreamRef.current = null;
          setSettingUp(false);
        } else {
          setSetupProgress((p) => [...p, d.text]);
        }
        },
        onError: () => {
          closeSetupStreamRef.current = null;
          setSettingUp(false);
          toast(t("notebooks.setupConnectionFailed"), "error");
        },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : t("notebooks.setupFailed"), "error");
      setSettingUp(false);
    }
  };

  const startJupyter = async () => {
    setStarting(true);
    setJupyterError(null);
    try {
      const data = await apiRequest<JupyterStatus>(`/api/notebooks/jupyter/start?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "POST" });
      queryClient.setQueryData(jupyterQuery(workspaceCwd).queryKey, { ...data, matches_workspace: true });
      void environmentResult.refetch();
    } catch (e) { setJupyterError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  };

  const stopJupyter = async () => {
    setJupyterError(null);
    try {
      await apiRequest(`/api/notebooks/jupyter/stop?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "POST" });
      queryClient.setQueryData(jupyterQuery(workspaceCwd).queryKey, { ...IDLE_JUPYTER, env_ready: undefined });
    } catch (e) { setJupyterError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <WorkspacePage>
        <WorkspacePageHeader
          title={t("notebooks.title")}
          description={t("notebooks.count", { count: notebooks.length })}
          actions={
          <WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => void notebooksResult.refetch()} />
          }
        />

        <div className="ui-card-flat mt-6 flex flex-wrap items-center justify-between gap-2 rounded-card px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-text">
              {environment?.ready && <CheckCircle2 size={14} className="text-ok-text" />}
              {t("notebooks.workspacePython")}
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
              {environment?.ready ? environment.python : environment?.error || t("notebooks.environmentMissing")}
            </p>
          </div>
          {!environment?.ready && (
            <button type="button" onClick={() => void provisionWorkspaceEnvironment()} disabled={provisioningEnvironment} className="ml-3 flex shrink-0 items-center gap-1 rounded-input bg-accent-fill px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40">
              {provisioningEnvironment && <RefreshCw size={12} className="animate-spin" />}
              {t("notebooks.initialize")}
            </button>
          )}
        </div>

        {/* Jupyter Server */}
        <div className={cn("mb-6 mt-3 rounded-card border p-4", jupyter.running && jupyter.matches_workspace ? "border-ok/40 bg-ok/5" : "ui-card-flat")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium text-text">{t("notebooks.jupyterLab")}</h2>
              <p className="text-xs text-muted mt-0.5">
                {jupyter.running
                  ? jupyter.matches_workspace
                    ? t("notebooks.runningPort", { port: jupyter.port })
                    : t("notebooks.runningElsewhere", { cwd: jupyter.cwd })
                  : jupyter.env_ready ? t("notebooks.environmentReadyShort") : t("notebooks.environmentNotSetUp")}
              </p>
              {jupyterError && <p role="alert" className="mt-1 text-xs text-error-text">{jupyterError}</p>}
            </div>
            <div className="flex items-center gap-2">
              {jupyter.running && jupyter.matches_workspace ? (
                <>
                  <a href={jupyter.url!} target="_blank" className="rounded-input px-3 py-1.5 text-xs text-link hover:bg-surface-2 flex items-center gap-1">
                    <ExternalLink size={12} /> {t("common.open")}
                  </a>
                  <button onClick={stopJupyter} className="rounded-input px-3 py-1.5 text-xs text-error-text hover:bg-error/10 flex items-center gap-1">
                    <Square size={12} /> {t("common.stop")}
                  </button>
                </>
              ) : jupyter.env_ready ? (
                <button onClick={startJupyter} disabled={starting}
                  className="rounded-input bg-accent-fill px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40 flex items-center gap-1">
                  {starting ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />} {t("common.start")}
                </button>
              ) : (
                <button onClick={setupJupyterEnv} disabled={settingUp}
                  className="rounded-input bg-accent-fill px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40 flex items-center gap-1">
                  {settingUp ? <RefreshCw size={12} className="animate-spin" /> : "⚡"} {t("notebooks.setupJupyter")}
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
          <div className="text-sm text-muted py-8 text-center">{t("common.loading")}</div>
        ) : notebooks.length === 0 ? (
          <div className="text-center py-16">
            <BookOpen size={40} className="mx-auto text-muted/30 mb-3" />
            <p className="text-sm text-muted">{t("notebooks.empty")}</p>
            <p className="text-xs text-muted mt-1">{t("notebooks.emptyHint")}</p>
          </div>
        ) : (
          <div className="ui-card-flat overflow-hidden rounded-card">
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
