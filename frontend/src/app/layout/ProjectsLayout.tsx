import { Outlet, useNavigate, useParams, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import { PanelLeft, Settings, MessageSquare, Plus, Trash2, GitFork, FolderOpen, ArrowLeft, Sun, Moon, Puzzle, FileText, BookOpen, Play, Inbox } from "lucide-react";
import { useUiStore } from "../../lib/store";
import { useRuntimeStore } from "../../lib/runtime-store";
import { InspectorShell } from "../../components/inspector/InspectorShell";
import { RightPane } from "../../components/inspector/RightPane";
import { FileBrowser } from "../../components/sidebar/FileBrowser";
import { cn } from "../../lib/cn";
import { getClient, getSessionName } from "../../lib/pi-science-client";
import { setCurrentCwd } from "../../lib/files";
import { ErrorBoundary } from "../../components/ErrorBoundary";

export function ProjectsLayout() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorData = useUiStore((s) => s.inspectorData);
  const closeInspector = useUiStore((s) => s.closeInspector);
  const location = useLocation();
  const { cwd: workspaceCwd } = useParams<{ cwd: string }>();

  // Decode workspace cwd from URL
  const activeCwd = workspaceCwd ? decodeURIComponent(workspaceCwd) : null;
  const isWorkspace = !!activeCwd;

  useEffect(() => {
    if (activeCwd) setCurrentCwd(activeCwd);
  }, [activeCwd]);

  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-bg text-text">
      {/* Sidebar */}
      {sidebarCollapsed ? (
        <button
          className="fade-in absolute left-1 top-1 z-40 flex h-11 w-11 items-center justify-center rounded-input text-text hover:bg-surface-2"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="Open sidebar"
        >
          <PanelLeft size={16} />
        </button>
      ) : (
        <>
        <button type="button" aria-label="Close sidebar" onClick={() => setSidebarCollapsed(true)} className="fixed inset-0 z-20 bg-black/45 md:hidden" />
        <aside className="absolute z-30 flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-surface md:relative" style={{ width: sidebarWidth, maxWidth: "86vw" }}>
          <div className="flex flex-col h-full px-3 py-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 px-2">
              <h1 className="font-serif text-[20px] font-semibold tracking-tight text-text">
                Pi-Science
              </h1>
              <button
                className="flex h-10 w-10 items-center justify-center rounded-input text-muted hover:bg-surface-2 hover:text-text"
                onClick={() => setSidebarCollapsed(true)}
                aria-label="Close sidebar"
              >
                <PanelLeft size={14} />
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
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} label="Files" icon={<FileText size={16} />} active={location.pathname.endsWith("/files")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/skills`} label="Skills" icon={<Puzzle size={16} />} active={location.pathname.endsWith("/skills")} />
                  <KnowledgeNavItem cwd={activeCwd!} active={location.pathname.endsWith("/knowledge")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/notebooks`} label="Notebooks" icon={<BookOpen size={16} />} active={location.pathname.endsWith("/notebooks")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/runs`} label="Runs" icon={<Play size={16} />} active={location.pathname.endsWith("/runs")} />
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
        </>
      )}

      {/* Main */}
      <main className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden",
        sidebarCollapsed && "pt-12 md:pt-0 md:pl-12",
      )}>
        <Outlet />
      </main>

      {/* Inspector */}
      {inspectorOpen && inspectorData && (
        <RightPane onClose={closeInspector}>
          <ErrorBoundary>
            <InspectorShell inspector={inspectorData} onClose={closeInspector} cwd={activeCwd || undefined} />
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
  const working = useRuntimeStore((s) => s.working);
  const forkSession = useRuntimeStore((s) => s.forkSession);
  const createNewSession = useRuntimeStore((s) => s.createNewSession);
  const navigate = useNavigate();
  const location = useLocation();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getClient().listSessions(cwd)
      .then((list) => {
        if (cancelled) return;
        const named = list.map((session) => ({
          ...session,
          name: session.name || getSessionName(session.id) || undefined,
        }));
        useRuntimeStore.setState({ sessions: named, cwd });
        // Auto-load most recent session if none active
        const state = useRuntimeStore.getState();
        const workspaceRoot = `/workspace/${encodeURIComponent(cwd)}`;
        if (named.length > 0 && !state.activeSessionId && location.pathname === workspaceRoot) {
          const latest = named[0];
          navigate(`/workspace/${encodeURIComponent(cwd)}/session/${latest.id}`);
        }
      })
      .catch((error) => {
        if (!cancelled) console.error("Failed to load workspace sessions:", error);
      });
    return () => { cancelled = true; };
  }, [cwd, location.pathname, navigate]);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (deleting || working) return;
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
    if (working) return;
    try {
      const newId = await createNewSession();
      if (newId) {
        navigate(`/workspace/${encodeURIComponent(cwd)}/session/${newId}`);
      }
    } catch (err) {
      console.error("Create session failed:", err);
    }
  };

  const handleFork = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (forking || working) return;
    setForking(sessionId);
    try {
      const newId = await forkSession(sessionId);
      navigate(`/workspace/${encodeURIComponent(cwd)}/session/${newId}`);
    } catch (err) {
      console.error("Fork failed:", err);
    } finally {
      setForking(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
      <div className="flex items-center justify-between px-2 mb-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">Sessions</span>
        <button
          onClick={handleNew}
          disabled={working}
          className="rounded p-0.5 text-muted hover:text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          title={working ? "Stop the current task before creating a new session" : "New session"}
        >
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
                  navigate(`/workspace/${encodeURIComponent(cwd)}/session/${s.id}`);
                }}
                disabled={working && activeSessionId !== s.id}
                className={cn(
                  "flex items-center gap-2 min-w-0 flex-1 py-1 pl-2 pr-1 text-[13px] text-left",
                  activeSessionId === s.id ? "text-text font-medium" : "text-text/90",
                  working && activeSessionId !== s.id && "cursor-not-allowed opacity-40",
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
                onClick={(e) => handleFork(e, s.id)}
                disabled={working}
                className={cn(
                  "shrink-0 rounded p-1 text-muted hover:text-accent hover:bg-accent/10",
                  "hidden group-hover:block disabled:cursor-not-allowed disabled:opacity-40", forking === s.id && "block",
                )}
                title="Fork session"
              >
                <GitFork size={12} />
              </button>
              <button
                onClick={(e) => handleDelete(e, s.id)}
                disabled={working}
                className={cn(
                  "shrink-0 rounded p-1 mr-1 text-muted hover:text-error hover:bg-error/10",
                  "hidden group-hover:block disabled:cursor-not-allowed disabled:opacity-40", deleting === s.id && "block",
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

function SidebarNavItem({ to, label, icon, active, badge }: { to: string; label: string; icon?: React.ReactNode; active: boolean; badge?: number }) {
  const navigate = useNavigate();
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  return (
    <button
      onClick={() => {
        navigate(to);
        if (window.innerWidth < 768) setSidebarCollapsed(true);
      }}
      className={cn(
        "flex min-h-11 items-center gap-2.5 rounded-input px-2 py-2 text-[13px] text-left w-full",
        active ? "bg-surface-2 text-text font-medium" : "text-text/90 hover:bg-surface-2 hover:text-text",
      )}
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] leading-none text-accent-fg">{badge}</span>}
    </button>
  );
}

function KnowledgeNavItem({ cwd, active }: { cwd: string; active: boolean }) {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const poll = () => fetch(`/api/project-knowledge/proposals/count?cwd=${encodeURIComponent(cwd)}`)
      .then((response) => response.ok ? response.json() : { pending_count: 0 })
      .then((data) => { if (!cancelled) setPending(Number(data.pending_count) || 0); })
      .catch(() => { if (!cancelled) setPending(0); });
    void poll();
    const interval = setInterval(poll, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [cwd]);
  return <SidebarNavItem to={`/workspace/${encodeURIComponent(cwd)}/knowledge`} label="Project Knowledge" icon={<Inbox size={16} />} active={active} badge={pending} />;
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
