import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextManagementSection } from "./ContextManagementSection";
import i18n from "../../i18n";
import type { SettingsConfig } from "../../lib/settings";

const config: SettingsConfig = { api_keys: {}, model: "lab/one", thinking: "high", providers: [], custom_providers: [], compaction_enabled: true, compaction_threshold_percent: 85, available_models: [{ id: "lab/one", provider: "lab", model: "one", label: "One", custom: true, reasoning: true, thinking_levels: ["high"], context_window: 128000, capability_source: "runtime" }] };
beforeAll(async () => { await i18n.changeLanguage("en"); });

describe("context settings drafts", () => {
  it("previews a changed threshold and persists only after Save", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<ContextManagementSection config={config} saving={false} onSave={onSave} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "95" } });
    expect(screen.getByText("121,600 tokens")).toBeInTheDocument();
    expect(screen.getByText("6,400 tokens")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save context settings" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(true, 95));
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
  });
  it("keeps a failed draft retryable and never reports success", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce(undefined);
    render(<ContextManagementSection config={config} saving={false} onSave={onSave} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save context settings" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Settings saved")).not.toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save context settings" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save context settings" }));
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    expect(onSave).toHaveBeenLastCalledWith(false, 85);
  });
});
