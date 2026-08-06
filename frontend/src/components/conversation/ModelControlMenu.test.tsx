import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { ModelControlMenu } from "./ModelControlMenu";

const model = {
  id: "test:model",
  provider: "test",
  model: "model",
  label: "Model",
  context_window: 100_000,
};

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
});
