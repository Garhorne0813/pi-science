import { Outlet, useNavigate, useParams, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import { PanelLeft, Settings, MessageSquare, Plus, Trash2, GitFork, FolderOpen, ArrowLeft, Sun, Moon, Puzzle, FileText, BookOpen, Play, Inbox } from "lucide-react";
import { useUiStore } from "../../lib/store";
import { useRuntimeStore } from "../../lib/runtime-store";
import { InspectorShell } from "../../components/inspector/InspectorShell";
import { RightPane } from "../../components/inspector/RightPane";
import { FileBrowser } from "../../components/sidebar/FileBrowser";
import { setCurrentCwd } from "../../lib/files";
import { cn } from "../../lib/cn";
import { getClient, getSessionName } from "../../lib/pi-science-client";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useTranslation } from "react-i18next";

export function ProjectsLayout() {
  const { t } = useTranslation();
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

  // Close the inspector when switching workspaces — stale inspector
  // data from workspace A makes no sense after navigating to workspace B.
  useEffect(() => {
    closeInspector();
  }, [activeCwd, closeInspector]);

  // A desktop sidebar left open becomes an overlay when the viewport crosses
  // the mobile breakpoint. Close it during that transition so it cannot cover
  // project cards or other primary content.
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 767px)");
    const collapseOnNarrow = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSidebarCollapsed(true);
    };
    collapseOnNarrow(narrow);
    narrow.addEventListener("change", collapseOnNarrow);
    return () => narrow.removeEventListener("change", collapseOnNarrow);
  }, [setSidebarCollapsed]);

  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-bg text-text">
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
          <CollapsedNavItem to="/" icon={isWorkspace ? <ArrowLeft size={16} /> : <FolderOpen size={16} />} label={t("nav.projects")} />
          {!isWorkspace && <CollapsedNavItem to="/skills" icon={<Puzzle size={16} />} label={t("nav.skills")} />}
          {isWorkspace && (
            <>
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} icon={<FileText size={16} />} label={t("nav.files")} />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/notebooks`} icon={<BookOpen size={16} />} label={t("nav.notebooks")} />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/runs`} icon={<Play size={16} />} label={t("nav.runs")} />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/knowledge`} icon={<Inbox size={16} />} label={t("nav.knowledge")} />
            </>
          )}
          <div className="flex-1" />
          <SettingsNavItem cwd={activeCwd} collapsed />
        </aside>
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
                <PanelLeft size={16} />
              </button>
            </div>

            {/* Projects / Back to workspace list */}
            <nav className="flex flex-col gap-0.5 mb-3">
              <SidebarNavItem
                to="/"
                label={isWorkspace ? (activeCwd!.split("/").pop() || t("nav.projects")) : t("nav.projects")}
                icon={isWorkspace ? <ArrowLeft size={16} /> : <FolderOpen size={16} />}
                active={false}
              />
              {!isWorkspace && <SidebarNavItem to="/skills" label={t("nav.skills")} icon={<Puzzle size={16} />} active={false} />}
              {isWorkspace && (
                <>
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} label={t("nav.files")} icon={<FileText size={16} />} active={location.pathname.endsWith("/files")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/skills`} label={t("nav.skills")} icon={<Puzzle size={16} />} active={location.pathname.endsWith("/skills")} />
                  <KnowledgeNavItem cwd={activeCwd!} active={location.pathname.endsWith("/knowledge")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/notebooks`} label={t("nav.notebooks")} icon={<BookOpen size={16} />} active={location.pathname.endsWith("/notebooks")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/runs`} label={t("nav.runs")} icon={<Play size={16} />} active={location.pathname.endsWith("/runs")} />
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
              <div className="mt-2 flex items-center gap-1">
                <div className="flex-1">
                  <SettingsNavItem cwd={activeCwd} />
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

      {/* Inspector — only in workspace context */}
      {isWorkspace && inspectorOpen && inspectorData && (
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
  const { t } = useTranslation();
  const sessions = useRuntimeStore((s) => s.sessions);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const working = useRuntimeStore((s) => s.working);
  const forkSession = useRuntimeStore((s) => s.forkSession);
  const createNewSession = useRuntimeStore((s) => s.createNewSession);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getClient().listSessions(cwd)
      .then((list) => {
        if (cancelled) return;
        const current = useRuntimeStore.getState();
        const named = list.map((session) => ({
          ...session,
          name: session.name || getSessionName(session.id) || current.sessions.find((item) => item.id === session.id)?.name || undefined,
        }));
        const diskIds = new Set(named.map((session) => session.id));
        const optimisticActive = current.sessions.filter((session) => session.id === current.activeSessionId && !diskIds.has(session.id) && !session.created_at && !session.updated_at);
        const merged = [...optimisticActive, ...named].slice(0, 50);
        useRuntimeStore.setState({ sessions: merged, cwd });
        // Auto-load most recent session if none active
        const state = useRuntimeStore.getState();
        const workspaceRoot = `/workspace/${encodeURIComponent(cwd)}`;
        if (merged.length > 0 && !state.activeSessionId && window.location.pathname === workspaceRoot) {
          const latest = merged[0];
          navigate(`/workspace/${encodeURIComponent(cwd)}/session/${latest.id}`);
        }
      })
      .catch((error) => {
        if (!cancelled) console.error("Failed to load workspace sessions:", error);
      });
    return () => { cancelled = true; };
  }, [cwd, navigate]);

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
        <span className="text-xs font-medium uppercase tracking-wider text-muted">{t("conversation.sessions")}</span>
        <button
          onClick={handleNew}
          disabled={working}
          className="rounded p-0.5 text-muted hover:text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          title={working ? t("conversation.stopBeforeNew") : t("conversation.newSession")}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-2 text-[12px] text-muted/60 italic">{t("conversation.noSessions")}</p>
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
                <span className="truncate flex-1">{s.name === "New Session" ? t("conversation.newSession") : s.name || s.id.slice(0, 8)}</span>
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
        "flex min-h-0 h-9 items-center gap-2 rounded-input px-2 text-[13px] text-left w-full",
        active ? "bg-surface-2 text-text font-medium" : "text-text/90 hover:bg-surface-2 hover:text-text",
      )}
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] leading-none text-accent-fg">{badge}</span>}
    </button>
  );
}

