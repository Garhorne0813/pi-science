import type { SettingsSection } from "../settings/settings-sections";
/** UI Store — theme, locale, sidebar, inspector state.
 *  Ported from open-science's useUiStore. */

import { create } from "zustand";
import type { Inspector } from "../../types/thread";
import i18n from "../../i18n";
import { detectInitialLocale, detectSystemLocale, resolveLocale } from "../../i18n/config";
import type { WorkspaceReference } from "../files";

export type ThemeChoice = "light" | "dark" | "system";

interface UiState {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  locale: string;
  setLocale: (l: string) => void;
  contextPanelCollapsed: boolean;
  sidebarWidth: number;
  sidebarFileBrowserHeight: number;
  setContextPanelCollapsed: (c: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setSidebarFileBrowserHeight: (height: number) => void;
  /** Which side of the conversation the preview occupies on desktop. */
  previewPaneSide: "left" | "right";
  setPreviewPaneSide: (side: "left" | "right") => void;
  /** Which side of a file preview contains the workspace file tree. */
  previewFileTreeSide: "left" | "right";
  setPreviewFileTreeSide: (side: "left" | "right") => void;
  inspectorOpen: boolean;
  inspectorWidth: number;
  /** Preview share of the desktop viewport. Pixel width remains in state for
   *  rendering and accessibility, while this ratio makes the split responsive
   *  when moving the window between displays. */
  inspectorRatio: number;
  inspectorMaximized: boolean;
  /** Whether the workspace file tree is visible inside the preview pane. */
  fileTreeOpen: boolean;
  /** Width of the file-tree column when it shares the preview pane with a file. */
  previewFileTreeWidth: number;
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
  setInspectorRatio: (ratio: number) => void;
  setInspectorMaximized: (m: boolean) => void;
  setFileTreeOpen: (open: boolean) => void;
  setPreviewFileTreeWidth: (width: number) => void;
  workspaceReferences: WorkspaceReference[];
  addWorkspaceReference: (reference: WorkspaceReference) => void;
  removeWorkspaceReference: (cwd: string, path: string, conversationKey?: string | null) => void;
  clearWorkspaceReferences: (cwd: string, conversationKey?: string | null) => void;
  fileTreeReveal: FileTreeRevealRequest | null;
  revealInFileTree: (cwd: string, path: string) => void;
  clearFileTreeReveal: (id: number) => void;
  settingsOpen: boolean;
  /** Snapshot of the workspace cwd taken when the dialog opened; the dialog
   *  must not follow route changes while it is open (e.g. browser back). */
  settingsScope: string | null;
  settingsSection: SettingsSection;
  openSettings: (scope: string | null, section?: SettingsSection) => void;
  closeSettings: () => void;
  /** True while the preview divider is being dragged. Never persisted — it is
   *  transient interaction state used for drag feedback only. */
  inspectorResizing: boolean;
  setInspectorResizing: (r: boolean) => void;
}

export interface FileTreeRevealRequest {
  id: number;
  cwd: string;
  path: string;
}

let fileTreeRevealSequence = 0;

export interface InspectorTab {
  id: string;
  data: Inspector;
}

/** A stable identity lets repeated opens focus the existing tab. */
export function inspectorTabId(data: Inspector): string {
  switch (data.variant) {
    case "file":
      return JSON.stringify([data.variant, data.cwd ?? "", data.root ?? "", data.path, data.sha256 ?? ""]);
    case "notebook-file":
      return JSON.stringify([data.variant, data.cwd ?? "", data.root ?? "", data.path]);
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

/** The concrete scheme the OS currently reports; light when the API is
 *  unavailable (jsdom, old browsers). */
export function resolveSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Attached once per app lifetime; the handler re-checks the store's current
// theme, so switching away from "system" silently stops the follow behavior.
let themeMedia: MediaQueryList | null = null;
function attachThemeListener() {
  if (themeMedia || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  if (!media) return;
  themeMedia = media;
  const onChange = () => {
    if (useUiStore.getState().theme === "system") {
      document.documentElement.setAttribute("data-theme", resolveSystemTheme());
    }
  };
  // Modern engines use addEventListener; older Safari uses addListener.
  if (typeof media.addEventListener === "function") media.addEventListener("change", onChange);
  else if (typeof media.addListener === "function") media.addListener(onChange);
}

/** Apply a theme choice to the document. "system" tracks the OS scheme
 *  (including live updates); light/dark are applied verbatim. */
export function applyTheme(theme: ThemeChoice) {
  if (theme === "system") {
    attachThemeListener();
    document.documentElement.setAttribute("data-theme", resolveSystemTheme());
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

// Attached once per app lifetime; no-ops unless the store is in system mode.
let localeListenerAttached = false;
function attachLocaleListener() {
  if (localeListenerAttached || typeof window === "undefined") return;
  localeListenerAttached = true;
  window.addEventListener("languagechange", () => {
    if (useUiStore.getState().locale !== "system") return;
    const locale = detectSystemLocale();
    void i18n.changeLanguage(locale);
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  });
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

const DEFAULT_INSPECTOR_RATIO = 0.42;
const initialViewportWidth = typeof window === "undefined" ? 1000 : window.innerWidth;
const storedInspectorRatio = loadFromStorage<unknown>("inspector.ratio", null);
const initialInspectorRatio = typeof storedInspectorRatio === "number"
  && Number.isFinite(storedInspectorRatio)
  && storedInspectorRatio > 0
  && storedInspectorRatio <= 0.7
  ? storedInspectorRatio
  : DEFAULT_INSPECTOR_RATIO;
const initialInspectorWidth = Math.max(280, Math.round(initialViewportWidth * initialInspectorRatio));

export const useUiStore = create<UiState>((set) => ({
  theme: loadFromStorage<ThemeChoice>("theme", "light"),
  setTheme: (t) => {
    saveToStorage("theme", t);
    applyTheme(t);
    set({ theme: t });
  },

  locale: loadFromStorage<string | null>("locale", null) ?? detectInitialLocale(),
  setLocale: (l) => {
    if (l === "system") {
      saveToStorage("locale", "system");
      attachLocaleListener();
      const locale = detectSystemLocale();
      void i18n.changeLanguage(locale);
      if (typeof document !== "undefined") document.documentElement.lang = locale;
      set({ locale: "system" });
      return;
    }
    const locale = resolveLocale(l);
    saveToStorage("locale", locale);
    void i18n.changeLanguage(locale);
    if (typeof document !== "undefined") document.documentElement.lang = locale;
    set({ locale });
  },

  contextPanelCollapsed: loadFromStorage("sidebar.collapsed", false),
  sidebarWidth: loadFromStorage("sidebar.width", 240),
  sidebarFileBrowserHeight: loadFromStorage("sidebar.fileBrowserHeight", 288),
  setContextPanelCollapsed: (c) => {
    saveToStorage("sidebar.collapsed", c);
    set({ contextPanelCollapsed: c });
  },
  setSidebarWidth: (w) => {
    saveToStorage("sidebar.width", w);
    set({ sidebarWidth: w });
  },
  setSidebarFileBrowserHeight: (height) => {
    saveToStorage("sidebar.fileBrowserHeight", height);
    set({ sidebarFileBrowserHeight: height });
  },

  previewPaneSide: loadFromStorage<"left" | "right">("layout.previewPaneSide", "right"),
  setPreviewPaneSide: (side) => {
    saveToStorage("layout.previewPaneSide", side);
    set({ previewPaneSide: side });
  },
  previewFileTreeSide: loadFromStorage<"left" | "right">("layout.previewFileTreeSide", "left"),
  setPreviewFileTreeSide: (side) => {
    saveToStorage("layout.previewFileTreeSide", side);
    set({ previewFileTreeSide: side });
  },

  inspectorOpen: false,
  inspectorWidth: initialInspectorWidth,
  inspectorRatio: initialInspectorRatio,
  inspectorMaximized: false,
  fileTreeOpen: false,
  previewFileTreeWidth: loadFromStorage("inspector.fileTreeWidth", 232),
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
    if ((state.inspectorTabs.length === 0 || !state.activeInspectorTabId) && !state.fileTreeOpen) return state;
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
        inspectorOpen: state.fileTreeOpen,
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
    set({ inspectorWidth: w });
  },
  setInspectorRatio: (ratio) => {
    saveToStorage("inspector.ratio", ratio);
    set({ inspectorRatio: ratio });
  },
  setInspectorMaximized: (m) => set({ inspectorMaximized: m }),
  setFileTreeOpen: (open) => set((state) => ({
    fileTreeOpen: open,
    inspectorOpen: open || state.inspectorTabs.length > 0,
    ...(!open && state.inspectorTabs.length === 0 ? { inspectorMaximized: false } : {}),
  })),
  setPreviewFileTreeWidth: (width) => {
    saveToStorage("inspector.fileTreeWidth", width);
    set({ previewFileTreeWidth: width });
  },

  workspaceReferences: [],
  addWorkspaceReference: (reference) => set((state) => ({
    workspaceReferences: state.workspaceReferences.some((item) => item.cwd === reference.cwd && item.conversationKey === reference.conversationKey && item.path === reference.path)
      ? state.workspaceReferences
      : [...state.workspaceReferences, reference],
  })),
  removeWorkspaceReference: (cwd, path, conversationKey) => set((state) => ({
    workspaceReferences: state.workspaceReferences.filter((item) => item.cwd !== cwd || item.path !== path || (item.conversationKey !== conversationKey && item.conversationKey !== undefined)),
  })),
  clearWorkspaceReferences: (cwd, conversationKey) => set((state) => ({
    workspaceReferences: state.workspaceReferences.filter((item) => item.cwd !== cwd || (item.conversationKey !== conversationKey && item.conversationKey !== undefined)),
  })),
  fileTreeReveal: null,
  revealInFileTree: (cwd, path) => set({
    fileTreeReveal: { id: ++fileTreeRevealSequence, cwd, path },
    fileTreeOpen: true,
    inspectorOpen: true,
  }),
  clearFileTreeReveal: (id) => set((state) => state.fileTreeReveal?.id === id ? { fileTreeReveal: null } : state),

  settingsOpen: false,
  settingsScope: null,
  settingsSection: "general",
  openSettings: (scope, section = "general") => set({ settingsOpen: true, settingsScope: scope, settingsSection: section }),
  closeSettings: () => set({ settingsOpen: false }),

  inspectorResizing: false,
  setInspectorResizing: (r) => set({ inspectorResizing: r }),
}));

export const INSPECTOR_MIN = 280;
