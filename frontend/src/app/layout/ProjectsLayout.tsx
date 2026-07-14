import { Outlet, useNavigate, useParams, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import { PanelLeft, Settings, MessageSquare, Plus, Trash2, FolderOpen, ArrowLeft, Sun, Moon, Puzzle, FileText, BookOpen, Play } from "lucide-react";
import { useUiStore } from "../../lib/store";
import { useRuntimeStore } from "../../lib/runtime-store";
import { InspectorShell } from "../../components/inspector/InspectorShell";
import { RightPane } from "../../components/inspector/RightPane";
import { FileBrowser } from "../../components/sidebar/FileBrowser";
import { setCurrentCwd } from "../../lib/files";
import { cn } from "../../lib/cn";
import { getClient, type SessionInfo } from "../../lib/pi-science-client";
import { ErrorBoundary } from "../../components/ErrorBoundary";

export function ProjectsLayout() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorData = useUiStore((s) => s.inspectorData);
  const closeInspector = useUiStore((s) => s.closeInspector);
  const navigate = useNavigate();
  const location = useLocation();
  const { cwd: workspaceCwd } = useParams<{ cwd: string }>();

  // Decode workspace cwd from URL
  const activeCwd = workspaceCwd ? decodeURIComponent(workspaceCwd) : null;
  const isProjects = location.pathname === "/" || location.pathname === "/settings";
  const isWorkspace = !!activeCwd;

  // Set current CWD for file loading
  useEffect(() => {
    if (activeCwd) setCurrentCwd(activeCwd);
  }, [activeCwd]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* Sidebar */}
      {sidebarCollapsed ? (
        <aside className="h-full flex-col border-r border-border bg-surface flex shrink-0 overflow-hidden w-12 items-center py-3 gap-2">
          <button
            className="rounded p-1.5 text-muted hover:text-text hover:bg-surface-2"
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
          >
            <PanelLeft size={16} />
          </button>
          {/* Icon-only nav */}
          <CollapsedNavItem to="/" icon={isWorkspace ? <ArrowLeft size={16} /> : <FolderOpen size={16} />} label="Projects" />
          {!isWorkspace && <CollapsedNavItem to="/skills" icon={<Puzzle size={16} />} label="Skills" />}
          {isWorkspace && (
            <>
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} icon={<FileText size={16} />} label="Files" />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/notebooks`} icon={<BookOpen size={16} />} label="Notebooks" />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/runs`} icon={<Play size={16} />} label="Runs" />
            </>
          )}
          <div className="flex-1" />
          <CollapsedNavItem to="/settings" icon={<Settings size={16} />} label="Settings" />
        </aside>
      ) : (
        <aside className="h-full flex-col border-r border-border bg-surface flex shrink-0 overflow-hidden" style={{ width: sidebarWidth }}>
          <div className="flex flex-col h-full px-3 py-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 px-2">
              <h1 className="font-serif text-[20px] font-semibold tracking-tight text-text">
                Pi-Science
              </h1>
              <button
                className="rounded p-1.5 text-muted hover:text-text hover:bg-surface-2"
                onClick={() => setSidebarCollapsed(true)}
              >
                <PanelLeft size={16} />
              </button>
            </div>

            {/* Projects / Back to workspace list */}
            <nav className="flex flex-col gap-0.5 mb-3">
              <SidebarNavItem
                to="/"
                label={isWorkspace ? (activeCwd!.split("/").pop() || "Projects") : "Projects"}
                icon={isWorkspace ? <ArrowLeft size={16} /> : <FolderOpen size={16} />}
                active={false}
              />
              {!isWorkspace && <SidebarNavItem to="/skills" label="Skills" icon={<Puzzle size={16} />} active={false} />}
              {isWorkspace && (
                <>
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} label="Files" icon={<FileText size={16} />} active={false} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/notebooks`} label="Notebooks" icon={<BookOpen size={16} />} active={false} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/runs`} label="Runs" icon={<Play size={16} />} active={false} />
                </>
              )}
            </nav>

            {/* Session list (only in workspace context) */}
            {isWorkspace && <WorkspaceSessionList cwd={activeCwd!} />}

            {/* File browser */}
            {isWorkspace && <FileBrowser cwd={activeCwd!} />}

            {/* Bottom */}
            <div className="mt-auto">
              <div className="border-t border-faint my-3" />
              <StatusPills />
              <div className="mt-2 flex items-center gap-1">
                <div className="flex-1">
                  <SidebarNavItem to="/settings" label="Settings" icon={<Settings size={16} />} active={false} />
                </div>
                <ThemeToggle />
              </div>
            </div>
          </div>
        </aside>
      )}

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Outlet />
      </main>

      {/* Inspector */}
      {inspectorOpen && inspectorData && (
        <RightPane onClose={closeInspector}>
          <ErrorBoundary>
            <InspectorShell inspector={inspectorData} onClose={closeInspector} />
          </ErrorBoundary>
        </RightPane>
      )}
    </div>
  );
}

/* ── Workspace Session List ── */

