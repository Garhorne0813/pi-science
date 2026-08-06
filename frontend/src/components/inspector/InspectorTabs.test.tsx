import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { InspectorTabs } from "./InspectorTabs";
import { inspectorTabId, useUiStore } from "@/lib/ui";
import type { FilePreviewInspector } from "../../types/thread";
import i18n from "../../i18n";

function file(path: string): FilePreviewInspector {
  return {
    variant: "file",
    path,
    filename: path,
    cwd: "project",
    root: "workspace",
    content: `${path} content`,
    language: "plaintext",
  };
}

function Harness() {
  const tabs = useUiStore((state) => state.inspectorTabs);
  const activeTabId = useUiStore((state) => state.activeInspectorTabId);
  if (!activeTabId) return null;
  return <InspectorTabs tabs={tabs} activeTabId={activeTabId} cwd="project" />;
}

beforeEach(async () => {
  useUiStore.getState().closeInspector();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InspectorTabs", () => {
  it("switches and closes file tabs", () => {
    const first = file("one.txt");
    const second = file("two.txt");
    useUiStore.getState().openInspector(first);
    useUiStore.getState().openInspector(second);
    render(<Harness />);

    expect(screen.getByRole("tab", { name: "two.txt" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tabpanel")).queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "one.txt" }));
    expect(screen.getByRole("tab", { name: "one.txt" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close one.txt" }));
    expect(screen.queryByRole("tab", { name: "one.txt" })).toBeNull();
    expect(useUiStore.getState().activeInspectorTabId).toBe(inspectorTabId(second));
  });

  it("keeps an unsaved draft while switching between tabs", async () => {
    const first = file("one.txt");
    const second = file("two.txt");
    useUiStore.getState().openInspector(first);
    useUiStore.getState().openInspector(second);
    useUiStore.getState().activateInspectorTab(inspectorTabId(first));
    render(<Harness />);

    const firstPanel = screen.getByRole("tabpanel");
    fireEvent.click(await within(firstPanel).findByLabelText("Edit file"));
    fireEvent.change(within(firstPanel).getByLabelText("Edit one.txt"), { target: { value: "unsaved draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "two.txt" }));
    fireEvent.click(screen.getByRole("tab", { name: "one.txt" }));

    expect(within(screen.getByRole("tabpanel")).getByLabelText("Edit one.txt")).toHaveValue("unsaved draft");
  });
});
