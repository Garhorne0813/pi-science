import { Link, Outlet, useLocation } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { useUiStore } from "../../lib/ui";
import { RightPane } from "../../components/inspector/RightPane";
import { PreviewPaneControls } from "../../components/inspector/PreviewPaneControls";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { WorkspaceRail } from "../../components/sidebar/WorkspaceRail";
import { useWorkspaceCwd } from "../../lib/workspace";
import { cn } from "../../lib/ui";
import { NARROW_MEDIA_QUERY, isNarrowViewport } from "../../lib/ui/viewport";

// Load workspace-only tabs and menus without adding them to the initial page graph.
const SidebarMainArea = lazy(() => import("../../components/sidebar/SidebarMainArea").then(module => ({ default: module.SidebarMainArea })));

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
import { conversationSessionId } from "../../lib/conversation/session-route";

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;

export function ProjectsLayout() {
  const { t } = useTranslation();
  const contextPanelCollapsed = useUiStore((s) => s.contextPanelCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const previewPaneSide = useUiStore((s) => s.previewPaneSide);
  const setContextPanelCollapsed = useUiStore((s) => s.setContextPanelCollapsed);
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
  const panelRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const drawerWasOpen = useRef(false);
  const [narrowViewport, setNarrowViewport] = useState(isNarrowViewport);
  const location = useLocation();
  const activeCwd = useWorkspaceCwd();
  const isWorkspace = !!activeCwd;
  const isProjectsHome = !isWorkspace && location.pathname === "/";
  const drawerOpen = isWorkspace && narrowViewport && !contextPanelCollapsed;
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
    const narrow = window.matchMedia(NARROW_MEDIA_QUERY);
    const collapseOnNarrow = (event: MediaQueryListEvent | MediaQueryList) => {
      setNarrowViewport(event.matches);
      if (event.matches) setContextPanelCollapsed(true);
    };
    collapseOnNarrow(narrow);
    narrow.addEventListener("change", collapseOnNarrow);
    return () => narrow.removeEventListener("change", collapseOnNarrow);
  }, [setContextPanelCollapsed]);

  useEffect(() => {
    if (isNarrowViewport()) setContextPanelCollapsed(true);
  }, [location.pathname, setContextPanelCollapsed]);

  useEffect(() => {
    if (drawerOpen) panelRef.current?.focus();
    else if (drawerWasOpen.current) toggleRef.current?.focus();
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    // Listen on window, not document: a modal dialog (the delete confirmation,
    // Settings) registers its own window-level Escape handler and calls
    // preventDefault. Registration order then puts the dialog first, and this
    // handler skips an Escape the dialog already consumed instead of closing
    // the drawer out from under it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); setContextPanelCollapsed(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, setContextPanelCollapsed]);

  return (
    <div className="relative flex h-dvh w-screen overflow-hidden bg-bg text-text">
      <a href="#main-content" inert={drawerOpen} aria-hidden={drawerOpen || undefined} className="fixed left-3 top-3 z-[200] -translate-y-20 rounded-input bg-accent-fill px-3 py-2 text-sm text-accent-fg transition-transform focus:translate-y-0">
        {t("common.skipToContent", { defaultValue: "Skip to content" })}
      </a>
      {/* The project workbench is full-width; workspace routes retain navigation. */}
      {!isProjectsHome && <>
        <WorkspaceRail cwd={activeCwd} toggleRef={toggleRef} />
        <div data-context-panel-shade aria-hidden="true" hidden={!drawerOpen} onPointerDown={() => setContextPanelCollapsed(true)} onMouseDown={(event) => event.preventDefault()} className={cn(!drawerOpen && "!hidden", "absolute inset-y-0 left-[var(--rail-width-mobile)] right-0 z-50 bg-black/45 md:hidden")} />
        <aside ref={panelRef} tabIndex={-1} id="workspace-context-panel" aria-label={t("sidebar.workspaceContent")} hidden={contextPanelCollapsed || !isWorkspace} className={cn((contextPanelCollapsed || !isWorkspace) && "!hidden", "app-sidebar sidebar-enter absolute inset-y-0 left-[var(--rail-width-mobile)] z-[60] flex h-full shrink-0 flex-col overflow-hidden border-r border-faint md:relative md:left-auto md:z-auto")} style={{ width: sidebarDragWidth ?? sidebarWidth, maxWidth: "calc(100vw - var(--rail-width-mobile))" }}>
          <div className="flex h-full min-h-0 flex-col px-panel py-card">
            <header className="mb-2 shrink-0 px-2 py-1">
              <Link to="/" title={activeCwd ? workspacePathLeaf(activeCwd) : t("nav.projects")} className="flex min-w-0 flex-col text-text">
                <span className="text-[18px] font-semibold leading-6 tracking-[-0.03em]">pi-science</span>
                <span className="truncate text-xs font-normal leading-4 text-muted">{activeCwd ? workspacePathLeaf(activeCwd) : t("nav.projects")}</span>
              </Link>
            </header>
            {isWorkspace && <Suspense fallback={<div role="status" className="min-h-0 flex-1 p-2 text-ui-label text-muted">{t("inspector.loading")}</div>}><SidebarMainArea key={activeCwd!} cwd={activeCwd!} /></Suspense>}
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
      </>}

      {/* Main */}
      <main id="main-content" tabIndex={-1} inert={drawerOpen} aria-hidden={drawerOpen || undefined} className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden [container-type:inline-size]",
        inspectorMaximized && "hidden",
        previewOnLeft && "order-2",
      )}>
        <Outlet />
      </main>

      {isConversationRoute && !inspectorOpen && <PreviewPaneControls inert={drawerOpen} />}

      {/* Inspector — only in workspace context */}
      {isWorkspace && inspectorOpen && activeInspectorTabId && inspectorTabs.length > 0 && (
        <RightPane
          inert={drawerOpen}
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
