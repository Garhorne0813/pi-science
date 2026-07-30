/** UI Store — theme, locale, sidebar, inspector state.
 *  Ported from open-science's useUiStore. */

import { create } from "zustand";
import type { Inspector } from "../types/thread";
import i18n from "../i18n";
import { detectInitialLocale, resolveLocale } from "../i18n/config";
import type { WorkspaceReference } from "./file-references";

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
  inspectorTabs: Inspector[];
  activeInspectorIndex: number;
  inspectorData: Inspector | null;
  openInspector: (data: Inspector) => void;
  closeInspector: () => void;
  closeInspectorTab: (index: number) => void;
  setActiveInspector: (index: number) => void;
  setInspectorWidth: (w: number) => void;
  setInspectorMaximized: (m: boolean) => void;
  workspaceReferences: WorkspaceReference[];
  addWorkspaceReference: (reference: WorkspaceReference) => void;
  removeWorkspaceReference: (cwd: string, path: string) => void;
  clearWorkspaceReferences: (cwd: string) => void;
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
  inspectorTabs: [],
  activeInspectorIndex: 0,
  get inspectorData() { return this.inspectorTabs[this.activeInspectorIndex] ?? null; },
  openInspector: (data) => set((state) => {
    const existing = state.inspectorTabs.findIndex((tab) => tabKey(tab) === tabKey(data));
    if (existing >= 0) return { inspectorOpen: true, activeInspectorIndex: existing };
    return { inspectorOpen: true, inspectorTabs: [...state.inspectorTabs, data], activeInspectorIndex: state.inspectorTabs.length };
  }),
  closeInspector: () => set({ inspectorOpen: false }),
  closeInspectorTab: (index) => set((state) => {
    const tabs = state.inspectorTabs.filter((_, i) => i !== index);
    if (tabs.length === 0) return { inspectorOpen: false, inspectorTabs: [], activeInspectorIndex: 0 };
    const next = Math.min(index, tabs.length - 1);
    return { inspectorTabs: tabs, activeInspectorIndex: next };
  }),
  setActiveInspector: (index) => set({ activeInspectorIndex: index }),
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
}));

function tabKey(tab: Inspector): string {
  if (tab.variant === "file" || tab.variant === "notebook-file") return `${tab.variant}:${tab.path}`;
  if (tab.variant === "artifact") return `${tab.variant}:${tab.title}`;
  if (tab.variant === "pdf") return `${tab.variant}:${tab.path ?? tab.url}`;
  return `${tab.variant}:${JSON.stringify(tab).slice(0, 80)}`;
}

// Re-export for RightPane compatibility
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 800;
