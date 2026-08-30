import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AIModelsTab } from "./AIModelsTab";
import { queryClient } from "../../../lib/client/query-client";
import i18n from "../../../i18n";
import type { SettingsConfig } from "../../../lib/settings";

const config: SettingsConfig = {
  api_keys: {},
  model: "anthropic/claude-sonnet-4-6",
  thinking: "high",
  providers: [
    { id: "anthropic", name: "Anthropic", models: ["anthropic/claude-sonnet-4-6"], has_key: true, credential_status: "configured", enabled: true },
    { id: "openai", name: "OpenAI", models: ["openai/gpt-5"], has_key: false, credential_status: "needs_key", enabled: false },
  ],
  custom_providers: [],
  available_models: [
    { id: "anthropic/claude-sonnet-4-6", provider: "anthropic", model: "claude-sonnet-4-6", label: "Anthropic · Claude Sonnet 4.6", custom: false, reasoning: true, thinking_levels: ["low", "medium", "high"], capability_source: "catalog", context_window: 200000, max_output_tokens: 64000 },
  ],
  compaction_enabled: true,
  compaction_threshold_percent: 85,
};

function renderTab(overrides: Partial<React.ComponentProps<typeof AIModelsTab>> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AIModelsTab
        config={config}
        apiKeyInput={{}}
        setApiKeyInput={vi.fn()}
        showKey={{}}
        setShowKey={vi.fn()}
        saving={null}
        saveKey={vi.fn()}
        deleteKey={vi.fn()}
        onConfigReload={vi.fn(async () => undefined)}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => queryClient.clear());
afterEach(() => queryClient.clear());

describe("AIModelsTab", () => {
  it("shows connected services and model capabilities without runtime controls", () => {
    renderTab();
    expect(screen.getByText("Models available to Pi")).toBeInTheDocument();
    expect(screen.getByText("Connected services")).toBeInTheDocument();
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    expect(screen.getByText("Input format")).toBeInTheDocument();
    expect(screen.getByText("Max output")).toBeInTheDocument();
    expect(screen.getAllByText("Text").length).toBeGreaterThan(0);
    expect(screen.getByText("200K")).toBeInTheDocument();
    expect(screen.getByText("64K")).toBeInTheDocument();
    expect(screen.queryByText("Default model")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking Level")).not.toBeInTheDocument();
    expect(screen.queryByText("Context Management")).not.toBeInTheDocument();
  });

  it("keeps model rows as readable, non-clickable inventory rows", () => {
    renderTab();
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Claude Sonnet 4.6" })).not.toBeInTheDocument();
  });

  it("shows migrated custom-provider models from canonical user resource IDs", () => {
    renderTab({
      config: {
        ...config,
        providers: [],
        custom_providers: [{ id: "local-gpu", name: "Local GPU", base_url: "http://localhost:8000/v1", api: "openai-completions", models: ["Qwen/Qwen3-32B"], has_key: true }],
        available_models: [{ ...config.available_models[0], id: "user-local-gpu/Qwen/Qwen3-32B", provider: "user-local-gpu", model: "Qwen/Qwen3-32B", label: "Local GPU · Qwen3 32B" }],
      },
    });
    expect(screen.getAllByText("Local GPU").length).toBeGreaterThan(0);
    expect(screen.getByText("Qwen3 32B")).toBeInTheDocument();
  });

  it("keeps new providers behind the header Connect action", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "+ Connect" }));
    expect(screen.getByRole("dialog", { name: "Connect a model service" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.getByText("OpenAI-compatible service")).toBeInTheDocument();
    expect(screen.queryByText("API key configured")).not.toBeInTheDocument();
  });
});
