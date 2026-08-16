import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

afterEach(cleanup);

describe("SettingsSelectMenu", () => {
  it("opens the menu above the settings dialog (portal z-index above the z-[95] overlay)", async () => {
    render(
      <SettingsSelectMenu
        value="light"
        options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
        onSelect={vi.fn()}
        ariaLabel="Appearance"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Appearance: Light" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveClass("z-[110]");
  });

  it("shows the selected value, marks it with a check, and calls onSelect with the picked value", async () => {
    const onSelect = vi.fn();
    render(
      <SettingsSelectMenu
        value="light"
        options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
        onSelect={onSelect}
        ariaLabel="Appearance"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Appearance: Light" });
    expect(trigger).toHaveTextContent("Light");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const current = await screen.findByRole("menuitemradio", { name: "Light" });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(current.querySelector("svg")).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(onSelect).toHaveBeenCalledWith("dark");
  });

  it("field variant renders the full-width bordered trigger", () => {
    render(
      <SettingsSelectMenu
        variant="field"
        value="a"
        options={[{ value: "a", label: "A" }]}
        onSelect={vi.fn()}
        ariaLabel="Field"
      />,
    );
    expect(screen.getByRole("button", { name: "Field: A" })).toHaveClass("w-full", "border");
  });

  it("compact variant renders the fixed-height inline trigger (no full-width field sizing)", () => {
    render(
      <SettingsSelectMenu
        variant="compact"
        value="a"
        options={[{ value: "a", label: "A" }]}
        onSelect={vi.fn()}
        ariaLabel="Compact"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Compact: A" });
    expect(trigger).toHaveClass("h-8", "w-auto");
    expect(trigger).not.toHaveClass("h-10", "w-full");
  });

  it("caps the menu height to the viewport and scrolls long lists", async () => {
    const options = Array.from({ length: 30 }, (_, index) => ({ value: `m${index}`, label: `Model ${index}` }));
    render(
      <SettingsSelectMenu
        value="m0"
        options={options}
        onSelect={vi.fn()}
        ariaLabel="Default model"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Default model: Model 0" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveClass("max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))]");
    expect(menu).toHaveClass("overflow-y-auto", "overscroll-contain");
  });

  it("searchable menu focuses the filter, filters options, and selects a filtered item", async () => {
    const onSelect = vi.fn();
    render(
      <SettingsSelectMenu
        searchable
        searchPlaceholder="Search models"
        emptyMessage="No matching models"
        value="m2"
        options={[
          { value: "m1", label: "Alpha Model", hint: "alpha" },
          { value: "m2", label: "Beta Model", hint: "beta" },
          { value: "m3", label: "Gamma Model", hint: "gamma" },
        ]}
        onSelect={onSelect}
        ariaLabel="Default model"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Default model: Beta Model" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const search = await screen.findByLabelText("Search models");
    // Radix focuses the menu content first; the component steals focus for the
    // search box right after opening, so wait for that pass instead of racing it.
    await waitFor(() => expect(search).toHaveFocus());
    // The current value stays highlighted with a check while it is visible.
    expect(screen.getByRole("menuitemradio", { name: "Beta Model" })).toHaveClass("bg-accent-soft");
    fireEvent.change(search, { target: { value: "gamma" } });
    expect(screen.getByRole("menuitemradio", { name: "Gamma Model" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Alpha Model" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Gamma Model" }));
    expect(onSelect).toHaveBeenCalledWith("m3");
  });

  it("searchable menu shows an empty state when nothing matches", async () => {
    render(
      <SettingsSelectMenu
        searchable
        searchPlaceholder="Search models"
        emptyMessage="No matching models"
        value="m1"
        options={[{ value: "m1", label: "Alpha Model" }]}
        onSelect={vi.fn()}
        ariaLabel="Default model"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Default model: Alpha Model" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const search = await screen.findByLabelText("Search models");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No matching models")).toBeInTheDocument();
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
  });

  it("disables the trigger and does not open a menu", () => {
    render(
      <SettingsSelectMenu
        value="a"
        options={[{ value: "a", label: "A" }]}
        onSelect={vi.fn()}
        ariaLabel="Disabled"
        disabled
      />,
    );
    const trigger = screen.getByRole("button", { name: "Disabled: A" });
    expect(trigger).toBeDisabled();
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
