import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { defaultProgressAppearance } from "@pi-science/contracts";
import { ProgressVisual, ProgressVisualErrorBoundary } from "./ProgressVisual";
import { normalizeProgressAppearance, PROGRESS_PATTERN_CATALOG, patternsForSlot } from "./ProgressPatternCatalog";
import { getProgressAppearance, setProgressAppearance } from "./progress-settings-store";
import { ProgressTab } from "../settings/ProgressTab";
import type { SettingsConfig } from "../../lib/settings";
import i18n from "../../i18n";

const config = { progress_appearance: structuredClone(defaultProgressAppearance) } as SettingsConfig;

beforeEach(async () => {
  setProgressAppearance(defaultProgressAppearance);
  await i18n.changeLanguage("en");
});

describe("ProgressVisual", () => {
  it("renders a static completion mark", () => {
    render(<ProgressVisual slot="completed" config={defaultProgressAppearance} state="completed" />);
    expect(document.querySelector(".lucide-check")).toBeInTheDocument();
  });

  it("renders a bundled inline pattern without a network dependency", () => {
    const { container } = render(<ProgressVisual slot="currentActivity" config={defaultProgressAppearance} text="Reviewing" />);
    expect(container.firstChild).toBeTruthy();
  });

  it("exposes every bundled loader family", () => {
    expect(patternsForSlot("currentActivity")).toHaveLength(40);
    expect(patternsForSlot("streamingAnswer")).toHaveLength(16);
    expect(patternsForSlot("imageGeneration")).toHaveLength(9);
    expect(PROGRESS_PATTERN_CATALOG).toHaveLength(66);
  });
  it("renders an internalized AICSS orb", () => {
    const config = { ...defaultProgressAppearance, patterns: { ...defaultProgressAppearance.patterns, currentActivity: "aicss-orb-S1" as const } };
    render(<ProgressVisual slot="currentActivity" config={config} text="Working" />);
    // The glyph is decorative next to the localized status text: it must not
    // announce an internal English task name to assistive technology.
    expect(document.querySelector('[data-orb-variant] [aria-hidden="true"]')).toBeInTheDocument();
  });
  it("forwards the speed setting to the orb", () => {
    const config = { ...defaultProgressAppearance, speed: 2 };
    render(<ProgressVisual slot="thinking" config={config} text="Thinking" />);
    const glyph = document.querySelector('[data-orb-variant] [aria-hidden="true"]');
    expect(glyph).toBeInTheDocument();
    expect(glyph?.getAttribute("style")).toContain("--orb-speed: 2");
  });
  it("selects the semantic orb for the current activity", () => {
    const { rerender } = render(<ProgressVisual slot="currentActivity" config={defaultProgressAppearance} activityState="explore" text="Reviewing" />);
    expect(document.querySelector('[data-orb-variant="S4"]')).toHaveStyle({ "--orb-fg": "var(--accent)" });
    rerender(<ProgressVisual slot="currentActivity" config={defaultProgressAppearance} activityState="verify" text="Verifying" />);
    expect(document.querySelector('[data-orb-variant="C5"]')).toBeInTheDocument();
  });

  it("falls back to semantic auto for old text-only settings", () => {
    const normalized = normalizeProgressAppearance({ ...defaultProgressAppearance, patterns: { ...defaultProgressAppearance.patterns, thinking: "text-skeleton" } });
    expect(normalized.patterns.thinking).toBe("aicss-auto");
  });
});

describe("ProgressVisualErrorBoundary", () => {
  it("degrades a throwing animation to the static marker", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function ThrowingLoader(): never {
      throw new Error("chunk failed");
    }
    render(
      <ProgressVisualErrorBoundary>
        <ThrowingLoader />
      </ProgressVisualErrorBoundary>,
    );
    expect(document.querySelector(".rounded-full.bg-accent")).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe("ProgressTab", () => {
  it("loads the saved config into the local progress store", () => {
    render(<ProgressTab config={config} />);
    expect(getProgressAppearance().patterns.currentActivity).toBe("aicss-auto");
    expect(screen.getByText("Built-in patterns")).toBeInTheDocument();
  });
});
