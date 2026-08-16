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
    const activePanel = screen.getByRole("tabpanel");
    expect(within(activePanel).getByRole("banner")).toHaveClass("h-9");
    expect(within(activePanel).queryByRole("button", { name: "Close" })).toBeNull();
    expect(within(activePanel).queryByRole("button", { name: "Open" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "one.txt" }));
    expect(screen.getByRole("tab", { name: "one.txt" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Close one.txt" }));
    expect(screen.queryByRole("tab", { name: "one.txt" })).toBeNull();
    expect(useUiStore.getState().activeInspectorTabId).toBe(inspectorTabId(second));
  });

  it("reserves fixed control space and keeps tab content at a stable height", () => {
    const first = file("one.txt");
    const second = file("two.txt");
    useUiStore.getState().openInspector(first);
    useUiStore.getState().openInspector(second);
    const tabs = useUiStore.getState().inspectorTabs;
    render(<InspectorTabs tabs={tabs} activeTabId={inspectorTabId(second)} cwd="project" reserveControls />);

    const tablist = screen.getByRole("tablist", { name: "Open file previews" });
    expect(tablist.parentElement).toHaveClass("h-11", "bg-surface");
    expect(tablist.parentElement).not.toHaveClass("mr-14");
    expect(tablist).toHaveClass("h-11", "overflow-x-auto", "overflow-y-hidden", "[scrollbar-width:none]");
    expect(tablist.firstElementChild).toHaveClass("h-11", "w-max", "min-w-full", "pr-14");
    const activeTabContainer = screen.getByRole("tab", { name: "two.txt" }).parentElement;
    expect(activeTabContainer).toHaveClass("h-full");
    expect(screen.getByRole("tab", { name: "two.txt" })).toHaveClass("text-ui-label");
    expect(activeTabContainer).not.toHaveClass("focus-within:ring-2", "focus-within:ring-accent");
  });

  it("uses a regular vertical mouse wheel to scroll overflowing tabs horizontally", () => {
    const tabs = [file("one.txt"), file("two.txt")].map((data) => ({ id: inspectorTabId(data), data }));
    render(<InspectorTabs tabs={tabs} activeTabId={tabs[0].id} cwd="project" />);

    const tablist = screen.getByRole("tablist", { name: "Open file previews" });
    Object.defineProperties(tablist, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 400 },
    });
    fireEvent.wheel(tablist, { deltaY: 60 });

    expect(tablist.scrollLeft).toBe(60);
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

  it("opens the active preview in a 92% viewport dialog and restores it", () => {
    useUiStore.getState().openInspector(file("two.txt"));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));

    const dialog = screen.getByRole("dialog", { name: "two.txt" });
    expect(dialog).toHaveStyle({ width: "92vw", height: "92vh", left: "4vw", top: "4vh" });
    expect(dialog.previousElementSibling).toHaveClass("bg-black/50");
    expect(dialog.previousElementSibling).not.toHaveClass("backdrop-blur-sm");
    expect(screen.getByRole("button", { name: "Restore panel" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "two.txt" })).toBeNull();
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  it("moves focus into the expanded dialog and restores it on close", () => {
    useUiStore.getState().openInspector(file("two.txt"));
    render(<Harness />);
    const maximize = screen.getByRole("button", { name: "Maximize panel" });
    // jsdom does not move focus during fireEvent.click; a real click focuses
    // the trigger, which is exactly what the restore path relies on.
    maximize.focus();
    fireEvent.click(maximize);

    const dialog = screen.getByRole("dialog", { name: "two.txt" });
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "two.txt" })).toBeNull();
    expect(document.activeElement).toBe(maximize);
  });

  it("traps Tab inside the expanded dialog", () => {
    useUiStore.getState().openInspector(file("two.txt"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));

    const dialog = screen.getByRole("dialog", { name: "two.txt" });
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ));
    expect(focusables.length).toBeGreaterThan(0);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("zooms expanded preview content with controls and Ctrl+wheel", () => {
    useUiStore.getState().openInspector(file("two.txt"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));

    const header = within(screen.getByRole("dialog", { name: "two.txt" })).getByRole("banner");
    const zoomGroup = screen.getByRole("button", { name: "Reset zoom to 100%" }).parentElement;
    const editButton = within(header).getByRole("button", { name: "Edit file" });
    const historyButton = within(header).getByRole("button", { name: "Version history" });
    const maximizeButton = within(header).getByRole("button", { name: "Restore panel" });
    for (const button of [editButton, historyButton, maximizeButton]) {
      expect(button).toHaveClass("h-icon", "w-icon", "rounded-input", "text-text");
    }
    expect(Array.from(header.children).indexOf(zoomGroup as Element)).toBeLessThan(
      Array.from(header.children).indexOf(editButton),
    );

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Reset zoom to 100%" })).toHaveTextContent("110%");

    fireEvent.click(screen.getByRole("button", { name: "Reset zoom to 100%" }));
    expect(screen.getByRole("button", { name: "Reset zoom to 100%" })).toHaveTextContent("100%");

    fireEvent.wheel(screen.getByRole("dialog", { name: "two.txt" }), { ctrlKey: true, deltaY: -100 });
    expect(screen.getByRole("button", { name: "Reset zoom to 100%" })).toHaveTextContent("122%");
  });
});
