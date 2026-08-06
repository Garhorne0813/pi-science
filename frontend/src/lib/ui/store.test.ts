import { beforeEach, describe, expect, it } from "vitest";
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
