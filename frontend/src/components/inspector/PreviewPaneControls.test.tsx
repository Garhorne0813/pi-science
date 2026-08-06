import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PreviewPaneControls } from "./PreviewPaneControls";
import { useUiStore } from "@/lib/ui";
import i18n from "@/i18n";

const file = {
  variant: "file" as const,
  path: "report.md",
  filename: "report.md",
  cwd: "project",
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  useUiStore.getState().closeInspector();
});

describe("PreviewPaneControls", () => {
  it("keeps the visibility toggle last and preserves tabs while hidden", () => {
    useUiStore.getState().openInspector(file);
    render(<PreviewPaneControls />);

    const hide = screen.getByRole("button", { name: "Hide preview panel" });
    const controls = hide.parentElement!;
    expect(controls).toHaveClass("fixed", "right-4", "h-9");
    expect(controls.lastElementChild).toBe(hide);

    fireEvent.click(hide);
    expect(useUiStore.getState().inspectorOpen).toBe(false);
    expect(useUiStore.getState().inspectorTabs).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Expand panel" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show preview panel" }));
    expect(useUiStore.getState().inspectorOpen).toBe(true);
  });

  it("expands and restores the preview while keeping the visibility toggle fixed", () => {
    useUiStore.getState().openInspector(file);
    render(<PreviewPaneControls />);

    const toggle = screen.getByRole("button", { name: "Hide preview panel" });
    fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
    expect(useUiStore.getState().inspectorMaximized).toBe(true);
    expect(screen.getByRole("button", { name: "Restore panel width" })).toBeTruthy();
    expect(toggle.parentElement?.lastElementChild).toBe(toggle);

    fireEvent.click(screen.getByRole("button", { name: "Restore panel width" }));
    expect(useUiStore.getState().inspectorMaximized).toBe(false);
  });
});
