import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { ModelControlMenu } from "./ModelControlMenu";

const model = {
  id: "test:model",
  provider: "test",
  model: "model",
  label: "Model",
  context_window: 100_000,
};

const multiModels = [
  { id: "prov1/alpha", provider: "prov1", model: "alpha", label: "Alpha" },
  { id: "prov1/beta", provider: "prov1", model: "beta", label: "Beta" },
  { id: "prov2/gamma", provider: "prov2", model: "gamma", label: "Gamma" },
];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ModelControlMenu", () => {
  it("shows context usage as a proportional ring without visible usage text", () => {
    render(
      <ModelControlMenu
        models={[model]}
        selectedModel={model.id}
        thinking="high"
        thinkingLevels={["high"]}
        contextTokens={25_000}
        contextWindow={100_000}
        contextPercent={25}
        onModelChange={vi.fn()}
        onThinkingChange={vi.fn()}
      />,
    );

    const ring = screen.getByRole("img", { name: "Context: 25.0K / 100K · 25%" });
    expect(screen.getByRole("button", { name: "Select model and thinking level and view context" })).toHaveClass("h-7", "min-h-0");
    const progress = ring.querySelectorAll("circle")[1];
    expect(progress).toHaveAttribute("stroke-dasharray", "25 100");
    expect(progress).toHaveAttribute("stroke", "var(--accent)");
    expect(screen.queryByText(/25\.0K\/100K/)).toBeNull();
  });

  it("uses the warning color near the compaction threshold", () => {
    render(
      <ModelControlMenu
        models={[model]}
        selectedModel={model.id}
        thinking="high"
        thinkingLevels={["high"]}
        contextTokens={75_000}
        contextWindow={100_000}
        contextPercent={75}
        compactionEnabled
        compactionThresholdPercent={80}
        onModelChange={vi.fn()}
        onThinkingChange={vi.fn()}
      />,
    );

    const ring = screen.getByRole("img", { name: "Context: 75.0K / 100K · 75% · Auto-compaction threshold: 80%" });
    expect(ring.querySelectorAll("circle")[1]).toHaveAttribute("stroke", "var(--warn)");
  });

  it("opens a two-level menu with Model and Effort rows showing current values", async () => {
    render(
      <ModelControlMenu
        models={[model]}
        selectedModel={model.id}
        thinking="high"
        thinkingLevels={["high"]}
        onModelChange={vi.fn()}
        onThinkingChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Select model and thinking level and view context" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    // The root menu floats above the composer card (side=top) and shows the
    // two drill-down rows with the current values and a right chevron.
    expect(menu.getAttribute("data-side")).toBe("top");
    const modelRow = screen.getByRole("menuitem", { name: /Model/ });
    const effortRow = screen.getByRole("menuitem", { name: /Effort/ });
    expect(modelRow.textContent).toContain("model");
    expect(effortRow.textContent).toContain("High");
    expect(menu.querySelectorAll("svg.lucide-chevron-right").length).toBe(2);
  });

  it("groups the model list by provider, filters by search, and calls onModelChange", async () => {
    const onModelChange = vi.fn();
    render(
      <ModelControlMenu
        models={multiModels as typeof model[]}
        selectedModel="prov1/beta"
        thinking="high"
        thinkingLevels={["high"]}
        onModelChange={onModelChange}
        onThinkingChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Select model and thinking level and view context" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /Model/ }));

    const search = await screen.findByLabelText("Search models");
    // Provider group headers are rendered in first-seen order.
    await waitFor(() => {
      expect(screen.getAllByText("prov1").length).toBeGreaterThan(0);
      expect(screen.getAllByText("prov2").length).toBeGreaterThan(0);
    });
    // The current model carries a check indicator.
    const current = screen.getByRole("menuitemradio", { name: "beta" });
    expect(current.querySelector("svg")).not.toBeNull();

    // Search narrows the list across providers.
    fireEvent.change(search, { target: { value: "gamma" } });
    expect(screen.getByRole("menuitemradio", { name: "gamma" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "alpha" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gamma" }));
    expect(onModelChange).toHaveBeenCalledWith("prov2/gamma");
  });

  it("opens the Effort submenu and calls onThinkingChange with the picked level", async () => {
    const onThinkingChange = vi.fn();
    render(
      <ModelControlMenu
        models={[model]}
        selectedModel={model.id}
        thinking="low"
        thinkingLevels={["low", "high"]}
        onModelChange={vi.fn()}
        onThinkingChange={onThinkingChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Select model and thinking level and view context" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /Effort/ }));
    const high = await screen.findByRole("menuitemradio", { name: "High" });
    const low = screen.getByRole("menuitemradio", { name: "Low" });
    expect(low.querySelector("svg")).not.toBeNull(); // current level checked
    fireEvent.click(high);
    expect(onThinkingChange).toHaveBeenCalledWith("high");
  });

  it("caps the submenu height so long lists scroll inside the viewport", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `p/m${index}`, provider: "p", model: `m${index}`, label: `M${index}` }));
    render(
      <ModelControlMenu
        models={many as typeof model[]}
        selectedModel="p/m0"
        thinking="high"
        thinkingLevels={["high"]}
        onModelChange={vi.fn()}
        onThinkingChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Select model and thinking level and view context" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /Model/ }));
    // The submenu portal content is appended after the root menu; the last
    // role=menu element is the model list.
    await waitFor(() => expect(screen.getAllByRole("menu").length).toBeGreaterThan(1));
    const submenu = screen.getAllByRole("menu").at(-1)!;
    const scroller = submenu.querySelector('[class*="max-h-[min(320px"]');
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("overflow-y-auto");
  });
});
