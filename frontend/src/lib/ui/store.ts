/** UI Store — theme, locale, sidebar, inspector state.
 *  Ported from open-science's useUiStore. */

import { create } from "zustand";
import type { Inspector } from "../../types/thread";
import i18n from "../../i18n";
import { detectInitialLocale, resolveLocale } from "../../i18n/config";
import type { WorkspaceReference } from "../files";

interface UiState {
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
  locale: string;
  setLocale: (l: string) => void;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setSidebarCollapsed: (c: boolean) => void;
  setSidebarWidth: (w: number) => void;
  /** Which side of the conversation the preview occupies on desktop. */
  previewPaneSide: "left" | "right";
  setPreviewPaneSide: (side: "left" | "right") => void;
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorMaximized: boolean;
  inspectorData: Inspector | null;
  inspectorTabs: InspectorTab[];
  activeInspectorTabId: string | null;
  openInspector: (data: Inspector) => void;
  /** Toggle just the pane visibility, leaving any inspector data untouched
   *  (used by the todo auto-open behaviour). */
  setInspectorOpen: (open: boolean) => void;
  closeInspector: () => void;
  setInspectorVisible: (visible: boolean) => void;
  activateInspectorTab: (id: string) => void;
  closeInspectorTab: (id: string) => void;
  setInspectorWidth: (w: number) => void;
  setInspectorMaximized: (m: boolean) => void;
  workspaceReferences: WorkspaceReference[];
  addWorkspaceReference: (reference: WorkspaceReference) => void;
  removeWorkspaceReference: (cwd: string, path: string) => void;
  clearWorkspaceReferences: (cwd: string) => void;
  settingsOpen: boolean;
  /** Snapshot of the workspace cwd taken when the dialog opened; the dialog
   *  must not follow route changes while it is open (e.g. browser back). */
  settingsScope: string | null;
  openSettings: (scope: string | null) => void;
  closeSettings: () => void;
  /** True right after the active session was deleted (or a new session was
   *  requested): the workspace landing was just navigated to on purpose, so
   *  the session list must not auto-open the most recent session. Consumed
   *  once by the session-list effect; never persisted, never crosses workspaces. */
  suppressAutoSessionNav: boolean;
  setSuppressAutoSessionNav: (v: boolean) => void;
}

export interface InspectorTab {
  id: string;
  data: Inspector;
}

/** A stable identity lets repeated opens focus the existing tab. Version-
 *  targeted opens (lineage relation jumps) get their own tab identity so an
 *  exact version never silently reuses the live-file tab. */
