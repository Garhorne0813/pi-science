import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { SettingsNavItem } from "./ProjectsLayout";
import { useUiStore } from "../../lib/ui";
import i18n from "../../i18n";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  useUiStore.setState({ settingsOpen: false, settingsScope: null, });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsNavItem", () => {
  it("opens the dialog with the workspace scope without navigating", () => {
    render(
      <MemoryRouter initialEntries={["/workspace/proj"]}>
        <SettingsNavItem cwd="proj" />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsScope).toBe("proj");
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
  });

  it("opens the dialog with the global scope from the collapsed form", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SettingsNavItem cwd={null} collapsed />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsScope).toBeNull();
  });
});
