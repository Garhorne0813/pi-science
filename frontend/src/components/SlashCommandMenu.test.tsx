import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { useUiStore } from "../lib/store";

function renderMenu() {
  const onDismiss = vi.fn();
  const onSelect = vi.fn();
  render(
    <div>
      <SlashCommandMenu input="/model" onSelect={onSelect} onDismiss={onDismiss} />
    </div>,
  );
  return { onDismiss, onSelect };
}

beforeEach(() => {
  cleanup();
  useUiStore.setState({ settingsOpen: false });
});

afterEach(() => {
  cleanup();
});

describe("SlashCommandMenu", () => {
  it("dismisses on Escape while closed", () => {
    const { onDismiss } = renderMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
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
});
