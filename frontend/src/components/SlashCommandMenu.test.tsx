import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { useUiStore } from "../lib/ui";
import { fetchDynamicCommands, resetDynamicCommands } from "../lib/conversation";
import { queryClient } from "../lib/client/query-client";

function renderMenu(input = "/compact") {
  const onDismiss = vi.fn();
  const onSelect = vi.fn();
  render(
    <div>
      <SlashCommandMenu input={input} onSelect={onSelect} onDismiss={onDismiss} />
    </div>,
  );
  return { onDismiss, onSelect };
}

beforeEach(() => {
  cleanup();
  resetDynamicCommands();
  queryClient.clear();
  useUiStore.setState({ settingsOpen: false });
});

afterEach(() => {
  cleanup();
  resetDynamicCommands();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("SlashCommandMenu", () => {
  it("dismisses on Escape while keeping the current input untouched", () => {
    const { onDismiss } = renderMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("dismisses when the pointer lands outside the menu", () => {
    const { onDismiss } = renderMenu();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("never swallows keyboard events while the settings dialog is open", () => {
    const { onDismiss } = renderMenu();
    useUiStore.setState({ settingsOpen: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    useUiStore.setState({ settingsOpen: false });
  });

  it("selects a command with Enter while closed", () => {
    const { onSelect } = renderMenu();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSelect).toHaveBeenCalled();
  });

  it("scrolls the active command into view while navigating", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    renderMenu("/");
    fireEvent.keyDown(window, { key: "ArrowDown" });

    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it("refreshes the menu when dynamic skills finish loading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      commands: [{ name: "skill:review", description: "Review files", source: "skill" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    renderMenu("/");
    expect(screen.queryByText("/skill:review")).not.toBeInTheDocument();

    await act(async () => {
      await fetchDynamicCommands("session-a", "/workspace");
    });

    expect(screen.getByText("/skill:review")).toBeInTheDocument();
  });
});
