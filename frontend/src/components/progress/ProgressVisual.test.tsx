import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { defaultProgressAppearance } from "@pi-science/contracts";
import { ProgressVisual } from "./ProgressVisual";
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
});

describe("ProgressTab", () => {
  it("loads the saved config into the local progress store", () => {
    render(<ProgressTab config={config} saving={false} onSave={vi.fn(async () => undefined)} />);
    expect(getProgressAppearance().patterns.currentActivity).toBe("inline-signal");
    expect(screen.getByText("Built-in patterns")).toBeInTheDocument();
  });
});
