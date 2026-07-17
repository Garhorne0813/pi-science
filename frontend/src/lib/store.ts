/** UI Store — theme, locale, sidebar, inspector state.
 *  Ported from open-science's useUiStore. */

import { create } from "zustand";
import type { Inspector } from "../types/thread";
import i18n from "../i18n";
import { detectInitialLocale, resolveLocale } from "../i18n/config";

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
  closeInspector: () => void;
  setInspectorWidth: (w: number) => void;
  setInspectorMaximized: (m: boolean) => void;
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
  closeInspector: () => set({ inspectorOpen: false, inspectorData: null }),
  setInspectorWidth: (w) => {
    saveToStorage("inspector.width", w);
    set({ inspectorWidth: w });
  },
  setInspectorMaximized: (m) => set({ inspectorMaximized: m }),
}));

// Re-export for RightPane compatibility
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 800;
export function useOverlayTitlebar(): boolean {
  return false; // Web doesn't have macOS traffic lights
}
