import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { PanelLeft, Settings, MessageSquare, Plus, Trash2, GitFork, FolderOpen, ArrowLeft, FileText, Inbox, FlaskConical, type LucideIcon } from "lucide-react";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { InspectorTabs } from "../../components/inspector/InspectorTabs";
import { RightPane } from "../../components/inspector/RightPane";
import { PreviewPaneControls } from "../../components/inspector/PreviewPaneControls";
import { FileBrowser } from "../../components/sidebar/FileBrowser";
import { useWorkspaceCwd } from "../../lib/workspace";
import { usePendingProposalCount } from "../../lib/knowledge";
import { cn } from "../../lib/ui";

// The settings bundle (dialog + tabs) only loads on first open.
const SettingsDialog = lazy(() => import("../../components/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
import { useTranslation } from "react-i18next";
import { useFeedback } from "../../components/feedback/feedback-context";
import { workspacePathLeaf } from "../../lib/workspace";
import { Icon, IconButton } from "../../components/ui/Icon";
import { conversationSessionId } from "../../lib/conversation/session-route";

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;

export function ProjectsLayout() {
  const { t } = useTranslation();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const previewPaneSide = useUiStore((s) => s.previewPaneSide);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorTabs = useUiStore((s) => s.inspectorTabs);
  const activeInspectorTabId = useUiStore((s) => s.activeInspectorTabId);
  const inspectorMaximized = useUiStore((s) => s.inspectorMaximized);
  const closeInspector = useUiStore((s) => s.closeInspector);
  const setInspectorVisible = useUiStore((s) => s.setInspectorVisible);
  const setInspectorMaximized = useUiStore((s) => s.setInspectorMaximized);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarDragWidthRef = useRef<number | null>(null);
  const location = useLocation();
  const activeCwd = useWorkspaceCwd();
  const isWorkspace = !!activeCwd;
  const workspaceRoot = activeCwd ? `/workspace/${encodeURIComponent(activeCwd)}` : "";
  const activeConversationSessionId = conversationSessionId(location.pathname);
  const isConversationRoute = isWorkspace && (
    location.pathname === workspaceRoot || location.pathname.startsWith(`${workspaceRoot}/session/`)
  );
  const previewOnLeft = isConversationRoute && previewPaneSide === "left";
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

  useEffect(() => {
    if (!isConversationRoute && inspectorMaximized) setInspectorMaximized(false);
  }, [inspectorMaximized, isConversationRoute, setInspectorMaximized]);

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
        <aside className="app-sidebar flex h-full w-12 shrink-0 flex-col items-center gap-2 overflow-hidden border-r border-border py-panel">
          <IconButton
            icon={PanelLeft}
            label="Expand sidebar"
            size="standard"
            onClick={() => setSidebarCollapsed(false)}
          />
          {/* Icon-only nav */}
          <CollapsedNavItem to="/" icon={isWorkspace ? ArrowLeft : FolderOpen} label={t("nav.projects")} />
          {isWorkspace && (
            <>
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} icon={FileText} label={t("nav.files")} />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/knowledge`} icon={Inbox} label={t("nav.knowledge")} />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/research`} icon={FlaskConical} label={t("nav.research")} />
            </>
          )}
          <div className="flex-1" />
          <SettingsNavItem cwd={activeCwd} collapsed />
        </aside>
      ) : (
        <>
        <button type="button" aria-label="Close sidebar" onClick={() => setSidebarCollapsed(true)} className="fixed inset-0 z-20 bg-black/45 md:hidden" />
        <aside className="app-sidebar absolute z-30 flex h-full shrink-0 flex-col overflow-hidden border-r border-border md:relative" style={{ width: sidebarDragWidth ?? sidebarWidth, maxWidth: "86vw" }}>
          <div className="flex h-full flex-col px-panel py-card">
            {/* Header */}
            <div className="mb-card flex items-center justify-between px-2">
              <h1 className="font-serif text-ui-title font-semibold tracking-tight text-text">
                Pi-Science
              </h1>
              <IconButton
                icon={PanelLeft}
                label="Close sidebar"
                size="touch"
                className="translate-x-1"
                onClick={() => setSidebarCollapsed(true)}
              />
            </div>

            {/* Projects / Back to workspace list */}
            <nav className="flex flex-col gap-px mb-2">
              <SidebarNavItem
                to="/"
                label={isWorkspace ? (workspacePathLeaf(activeCwd!) || t("nav.projects")) : t("nav.projects")}
                icon={isWorkspace ? ArrowLeft : FolderOpen}
                active={false}
              />
              {isWorkspace && (
                <>
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} label={t("nav.files")} icon={FileText} active={location.pathname.endsWith("/files")} />
                  <KnowledgeNavItem cwd={activeCwd!} active={location.pathname.endsWith("/knowledge")} />
                  <SidebarNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/research`} label={t("nav.research")} icon={FlaskConical} active={location.pathname.endsWith("/research")} />
                </>
              )}
            </nav>

            {/* Session list (only in workspace context) */}
            {isWorkspace && <WorkspaceSessionList cwd={activeCwd!} />}

            {/* File browser */}
            {isWorkspace && <FileBrowser cwd={activeCwd!} />}

            {/* Bottom */}
            <div className="mt-auto">
              <div className="my-panel border-t border-faint" />
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
        "relative flex min-w-0 flex-1 flex-col overflow-hidden [container-type:inline-size]",
        sidebarCollapsed && "pt-12 md:pt-0",
        inspectorMaximized && "hidden",
        previewOnLeft && "order-2",
      )}>
        <Outlet />
      </main>

      {isConversationRoute && (!previewOnLeft || !inspectorOpen) && <PreviewPaneControls />}

      {/* Inspector — only in workspace context */}
      {isWorkspace && inspectorOpen && activeInspectorTabId && inspectorTabs.length > 0 && (
        <RightPane
          side={previewOnLeft ? "left" : "right"}
          onMinimize={() => setInspectorVisible(false)}
        >
          {previewOnLeft && <PreviewPaneControls embedded />}
          <InspectorTabs
            tabs={inspectorTabs}
            activeTabId={activeInspectorTabId}
            cwd={activeCwd || undefined}
            sessionId={activeConversationSessionId}
            reserveControls={isConversationRoute}
          />
        </RightPane>
      )}

      {/* Settings dialog — floats above every page, one instance only */}
      <Suspense fallback={null}>
        <SettingsDialog />
      </Suspense>
    </div>
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
      <div className="mb-1 flex h-tool items-center justify-between px-2">
        <span className="text-ui-caption font-medium uppercase tracking-wider text-muted">{t("conversation.sessions")}</span>
        <IconButton
          icon={Plus}
          label={t("conversation.newSession")}
          size="compact"
          onClick={handleNew}
        />
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-2 text-ui-meta italic text-muted/60">{t("conversation.noSessions")}</p>
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
                  "flex h-tool min-w-0 flex-1 items-center gap-2 pr-1 pl-2 text-left text-ui-label",
                  activeSessionId === s.id ? "text-text font-medium" : "text-text/90",
                )}
              >
                <Icon icon={MessageSquare} size="sm" className="shrink-0 text-muted" />
                <span className="truncate flex-1">{s.name === "New Session" ? t("conversation.newSession") : s.name || s.id.slice(0, 8)}</span>
                {(s.updated_at || s.created_at) && (
                  <span className="mr-1 shrink-0 text-ui-micro text-muted/60 group-hover:hidden">
                    {relativeTime(s.updated_at || s.created_at!)}
                  </span>
                )}
              </button>
              <IconButton
                icon={GitFork}
                label="Fork session"
                title={`Fork ${s.name || s.id.slice(0, 8)}`}
                size="compact"
                onClick={(e) => handleFork(e, s.id)}
                className={cn(
                  "hover:bg-accent/10 hover:text-accent",
                  "hidden group-hover:!inline-flex", forking === s.id && "!inline-flex",
                )}
              />
              <IconButton
                icon={Trash2}
                label="Delete session"
                title={`Delete ${s.name || s.id.slice(0, 8)}`}
                size="compact"
                onClick={(e) => handleDelete(e, s.id)}
                className={cn(
                  "mr-0.5 hover:bg-error/10 hover:text-error",
                  "hidden group-hover:!inline-flex", deleting === s.id && "!inline-flex",
                )}
              />
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
function CollapsedNavItem({ to, icon, label }: { to: string; icon: LucideIcon; label: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname.startsWith(to) && to !== "/";
  return (
    <IconButton
      icon={icon}
      label={label}
      size="standard"
      onClick={() => navigate(to)}
      className={cn(
        active && "text-accent",
      )}
    />
  );
}

function SidebarNavItem({ to, label, icon, active, badge }: { to: string; label: string; icon?: LucideIcon; active: boolean; badge?: number }) {
  const navigate = useNavigate();
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  return (
    <button
      onClick={() => {
        navigate(to);
        if (window.innerWidth < 768) setSidebarCollapsed(true);
      }}
      className={cn(
        "flex h-nav min-h-0 w-full items-center gap-1.5 rounded-input px-2 text-left text-ui-label",
        active ? "bg-surface-2 text-text font-medium" : "text-text/90 hover:bg-surface-2 hover:text-text",
      )}
    >
      {icon && <Icon icon={icon} size="md" className="shrink-0 text-muted" />}
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
      <IconButton icon={Settings} label={t("nav.settings")} size="standard" onClick={handleClick} className={cn(settingsOpen && "text-accent")} />
    );
  }
  return (
    <button onClick={handleClick} className={cn("flex h-nav min-h-0 w-full items-center gap-1.5 rounded-input px-2 text-left text-ui-label", settingsOpen ? "bg-surface-2 font-medium text-text" : "text-text/90 hover:bg-surface-2 hover:text-text")}>
      <Icon icon={Settings} size="md" className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">{t("nav.settings")}</span>
    </button>
  );
}

function KnowledgeNavItem({ cwd, active }: { cwd: string; active: boolean }) {
  const { t } = useTranslation();
  const { data } = usePendingProposalCount(cwd);
  return <SidebarNavItem to={`/workspace/${encodeURIComponent(cwd)}/knowledge`} label={t("nav.knowledge")} icon={Inbox} active={active} badge={Number(data?.pending_count) || 0} />;
}
