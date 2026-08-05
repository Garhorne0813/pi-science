import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { PanelLeft, Settings, MessageSquare, Plus, Trash2, GitFork, FolderOpen, ArrowLeft, Puzzle, FileText, BookOpen, Play, Inbox, FlaskConical } from "lucide-react";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { InspectorShell } from "../../components/inspector/InspectorShell";
import { RightPane } from "../../components/inspector/RightPane";
import type { Inspector } from "../../types/thread";
import { FileBrowser } from "../../components/sidebar/FileBrowser";
import { useWorkspaceCwd } from "../../lib/workspace";
import { usePendingProposalCount } from "../../lib/knowledge";
import { cn } from "../../lib/ui";
import { ErrorBoundary } from "../../components/ErrorBoundary";

// The settings bundle (dialog + five tabs) only loads on first open.
const SettingsDialog = lazy(() => import("../../components/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
import { useTranslation } from "react-i18next";
import { useFeedback } from "../../components/feedback/feedback-context";
import { workspacePathLeaf } from "../../lib/workspace";

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;

const TodoWidget = lazy(() => import("../../components/todo/TodoWidget").then((m) => ({ default: m.TodoWidget })));

export function ProjectsLayout() {
  const { t } = useTranslation();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorData = useUiStore((s) => s.inspectorData);
  const closeInspector = useUiStore((s) => s.closeInspector);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarDragWidthRef = useRef<number | null>(null);
  const location = useLocation();
  const activeCwd = useWorkspaceCwd();
  const isWorkspace = !!activeCwd;
  const clampSidebarWidth = (width: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  const beginSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarDragWidthRef.current = sidebarWidth;
    setSidebarDragging(true);
  };
  const resizeSidebar = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const sidebarLeft = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    const width = clampSidebarWidth(event.clientX - sidebarLeft);
    sidebarDragWidthRef.current = width;
    setSidebarDragWidth(width);
  };
  const finishSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (sidebarDragWidthRef.current !== null) {
      setSidebarWidth(sidebarDragWidthRef.current);
    }
    sidebarDragWidthRef.current = null;
    setSidebarDragWidth(null);
    setSidebarDragging(false);
  };

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
      <a href="#main-content" className="fixed left-3 top-3 z-[200] -translate-y-20 rounded-input bg-accent px-3 py-2 text-sm text-accent-fg transition-transform focus:translate-y-0">
        {t("common.skipToContent", { defaultValue: "Skip to content" })}
      </a>
      {/* Sidebar */}
      {sidebarCollapsed ? (
        <aside className="h-full flex-col border-r border-border bg-bg flex shrink-0 overflow-hidden w-12 items-center py-3 gap-2">
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
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/research`} icon={<FlaskConical size={16} />} label={t("nav.research")} />
            </>
          )}
          <div className="flex-1" />
          <SettingsNavItem cwd={activeCwd} collapsed />
        </aside>
      ) : (
        <>
        <button type="button" aria-label="Close sidebar" onClick={() => setSidebarCollapsed(true)} className="fixed inset-0 z-20 bg-black/45 md:hidden" />
        <aside className="absolute z-30 flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-bg md:relative" style={{ width: sidebarDragWidth ?? sidebarWidth, maxWidth: "86vw" }}>
          <div className="flex flex-col h-full px-3 py-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 px-2">
              <h1 className="font-serif text-[20px] font-semibold tracking-tight text-text">
                Pi-Science
              </h1>
              <button
                className="flex h-10 w-10 translate-x-1 items-center justify-center rounded-input text-muted hover:bg-surface-2 hover:text-text"
                onClick={() => setSidebarCollapsed(true)}
                aria-label="Close sidebar"
              >
                <PanelLeft size={16} />
              </button>
            </div>

            {/* Projects / Back to workspace list */}
            <nav className="flex flex-col gap-px mb-2">
              <SidebarNavItem
                to="/"
                label={isWorkspace ? (workspacePathLeaf(activeCwd!) || t("nav.projects")) : t("nav.projects")}
                icon={isWorkspace ? <ArrowLeft size={16} /> : <FolderOpen size={16} />}
                active={false}
              />
              {!isWorkspace && <SidebarNavItem to="/skills" label={t("nav.skills")} icon={<Puzzle size={16} />} active={false} />}
              {isWorkspace && (
                <>
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} label={t("nav.files")} icon={<FileText size={16} />} active={location.pathname.endsWith("/files")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/skills`} label={t("nav.skills")} icon={<Puzzle size={16} />} active={location.pathname.endsWith("/skills")} />
                  <KnowledgeNavItem cwd={activeCwd!} active={location.pathname.endsWith("/knowledge")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/research`} label={t("nav.research")} icon={<FlaskConical size={16} />} active={location.pathname.endsWith("/research")} />
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
              <div className="mt-2">
                <SettingsNavItem cwd={activeCwd} />
              </div>
            </div>
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebarDragWidth ?? sidebarWidth}
            tabIndex={0}
            onPointerDown={beginSidebarResize}
            onPointerMove={resizeSidebar}
            onPointerUp={finishSidebarResize}
            onPointerCancel={finishSidebarResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 16 : -16;
              setSidebarWidth(clampSidebarWidth(sidebarWidth + delta));
            }}
            className={cn(
              "group absolute inset-y-0 right-0 z-40 hidden w-1.5 cursor-col-resize md:block",
              sidebarDragging && "bg-accent/10",
            )}
          >
            <div className="absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-accent/50" />
          </div>
        </aside>
        </>
      )}

      {/* Main */}
      <main id="main-content" tabIndex={-1} className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden",
        sidebarCollapsed && "pt-12 md:pt-0 md:pl-12",
      )}>
        <Outlet />
        <Suspense fallback={null}>
          <TodoWidget />
        </Suspense>
      </main>

      {/* Inspector — only in workspace context */}
      {isWorkspace && inspectorOpen && inspectorData && (
        <WorkspaceInspectorPane inspectorData={inspectorData} cwd={activeCwd} onClose={closeInspector} />
      )}

      {/* Settings dialog — floats above every page, one instance only */}
      <Suspense fallback={null}>
        <SettingsDialog />
      </Suspense>
    </div>
  );
}

/* ── Workspace Right Pane (inspector only; todo lives in its own widgets) ── */

export function WorkspaceInspectorPane({ inspectorData, cwd, onClose }: { inspectorData: Inspector | null; cwd: string | null; onClose: () => void }) {
  if (!inspectorData) return null;
  return (
    <RightPane onClose={onClose}>
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <ErrorBoundary>
            <InspectorShell inspector={inspectorData} onClose={onClose} cwd={cwd || undefined} />
          </ErrorBoundary>
        </div>
      </div>
    </RightPane>
  );
}

/* ── Workspace Session List ── */

export function WorkspaceSessionList({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const sessions = useRuntimeStore((s) => s.sessions);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const forkSession = useRuntimeStore((s) => s.forkSession);
  const loadSessions = useRuntimeStore((s) => s.loadSessions);
  const deleteSession = useRuntimeStore((s) => s.deleteSession);
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceRoot = `/workspace/${encodeURIComponent(cwd)}`;
  const isWorkspaceRoot = location.pathname === workspaceRoot;
  // The store marker carries the suppression across a layout remount; the
  // route-state target prevents a fast workspace switch from consuming it in
  // the wrong workspace.
  const intentionalRootLanding = location.state?.suppressAutoSessionNavFor === cwd;
  const [deleting, setDeleting] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Session lists belong to the workspace landing only. In particular, do
    // not reload them for ordinary navigation between files, runs, settings,
    // or a conversation route.
    if (!isWorkspaceRoot) return () => { cancelled = true; };

    // Consume suppression only for the intentional root landing that set it.
    // A stale marker from an interrupted/other-workspace navigation is cleared,
    // but a normal first root entry still loads and may auto-open a session.
    const suppressAutoNav = useUiStore.getState().suppressAutoSessionNav;
    if (suppressAutoNav && intentionalRootLanding) {
      useUiStore.getState().setSuppressAutoSessionNav(false);
      return () => { cancelled = true; };
    }
    if (suppressAutoNav) useUiStore.getState().setSuppressAutoSessionNav(false);

    loadSessions(cwd)
      .then((merged) => {
        if (cancelled) return;
        // Auto-load most recent session if none active
        const state = useRuntimeStore.getState();
        if (merged.length > 0 && !state.activeSessionId) {
          const latest = merged[0];
          navigate(`/workspace/${encodeURIComponent(cwd)}/session/${latest.id}`);
        }
      })
      .catch((error) => {
        if (!cancelled) toast(error instanceof Error ? error.message : "Unable to load workspace sessions", "error");
      });
    return () => { cancelled = true; };
  }, [cwd, intentionalRootLanding, isWorkspaceRoot, loadSessions, navigate, toast]);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(sessionId);
    // Read freshness after the await: the user may have switched sessions
    // while the delete was in flight, and we must not kick them out of the
    // session they are now viewing.
    const wasActive = useRuntimeStore.getState().activeSessionId === sessionId;
    try {
      await deleteSession(sessionId);
      // Only the active-session delete lands on the blank workspace, and only
      // when the store agrees the session is really gone (deleteSession
      // detaches the stream and clears activeSessionId). The user could have
      // opened another session meanwhile, or switched workspaces.
      const state = useRuntimeStore.getState();
      if (wasActive && state.activeSessionId === null && state.cwd === cwd) {
        // deleteSession already detached the stream and blanked the thread.
        // Return to the workspace landing (blank composer) instead of creating
        // a fresh session — the first prompt creates one lazily. Set a flag so
        // the session-list auto-nav effect does not yank the user straight
        // back into the most recent session. replace: true keeps the landing
        // as the entry point instead of stacking history entries.
        useUiStore.getState().setSuppressAutoSessionNav(true);
        navigate(workspaceRoot, { replace: true, state: { suppressAutoSessionNavFor: cwd } });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to delete session", "error");
    } finally {
      setDeleting(null);
    }
  };

  const handleNew = async () => {
    // Session creation is lazy: the first prompt creates the server-side
    // session, avoiding an empty Pi process for every click. A repeated click
    // at the root is already on the intended landing, so it must not leave a
    // suppression marker behind for the next normal root entry.
    if (isWorkspaceRoot) {
      useUiStore.getState().setSuppressAutoSessionNav(false);
      return;
    }
    useUiStore.getState().setSuppressAutoSessionNav(true);
    navigate(workspaceRoot, { state: { suppressAutoSessionNavFor: cwd } });
  };

  const handleFork = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (forking) return;
    setForking(sessionId);
    try {
      const newId = await forkSession(sessionId);
      navigate(`/workspace/${encodeURIComponent(cwd)}/session/${newId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Unable to fork session", "error");
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
          className="rounded p-0.5 text-muted hover:text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          title={t("conversation.newSession")}
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
              {/* Current-conversation indicator: a dot on the left edge; other
                  sessions keep an invisible dot so the list does not jump. */}
              <span
                aria-hidden
                className={cn("ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full", activeSessionId === s.id && "bg-accent")}
                style={activeSessionId === s.id ? undefined : { visibility: "hidden" }}
              />
              <button
                onClick={() => {
                  navigate(`/workspace/${encodeURIComponent(cwd)}/session/${s.id}`);
                }}
                className={cn(
                  "flex items-center gap-2 min-w-0 flex-1 py-1 pl-2 pr-1 text-[13px] text-left",
                  activeSessionId === s.id ? "text-text font-medium" : "text-text/90",
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
        "flex min-h-0 h-8 items-center gap-1.5 rounded-input px-1.5 text-[13px] text-left w-full",
        active ? "bg-surface-2 text-text font-medium" : "text-text/90 hover:bg-surface-2 hover:text-text",
      )}
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] leading-none text-accent-fg">{badge}</span>}
    </button>
  );
}

export function SettingsNavItem({ cwd, collapsed = false }: { cwd: string | null; collapsed?: boolean }) {
  const { t } = useTranslation();
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const openSettings = useUiStore((s) => s.openSettings);
  const handleClick = () => {
    openSettings(cwd);
    if (window.innerWidth < 768) useUiStore.getState().setSidebarCollapsed(true);
  };

  if (collapsed) {
    return (
      <button onClick={handleClick} className={cn("rounded p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-text", settingsOpen && "text-accent")} title={t("nav.settings")}>
        <Settings size={16} />
      </button>
    );
  }
  return (
    <button onClick={handleClick} className={cn("flex h-8 min-h-0 w-full items-center gap-1.5 rounded-input px-1.5 text-left text-[13px]", settingsOpen ? "bg-surface-2 font-medium text-text" : "text-text/90 hover:bg-surface-2 hover:text-text")}>
      <span className="shrink-0 text-muted"><Settings size={16} /></span>
      <span className="min-w-0 flex-1 truncate">{t("nav.settings")}</span>
    </button>
  );
}

function KnowledgeNavItem({ cwd, active }: { cwd: string; active: boolean }) {
  const { t } = useTranslation();
  const { data } = usePendingProposalCount(cwd);
  return <SidebarNavItem to={`/workspace/${encodeURIComponent(cwd)}/knowledge`} label={t("nav.knowledge")} icon={<Inbox size={16} />} active={active} badge={Number(data?.pending_count) || 0} />;
}