export function inspectorTabId(data: Inspector): string {
  switch (data.variant) {
    case "file":
    case "notebook-file":
      return JSON.stringify([data.variant, data.cwd ?? "", data.root ?? "", data.path, data.variant === "file" && data.artifactVersion ? `${data.artifactVersion.artifact_id}:${data.artifactVersion.version}` : ""]);
    case "pdf":
      return JSON.stringify([data.variant, data.path ?? data.filename ?? ""]);
    case "artifact":
      return JSON.stringify([data.variant, data.filename]);
    case "notebook":
      return JSON.stringify([data.variant, data.notebookId]);
    case "notebook-panel":
      return data.variant;
  }
}

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(`pi-science.${key}`);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`pi-science.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export const useUiStore = create<UiState>((set) => ({
  theme: loadFromStorage<"light" | "dark">("theme", "light"),
  setTheme: (t) => {
    saveToStorage("theme", t);
    document.documentElement.setAttribute("data-theme", t);
    set({ theme: t });
  },

  locale: detectInitialLocale(),
  setLocale: (l) => {
    const locale = resolveLocale(l);
    saveToStorage("locale", locale);
    void i18n.changeLanguage(locale);
    if (typeof document !== "undefined") document.documentElement.lang = locale;
    set({ locale });
  },

  sidebarCollapsed: loadFromStorage("sidebar.collapsed", false),
  sidebarWidth: loadFromStorage("sidebar.width", 260),
  setSidebarCollapsed: (c) => {
    saveToStorage("sidebar.collapsed", c);
    set({ sidebarCollapsed: c });
  },
  setSidebarWidth: (w) => {
    saveToStorage("sidebar.width", w);
    set({ sidebarWidth: w });
  },

  previewPaneSide: loadFromStorage<"left" | "right">("layout.previewPaneSide", "right"),
  setPreviewPaneSide: (side) => {
    saveToStorage("layout.previewPaneSide", side);
    set({ previewPaneSide: side });
  },

  inspectorOpen: false,
  inspectorWidth: loadFromStorage("inspector.width", 420),
  inspectorMaximized: false,
  inspectorData: null,
  inspectorTabs: [],
  activeInspectorTabId: null,
  openInspector: (data) => set((state) => {
    const id = inspectorTabId(data);
    const currentTabs = state.inspectorTabs;
    const existing = currentTabs.findIndex((tab) => tab.id === id);
    const inspectorTabs = existing === -1
      ? [...currentTabs, { id, data }]
      : currentTabs.map((tab, index) => index === existing ? { ...tab, data } : tab);
    return {
      inspectorOpen: true,
      inspectorData: data,
      inspectorTabs,
      activeInspectorTabId: id,
    };
  }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  closeInspector: () => set({
    inspectorOpen: false,
    inspectorMaximized: false,
    inspectorData: null,
    inspectorTabs: [],
    activeInspectorTabId: null,
  }),
  setInspectorVisible: (visible) => set((state) => {
    if (!visible) return { inspectorOpen: false, inspectorMaximized: false };
    if (state.inspectorTabs.length === 0 || !state.activeInspectorTabId) return state;
    const active = state.inspectorTabs.find((tab) => tab.id === state.activeInspectorTabId);
    return {
      inspectorOpen: true,
      inspectorData: active?.data ?? state.inspectorData,
    };
  }),
  activateInspectorTab: (id) => set((state) => {
    const tab = state.inspectorTabs.find((item) => item.id === id);
    if (!tab) return state;
    return { inspectorOpen: true, inspectorData: tab.data, activeInspectorTabId: id };
  }),
  closeInspectorTab: (id) => set((state) => {
    const closingIndex = state.inspectorTabs.findIndex((tab) => tab.id === id);
    if (closingIndex === -1) return state;
    const inspectorTabs = state.inspectorTabs.filter((tab) => tab.id !== id);
    if (inspectorTabs.length === 0) {
      return {
        inspectorOpen: false,
        inspectorMaximized: false,
        inspectorData: null,
        inspectorTabs,
        activeInspectorTabId: null,
      };
    }
    if (state.activeInspectorTabId !== id) return { inspectorTabs };
    const nextTab = inspectorTabs[Math.min(closingIndex, inspectorTabs.length - 1)];
    return {
      inspectorTabs,
      activeInspectorTabId: nextTab.id,
      inspectorData: nextTab.data,
    };
  }),
  setInspectorWidth: (w) => {
    saveToStorage("inspector.width", w);
    set({ inspectorWidth: w });
  },
  setInspectorMaximized: (m) => set({ inspectorMaximized: m }),

  workspaceReferences: [],
  addWorkspaceReference: (reference) => set((state) => ({
    workspaceReferences: state.workspaceReferences.some((item) => item.cwd === reference.cwd && item.path === reference.path)
      ? state.workspaceReferences
      : [...state.workspaceReferences, reference],
  })),
  removeWorkspaceReference: (cwd, path) => set((state) => ({
    workspaceReferences: state.workspaceReferences.filter((item) => item.cwd !== cwd || item.path !== path),
  })),
  clearWorkspaceReferences: (cwd) => set((state) => ({
    workspaceReferences: state.workspaceReferences.filter((item) => item.cwd !== cwd),
  })),

  settingsOpen: false,
  settingsScope: null,
  openSettings: (scope) => set({ settingsOpen: true, settingsScope: scope }),
  closeSettings: () => set({ settingsOpen: false }),

  suppressAutoSessionNav: false,
  setSuppressAutoSessionNav: (v) => set({ suppressAutoSessionNav: v }),
}));

// Re-export for RightPane compatibility
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 800;