function WorkspaceSessionList({ cwd }: { cwd: string }) {
  const sessions = useRuntimeStore((s) => s.sessions);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const loadSession = useRuntimeStore((s) => s.loadSession);
  const createNewSession = useRuntimeStore((s) => s.createNewSession);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    getClient().listSessions(cwd).then(async (list) => {
      // Inject session names from localStorage (backend doesn't store names)
      const { getSessionName } = await import("../../lib/pi-science-client");
      const named = list.map((s: SessionInfo) => ({
        ...s,
        name: s.name || getSessionName(s.id) || undefined,
      }));
      useRuntimeStore.setState({ sessions: named, cwd });
      // Auto-load most recent session if none active
      const state = useRuntimeStore.getState();
      if (list.length > 0 && !state.activeSessionId) {
        const latest = list[0];
        state.loadSession(latest.id);
        navigate(`/workspace/${encodeURIComponent(cwd)}/session/${latest.id}`);
      }
    });
  }, [cwd]);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(sessionId);
    try {
      await getClient().deleteSession(sessionId, cwd);
      await useRuntimeStore.getState().loadSessions();
      if (activeSessionId === sessionId) {
        const newId = await createNewSession();
        navigate(`/workspace/${encodeURIComponent(cwd)}/session/${newId}`);
      }
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(null);
    }
  };

  const handleNew = async () => {
    const existingEmpty = sessions.find((s) => s.name === "New Session");
    if (existingEmpty) {
      loadSession(existingEmpty.id);
      navigate(`/workspace/${encodeURIComponent(cwd)}/session/${existingEmpty.id}`);
      return;
    }
    const newId = await createNewSession();
    if (newId) {
      loadSession(newId);
      navigate(`/workspace/${encodeURIComponent(cwd)}/session/${newId}`);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
      <div className="flex items-center justify-between px-2 mb-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">Sessions</span>
        <button onClick={handleNew} className="rounded p-0.5 text-muted hover:text-text hover:bg-surface-2" title="New session">
          <Plus size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-2 text-[12px] text-muted/60 italic">No sessions yet</p>
        ) : (
          sessions.slice(0, 30).map((s) => (
            <div key={s.id} className="group relative flex items-center rounded-input hover:bg-surface-2">
              <button
                onClick={() => {
                  loadSession(s.id);
                  navigate(`/workspace/${encodeURIComponent(cwd)}/session/${s.id}`);
                }}
                className={cn(
                  "flex items-center gap-2 min-w-0 flex-1 py-1 pl-2 pr-1 text-[13px] text-left",
                  activeSessionId === s.id ? "text-text font-medium" : "text-text/90",
                )}
              >
                <MessageSquare size={12} className="shrink-0 text-muted" />
                <span className="truncate flex-1">{s.name || s.id.slice(0, 8)}</span>
                {(s.updated_at || s.created_at) && (
                  <span className="text-[10px] text-muted/60 shrink-0 mr-1 group-hover:hidden">
                    {relativeTime(s.updated_at || s.created_at!)}
                  </span>
                )}
              </button>
              <button
                onClick={(e) => handleDelete(e, s.id)}
                className={cn(
                  "shrink-0 rounded p-1 mr-1 text-muted hover:text-error hover:bg-error/10",
                  "hidden group-hover:block", deleting === s.id && "block",
                )}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ── Helpers ── */

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Icon-only nav item for the collapsed sidebar strip. */
function CollapsedNavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname.startsWith(to) && to !== "/";
  return (
    <button
      onClick={() => navigate(to)}
      className={cn(
        "rounded p-1.5 text-muted hover:text-text hover:bg-surface-2 transition-colors",
        active && "text-accent",
      )}
      title={label}
    >
      {icon}
    </button>
  );
}

function SidebarNavItem({ to, label, icon, active }: { to: string; label: string; icon?: React.ReactNode; active: boolean }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(to)}
      className={cn(
        "flex items-center gap-2.5 rounded-input px-2 py-1 text-[13px] text-left w-full",
        active ? "bg-surface-2 text-text font-medium" : "text-text/90 hover:bg-surface-2 hover:text-text",
      )}
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      {label}
    </button>
  );
}

function StatusPills() {
  const [health, setHealth] = useState<{ active_pi_processes: number; active_kernels: number } | null>(null);
  useEffect(() => {
    const poll = () => fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    poll();
    const i = setInterval(poll, 8000);
    return () => clearInterval(i);
  }, []);
  const t = health ? "bg-ok" : "bg-muted";
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <Pill dot={t} label="Agent" value={health ? "Ready" : "Offline"} />
      <Pill dot={health?.active_kernels ? "bg-ok" : "bg-muted"} label="Kernel" value={health ? `${health.active_kernels ?? 0}` : "—"} />
    </div>
  );
}

function ThemeToggle() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  return (
    <button
      onClick={() => setTheme(theme === "light" ? "dark" : "light")}
      className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text shrink-0"
      title="Toggle theme"
    >
      {theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
    </button>
  );
}

function Pill({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-2">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="shrink-0">{label}</span>
      <span className="ml-auto min-w-0 truncate text-text/70">{value}</span>
    </div>
  );
}
