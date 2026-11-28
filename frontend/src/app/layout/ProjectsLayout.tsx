import { Outlet, useLocation } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useUiStore } from "../../lib/ui";
import { RightPane } from "../../components/inspector/RightPane";
import { PreviewPaneControls } from "../../components/inspector/PreviewPaneControls";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { WorkspaceProjectSwitcher } from "../../components/sidebar/WorkspaceProjectSwitcher";
import { useWorkspaceCwd } from "../../lib/workspace";
import { cn } from "../../lib/ui";
import { ChevronsLeft, PanelLeftOpen } from "lucide-react";
import { IconButton } from "../../components/ui/Icon";
import { NARROW_MEDIA_QUERY, isNarrowViewport } from "../../lib/ui/viewport";

// Load workspace-only tabs and menus without adding them to the initial page graph.
const SidebarMainArea = lazy(() => import("../../components/sidebar/SidebarMainArea").then(module => ({ default: module.SidebarMainArea })));
const PreviewFileTreePane = lazy(() => import("../../components/inspector/PreviewFileTreePane").then(module => ({ default: module.PreviewFileTreePane })));

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
import { conversationSessionId } from "../../lib/conversation/session-route";
import { rememberLastConversation } from "../../lib/conversation/last-conversation";

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
  const fileTreeOpen = useUiStore((s) => s.fileTreeOpen);
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
  const headerLinkRef = useRef<HTMLDivElement | null>(null);
  const focusBeforeExplicitExpand = useRef<HTMLButtonElement | null>(null);
  const focusBeforeExplicitClose = useRef<{ element: Element | null } | null>(null);
  const [narrowViewport, setNarrowViewport] = useState(isNarrowViewport);
  const location = useLocation();
  const activeCwd = useWorkspaceCwd();
  const isWorkspace = !!activeCwd;
  const isProjectsHome = !isWorkspace && location.pathname === "/";
  const drawerOpen = isWorkspace && narrowViewport && !contextPanelCollapsed;
  const workspaceRoot = activeCwd ? `/workspace/${encodeURIComponent(activeCwd)}` : "";
  const activeConversationSessionId = conversationSessionId(location.pathname);
  useEffect(() => {
    if (activeCwd && activeConversationSessionId) rememberLastConversation(activeCwd, activeConversationSessionId);
  }, [activeConversationSessionId, activeCwd]);
  const isConversationRoute = isWorkspace && (
    location.pathname === workspaceRoot || location.pathname === `${workspaceRoot}/new` || location.pathname.startsWith(`${workspaceRoot}/session/`)
  );
  const previewOnLeft = isConversationRoute && previewPaneSide === "left";
  const hasActivePreview = !!activeInspectorTabId && inspectorTabs.length > 0;
  const showFileTree = isConversationRoute && fileTreeOpen;
  const showPreviewPane = isWorkspace && inspectorOpen && (showFileTree || hasActivePreview);
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

  const expandContextPanel = useCallback((trigger: HTMLButtonElement) => {
    focusBeforeExplicitExpand.current = document.activeElement === trigger ? trigger : null;
    setContextPanelCollapsed(false);
  }, [setContextPanelCollapsed]);

  const closeContextPanel = useCallback(() => {
    focusBeforeExplicitClose.current = { element: document.activeElement };
    setContextPanelCollapsed(true);
  }, [setContextPanelCollapsed]);

  useEffect(() => {
    if (drawerOpen) panelRef.current?.focus();
    if (!contextPanelCollapsed) {
      const trigger = focusBeforeExplicitExpand.current;
      focusBeforeExplicitExpand.current = null;
      if (!drawerOpen && trigger && (document.activeElement === trigger || document.activeElement === document.body)) {
        headerLinkRef.current?.focus();
      }
      return;
    }
    const pending = focusBeforeExplicitClose.current;
    focusBeforeExplicitClose.current = null;
    // Restore only after an explicit close, and preserve focus if another
    // control has already claimed it before this effect runs.
    if (pending && (document.activeElement === pending.element || document.activeElement === document.body)) {
      toggleRef.current?.focus();
    }
  }, [drawerOpen, contextPanelCollapsed]);

  useEffect(() => {
    if (!drawerOpen) return;
    // Listen on window, not document: a modal dialog (the delete confirmation,
    // Settings) registers its own window-level Escape handler and calls
    // preventDefault. Registration order then puts the dialog first, and this
    // handler skips an Escape the dialog already consumed instead of closing
    // the drawer out from under it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeContextPanel(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, closeContextPanel]);

  return (
    <div className="relative flex h-dvh w-screen overflow-hidden bg-bg text-text">
      <a href="#main-content" inert={drawerOpen} aria-hidden={drawerOpen || undefined} className="fixed left-3 top-3 z-[200] -translate-y-20 rounded-input bg-accent-fill px-3 py-2 text-sm text-accent-fg transition-transform focus:translate-y-0">
        {t("common.skipToContent", { defaultValue: "Skip to content" })}
      </a>
      {/* The project workbench is full-width; workspace routes retain navigation. */}
      {!isProjectsHome && isWorkspace && <>
        {contextPanelCollapsed && <div data-workspace-sidebar-toggle-slot className="relative h-full w-12 shrink-0">
          <button ref={toggleRef} type="button" aria-label={t("shell.expandContextPanel")} title={t("shell.expandContextPanel")} aria-controls="workspace-context-panel" aria-expanded={false} onClick={event => expandContextPanel(event.currentTarget)} className="absolute left-2 top-1.5 z-40 flex h-8 w-8 items-center justify-center rounded-input text-muted hover:bg-surface-hover hover:text-text"><PanelLeftOpen size={18} /></button>
        </div>}
        <div data-context-panel-shade aria-hidden="true" hidden={!drawerOpen} onPointerDown={closeContextPanel} onMouseDown={(event) => event.preventDefault()} className={cn(!drawerOpen && "!hidden", "absolute inset-0 z-50 bg-black/45 md:hidden")} />
        <aside ref={panelRef} tabIndex={-1} id="workspace-context-panel" aria-label={t("sidebar.workspaceContent")} hidden={contextPanelCollapsed} className={cn(contextPanelCollapsed && "!hidden", "app-sidebar sidebar-enter absolute inset-y-0 left-0 z-[60] flex h-full shrink-0 flex-col overflow-hidden border-r border-faint md:relative md:z-auto")} style={{ width: sidebarDragWidth ?? sidebarWidth, maxWidth: "min(88vw, 420px)" }}>
          <div className="flex h-full min-h-0 flex-col px-panel py-card">
            <header className="mb-2 flex shrink-0 items-center gap-1">
              <div ref={headerLinkRef} tabIndex={-1} className="flex min-w-0 flex-1"><WorkspaceProjectSwitcher cwd={activeCwd} /></div>
              <IconButton icon={ChevronsLeft} label={t("shell.collapseContextPanel")} title={t("shell.collapseContextPanel")} aria-controls="workspace-context-panel" aria-expanded={!contextPanelCollapsed} onClick={closeContextPanel} />
            </header>
            <Suspense fallback={<div role="status" className="min-h-0 flex-1 p-2 text-ui-label text-muted">{t("inspector.loading")}</div>}><SidebarMainArea key={activeCwd} cwd={activeCwd} /></Suspense>
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

      {isConversationRoute && !inspectorOpen && <PreviewPaneControls inert={drawerOpen} showFileTreeToggle />}

      {/* Inspector — only in workspace context */}
      {showPreviewPane && (
        <RightPane
          inert={drawerOpen}
          side={previewOnLeft ? "left" : "right"}
          onMinimize={() => setInspectorVisible(false)}
        >
          <div className="relative flex h-full min-w-0 overflow-hidden">
            {showFileTree && activeCwd && (
              <Suspense fallback={<div className="flex h-full flex-1 items-center justify-center text-sm text-muted">{t("inspector.loading")}</div>}>
                <PreviewFileTreePane cwd={activeCwd} conversationKey={activeConversationSessionId} split={hasActivePreview} />
              </Suspense>
            )}
            {hasActivePreview && activeInspectorTabId && (
              <div className="h-full min-w-0 flex-1">
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
                      showFileTreeToggle={isConversationRoute}
                    />
                  </Suspense>
                </ErrorBoundary>
              </div>
            )}
          </div>
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
