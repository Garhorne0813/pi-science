import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreviewInspector } from "../../types/thread";
import { inspectorTabId, useUiStore } from "./store";

function file(path: string, content?: string): FilePreviewInspector {
  return {
    variant: "file",
    path,
    filename: path.split("/").pop() || path,
    cwd: "project",
    root: "workspace",
    content,
  };
}

beforeEach(() => {
  useUiStore.getState().closeInspector();
});

describe("inspector tabs", () => {
  it("opens files in separate tabs and activates the newest one", () => {
    const first = file("results/one.txt");
    const second = file("results/two.txt");

    useUiStore.getState().openInspector(first);
    useUiStore.getState().openInspector(second);

    const state = useUiStore.getState();
    expect(state.inspectorTabs.map((tab) => tab.data)).toEqual([first, second]);
    expect(state.activeInspectorTabId).toBe(inspectorTabId(second));
    expect(state.inspectorData).toEqual(second);
  });

  it("focuses and refreshes an existing tab instead of duplicating it", () => {
    const first = file("one.txt");
    const second = file("two.txt");
    useUiStore.getState().openInspector(first);
    useUiStore.getState().openInspector(second);

    const refreshedFirst = file("one.txt", "new inline content");
    useUiStore.getState().openInspector(refreshedFirst);

    const state = useUiStore.getState();
    expect(state.inspectorTabs).toHaveLength(2);
    expect(state.activeInspectorTabId).toBe(inspectorTabId(first));
    expect(state.inspectorData).toEqual(refreshedFirst);
    expect(state.inspectorTabs[0].data).toEqual(refreshedFirst);
  });

  it("keeps the active tab when a background tab closes", () => {
    const first = file("one.txt");
    const second = file("two.txt");
    useUiStore.getState().openInspector(first);
    useUiStore.getState().openInspector(second);

    useUiStore.getState().closeInspectorTab(inspectorTabId(first));

    const state = useUiStore.getState();
    expect(state.inspectorTabs).toHaveLength(1);
    expect(state.activeInspectorTabId).toBe(inspectorTabId(second));
    expect(state.inspectorData).toEqual(second);
  });

  it("activates the neighboring tab and closes the pane after the final tab", () => {
    const first = file("one.txt");
    const second = file("two.txt");
    const third = file("three.txt");
    useUiStore.getState().openInspector(first);
    useUiStore.getState().openInspector(second);
    useUiStore.getState().openInspector(third);
    useUiStore.getState().activateInspectorTab(inspectorTabId(second));

    useUiStore.getState().closeInspectorTab(inspectorTabId(second));
    expect(useUiStore.getState().activeInspectorTabId).toBe(inspectorTabId(third));

    useUiStore.getState().closeInspectorTab(inspectorTabId(third));
    expect(useUiStore.getState().activeInspectorTabId).toBe(inspectorTabId(first));

    useUiStore.getState().closeInspectorTab(inspectorTabId(first));
    expect(useUiStore.getState()).toMatchObject({
      inspectorOpen: false,
      inspectorData: null,
      inspectorTabs: [],
      activeInspectorTabId: null,
    });
  });

  it("uses cwd and root as part of a file tab identity", () => {
    const workspaceFile = file("same.txt");
    const otherProject = { ...workspaceFile, cwd: "another-project" };
    const baseFile = { ...workspaceFile, root: "base" as const };

    expect(new Set([
      inspectorTabId(workspaceFile),
      inspectorTabId(otherProject),
      inspectorTabId(baseFile),
    ])).toHaveLength(3);
  });

  it("hides and restores the inspector without discarding open tabs", () => {
    const preview = file("report.md");
    useUiStore.getState().openInspector(preview);
    useUiStore.getState().setInspectorMaximized(true);

    useUiStore.getState().setInspectorVisible(false);
    expect(useUiStore.getState()).toMatchObject({
      inspectorOpen: false,
      inspectorMaximized: false,
      inspectorTabs: [{ data: preview }],
    });

    useUiStore.getState().setInspectorVisible(true);
    expect(useUiStore.getState()).toMatchObject({ inspectorOpen: true, inspectorData: preview });
  });
});

describe("theme system mode", () => {
  // jsdom has no matchMedia; install a single controllable fake for the whole
  // block. The store attaches its OS-scheme listener once per module load, so
  // the fake must stay reachable across tests (drive state through the
  // dispatch helper instead of re-stubbing).
  const controller: { currentDark: boolean; listener: (() => void) | null } = { currentDark: false, listener: null };
  let media: MediaQueryList;

  beforeAll(() => {
    media = {
      get matches() { return controller.currentDark; },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => { controller.listener = cb; },
      removeEventListener: () => { controller.listener = null; },
      addListener: (cb: () => void) => { controller.listener = cb; },
      removeListener: () => { controller.listener = null; },
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", () => media);
  });

  function switchOsScheme(dark: boolean) {
    controller.currentDark = dark;
    controller.listener?.();
  }

  it("follows the OS scheme while in system mode", () => {
    controller.currentDark = false;
    useUiStore.getState().setTheme("system");

    expect(useUiStore.getState().theme).toBe("system");
    expect(JSON.parse(localStorage.getItem("pi-science.theme") ?? "")).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    switchOsScheme(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(useUiStore.getState().theme).toBe("system");
  });

  it("stops following the OS scheme after switching to a fixed theme", () => {
    controller.currentDark = true;
    useUiStore.getState().setTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    useUiStore.getState().setTheme("light");
    expect(useUiStore.getState().theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // An OS change after leaving system mode must not repaint the document.
    switchOsScheme(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("locale system mode", () => {
  afterEach(() => {
    Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
  });

  it("resolves the browser language and keeps following languagechange", () => {
    Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
    useUiStore.getState().setLocale("system");

    expect(useUiStore.getState().locale).toBe("system");
    expect(JSON.parse(localStorage.getItem("pi-science.locale") ?? "")).toBe("system");
    expect(document.documentElement.lang).toBe("zh-Hans");

    // The browser language changes at runtime; the app must re-resolve.
    Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
    window.dispatchEvent(new Event("languagechange"));
    expect(document.documentElement.lang).toBe("en");
  });

  it("still applies a concrete locale after using system mode", () => {
    useUiStore.getState().setLocale("system");
    useUiStore.getState().setLocale("zh-Hans");

    expect(useUiStore.getState().locale).toBe("zh-Hans");
    expect(JSON.parse(localStorage.getItem("pi-science.locale") ?? "")).toBe("zh-Hans");
    expect(document.documentElement.lang).toBe("zh-Hans");
  });
});