function SettingsNavItem({ cwd, collapsed = false }: { cwd: string | null; collapsed?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname.endsWith("/settings");
  const target = cwd ? `/workspace/${encodeURIComponent(cwd)}/settings` : "/settings";
  const workspaceHome = cwd ? `/workspace/${encodeURIComponent(cwd)}` : "/";
  const state = location.state as { settingsReturnTo?: string } | null;
  const handleClick = () => {
    if (active) {
      navigate(state?.settingsReturnTo || workspaceHome);
      return;
    }
    navigate(target, { state: { settingsReturnTo: `${location.pathname}${location.search}${location.hash}` } });
    if (window.innerWidth < 768) useUiStore.getState().setSidebarCollapsed(true);
  };

  if (collapsed) {
    return (
      <button onClick={handleClick} className={cn("rounded p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-text", active && "text-accent")} title={active ? t("nav.backToPrevious") : t("nav.settings")}>
        <Settings size={16} />
      </button>
    );
  }
  return (
    <button onClick={handleClick} className={cn("flex h-9 min-h-0 w-full items-center gap-2 rounded-input px-2 text-left text-[13px]", active ? "bg-surface-2 font-medium text-text" : "text-text/90 hover:bg-surface-2 hover:text-text")}>
      <span className="shrink-0 text-muted"><Settings size={16} /></span>
      <span className="min-w-0 flex-1 truncate">{t("nav.settings")}</span>
    </button>
  );
}

function KnowledgeNavItem({ cwd, active }: { cwd: string; active: boolean }) {
  const { t } = useTranslation();
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
  return <SidebarNavItem to={`/workspace/${encodeURIComponent(cwd)}/knowledge`} label={t("nav.knowledge")} icon={<Inbox size={16} />} active={active} badge={pending} />;
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
