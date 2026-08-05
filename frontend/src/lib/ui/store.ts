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
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorMaximized: boolean;
  inspectorData: Inspector | null;
  openInspector: (data: Inspector) => void;
  /** Toggle just the pane visibility, leaving any inspector data untouched
   *  (used by the todo auto-open behaviour). */
  setInspectorOpen: (open: boolean) => void;
  closeInspector: () => void;
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
  /** Which todo widget renders: sticky progress bar at the top of the
   *  conversation, or a floating action button in the corner. */
  todoUiMode: "sticky" | "fab";
  setTodoUiMode: (mode: "sticky" | "fab") => void;
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

  inspectorOpen: false,
  inspectorWidth: loadFromStorage("inspector.width", 420),
  inspectorMaximized: false,
  inspectorData: null,
  openInspector: (data) => set({ inspectorOpen: true, inspectorData: data }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  closeInspector: () => set({ inspectorOpen: false, inspectorData: null }),
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

  todoUiMode: loadFromStorage<"sticky" | "fab">("todo.uiMode", "fab"),
  setTodoUiMode: (mode) => {
    saveToStorage("todo.uiMode", mode);
    set({ todoUiMode: mode });
  },

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
