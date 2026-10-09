import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { PanelLeft, Settings, Plus, Activity, MessageSquare, FolderOpen, ArrowLeft, FileText, Inbox, FlaskConical, type LucideIcon } from "lucide-react";
import { useUiStore } from "../../lib/ui";
import { RightPane } from "../../components/inspector/RightPane";
import { PreviewPaneControls } from "../../components/inspector/PreviewPaneControls";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { SidebarMainArea } from "../../components/sidebar/SidebarMainArea";
import { WorkspaceSessionList } from "../../components/sidebar/WorkspaceSessionList";
import { useNewWorkspaceConversation } from "../../components/sidebar/workspace-navigation";
export { WorkspaceSessionList } from "../../components/sidebar/WorkspaceSessionList";
import { useWorkspaceCwd } from "../../lib/workspace";
import { usePendingProposalCount } from "../../lib/knowledge";
import { cn } from "../../lib/ui";
import { preloadSettingsContent } from "../../components/settings/settings-loading";

// The settings bundle (dialog + tabs) only loads on first open.
const SettingsDialog = lazy(() => import("../../components/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));

type InspectorTabsModule = { default: typeof import("../../components/inspector/InspectorTabs").InspectorTabs };

const INSPECTOR_LOAD_TIMEOUT_MS = 15_000;
let inspectorTabsModule: Promise<InspectorTabsModule> | null = null;

function loadInspectorTabs(): Promise<InspectorTabsModule> {
  if (!inspectorTabsModule) {
    const moduleRequest = import("../../components/inspector/InspectorTabs")
      .then((module) => ({ default: module.InspectorTabs }));
    inspectorTabsModule = new Promise<InspectorTabsModule>((resolve, reject) => {
      const timeoutId = window.setTimeout(
        () => reject(new Error("Preview module load timed out")),
        INSPECTOR_LOAD_TIMEOUT_MS,
      );
      void moduleRequest.then(
        (module) => {
          window.clearTimeout(timeoutId);
          resolve(module);
        },
        (error: unknown) => {
          window.clearTimeout(timeoutId);
          reject(error);
        },
      );
    })
      .catch((error: unknown) => {
        // Do not permanently cache a rejected chunk request. A fresh lazy
        // component can retry it from the preview's local error state.
        inspectorTabsModule = null;
        throw error;
      });
  }
  return inspectorTabsModule;
}

const InitialInspectorTabs = lazy(loadInspectorTabs);
import { useTranslation } from "react-i18next";
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
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const [LazyInspectorTabs, setLazyInspectorTabs] = useState(() => InitialInspectorTabs);
  const [inspectorLoadAttempt, setInspectorLoadAttempt] = useState(0);
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarDragWidthRef = useRef<number | null>(null);
  const location = useLocation();
  const activeCwd = useWorkspaceCwd();
  const isWorkspace = !!activeCwd;
  const newConversation = useNewWorkspaceConversation(activeCwd);
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

  // Start fetching the preview shell as soon as a workspace opens. File
  // clicks can then render immediately instead of paying for the whole
  // inspector module graph while showing an indefinite generic spinner.
  useEffect(() => {
    if (!isWorkspace) return;
    void loadInspectorTabs().catch(() => undefined);
  }, [isWorkspace]);

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
      <a href="#main-content" className="fixed left-3 top-3 z-[200] -translate-y-20 rounded-input bg-accent-fill px-3 py-2 text-sm text-accent-fg transition-transform focus:translate-y-0">
        {t("common.skipToContent", { defaultValue: "Skip to content" })}
      </a>
      {/* Sidebar */}
      {sidebarCollapsed && (
        <aside className="app-sidebar rail-enter flex h-full w-[var(--sidebar-collapsed-width)] shrink-0 flex-col items-center gap-1.5 overflow-hidden border-r border-border px-1.5 py-[18px]">
          <IconButton
            icon={PanelLeft}
            label={t("shell.expandSidebar")}
            size="standard"
            className="h-11 w-11"
            onClick={() => setSidebarCollapsed(false)}
          />
          {/* Icon-only nav */}
          <CollapsedNavItem to="/" icon={isWorkspace ? ArrowLeft : FolderOpen} label={t("nav.projects")} />
          {isWorkspace && (
            <>
              <IconButton icon={Plus} label={t("conversation.newSession")} size="standard" className="h-11 w-11" onClick={newConversation} />
              <CollapsedNavItem to={workspaceRoot} icon={MessageSquare} label={t("sidebar.conversations")} />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/files`} icon={FileText} label={t("nav.files")} />
              <CollapsedNavItem to={`/workspace/${encodeURIComponent(activeCwd!)}/knowledge`} icon={Inbox} label={t("nav.knowledge")} />
              <CollapsedNavItem to={`${workspaceRoot}/research`} icon={FlaskConical} label={t("nav.research")} />
              <CollapsedNavItem to={`${workspaceRoot}/runs`} icon={Activity} label={t("sidebar.runs")} />
            </>
          )}
          <div className="flex-1" />
          <SettingsNavItem cwd={activeCwd} collapsed />
        </aside>
      )}
        <button type="button" aria-label={t("shell.closeSidebar")} onClick={() => setSidebarCollapsed(true)} hidden={sidebarCollapsed} className="fixed inset-0 z-20 bg-black/45 md:hidden" />
        <aside hidden={sidebarCollapsed} className={cn(sidebarCollapsed && "!hidden", "app-sidebar sidebar-enter absolute z-30 flex h-full shrink-0 flex-col overflow-hidden border-r border-border md:relative")} style={{ width: sidebarDragWidth ?? sidebarWidth, maxWidth: "86vw" }}>
          <div className="flex h-full flex-col px-panel py-card">
            {/* Header */}
            <div className="mb-card flex shrink-0 items-center justify-between px-2">
              <h1 className="text-ui-title font-semibold tracking-tight text-text">
                Pi-Science
              </h1>
              <IconButton
                icon={PanelLeft}
                label={t("shell.closeSidebar")}
                size="touch"
                className="translate-x-1"
                onClick={() => setSidebarCollapsed(true)}
              />
            </div>

            {/* Projects / Back to workspace list */}
            <nav className="mb-2 flex shrink-0 flex-col gap-px">
              <SidebarNavItem
                to="/"
                label={isWorkspace ? (workspacePathLeaf(activeCwd!) || t("nav.projects")) : t("nav.projects")}
                icon={isWorkspace ? ArrowLeft : FolderOpen}
                active={false}
              />
            </nav>
            {isWorkspace && <SidebarMainArea key={activeCwd!} cwd={activeCwd!} renderSessions={query => <WorkspaceSessionList cwd={activeCwd!} query={query} />} />}
            {isWorkspace && <nav className="mt-2 shrink-0 border-t border-faint pt-2">
              <KnowledgeNavItem cwd={activeCwd!} active={location.pathname.endsWith("/knowledge")} />
              <SidebarNavItem to={`${workspaceRoot}/research`} label={t("nav.research")} icon={FlaskConical} active={location.pathname.endsWith("/research")} />
              <SidebarNavItem to={`${workspaceRoot}/runs`} label={t("sidebar.runs")} icon={Activity} active={location.pathname.endsWith("/runs")} />
            </nav>}

            {/* Bottom */}
            <div className="mt-auto shrink-0">
              <div className="my-panel border-t border-faint" />
              <div className="mt-2">
                <SettingsNavItem cwd={activeCwd} />
              </div>
            </div>
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("shell.resizeSidebar")}
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

      {/* Main */}
      <main id="main-content" tabIndex={-1} className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden [container-type:inline-size]",
        sidebarCollapsed && "pt-12 md:pt-0",
        inspectorMaximized && "hidden",
        previewOnLeft && "order-2",
      )}>
        <Outlet />
      </main>

      {isConversationRoute && !inspectorOpen && <PreviewPaneControls />}

      {/* Inspector — only in workspace context */}
      {isWorkspace && inspectorOpen && activeInspectorTabId && inspectorTabs.length > 0 && (
        <RightPane
          side={previewOnLeft ? "left" : "right"}
          onMinimize={() => setInspectorVisible(false)}
        >
          <ErrorBoundary
            key={inspectorLoadAttempt}
            fallback={(
              <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
                <p>{t("errors.somethingWentWrong")}</p>
                <button
                  type="button"
                  className="rounded-input bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-surface"
                  onClick={() => {
                    inspectorTabsModule = null;
                    setLazyInspectorTabs(() => lazy(loadInspectorTabs));
                    setInspectorLoadAttempt((attempt) => attempt + 1);
                  }}
                >
                  {t("common.tryAgain")}
                </button>
              </div>
            )}
          >
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted">{t("inspector.loading")}</div>}>
              <LazyInspectorTabs
                tabs={inspectorTabs}
                activeTabId={activeInspectorTabId}
                cwd={activeCwd || undefined}
                sessionId={activeConversationSessionId}
                reserveControls={isConversationRoute}
              />
            </Suspense>
          </ErrorBoundary>
        </RightPane>
      )}

      {/* Settings dialog — floats above every page, one instance only */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      )}
    </div>
  );
}

/* ── Workspace Session List ── */

/** Icon-only nav item for the collapsed sidebar strip. */
function CollapsedNavItem({ to, icon, label }: { to: string; icon: LucideIcon; label: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = to !== "/" && (location.pathname === to || (icon === MessageSquare && location.pathname.startsWith(`${to}/session/`)));
  return (
    <IconButton
      icon={icon}
      label={label}
      size="standard"
      onClick={() => navigate(to)}
      className={cn("h-11 w-11", active && "bg-surface-selected text-accent")}
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
        "flex h-nav min-h-0 w-full items-center gap-1.5 rounded-input px-2 text-left text-ui-label transition-colors",
        active ? "bg-surface-selected font-medium text-text" : "text-text/90 hover:bg-surface-hover hover:text-text",
      )}
    >
      {icon && <Icon icon={icon} size="md" className="shrink-0 text-muted" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-accent-fill px-1.5 py-0.5 text-[10px] leading-none text-accent-fg">{badge}</span>}
    </button>
  );
}

export function SettingsNavItem({ cwd, collapsed = false }: { cwd: string | null; collapsed?: boolean }) {
  const { t } = useTranslation();
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const openSettings = useUiStore((s) => s.openSettings);
  const handleClick = () => {
    preloadSettingsContent();
    openSettings(cwd);
    if (window.innerWidth < 768) useUiStore.getState().setSidebarCollapsed(true);
  };

  if (collapsed) {
    return (
      <IconButton icon={Settings} label={t("nav.settings")} size="standard" onClick={handleClick} onPointerEnter={preloadSettingsContent} onFocus={preloadSettingsContent} className={cn("h-11 w-11", settingsOpen && "bg-surface-selected text-accent")} />
    );
  }
  return (
    <button onClick={handleClick} onPointerEnter={preloadSettingsContent} onFocus={preloadSettingsContent} className={cn("flex h-nav min-h-0 w-full items-center gap-1.5 rounded-input px-2 text-left text-ui-label transition-colors", settingsOpen ? "bg-surface-selected font-medium text-text" : "text-text/90 hover:bg-surface-hover hover:text-text")}>
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
