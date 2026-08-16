import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { LLMTab, type LLMTabProps } from "./LLMTab";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";
import type { Provider, SettingsConfig } from "../../lib/settings";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/endpoints")) return jsonResponse({ endpoints: [] });
  return jsonResponse({ error: `unhandled ${url}` }, 404);
});

const baseConfig: SettingsConfig = {
  api_keys: {},
  model: "deepseek/deepseek-v4-flash",
  thinking: "high",
  providers: [{ id: "deepseek", name: "DeepSeek", models: ["deepseek/deepseek-v4-flash"], has_key: true }],
  custom_providers: [],
  available_models: [
    { id: "deepseek/deepseek-v4-flash", provider: "deepseek", model: "DeepSeek V4 Flash", label: "DeepSeek V4 Flash", custom: false, reasoning: true, thinking_levels: ["high", "max"], capability_source: "pi", context_window: 128000 },
  ],
  compaction_enabled: true,
  compaction_threshold_percent: 85,
};

function renderTab(config: SettingsConfig = baseConfig, props: Partial<LLMTabProps> = {}) {
  const saveModel = vi.fn();
  const merged: LLMTabProps = {
    config,
    apiKeyInput: {},
    setApiKeyInput: () => undefined,
    showKey: {},
    setShowKey: () => undefined,
    saving: null,
    saveKey: vi.fn(),
    deleteKey: vi.fn(),
    saveModel,
    saveCompaction: vi.fn(),
    onConfigReload: vi.fn(),
    ...props,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <LLMTab {...merged} />
    </QueryClientProvider>,
  );
  return { saveModel };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LLMTab row dropdowns", () => {
  it("replaces every native settings select with dropdown menu buttons", async () => {
    renderTab();
    const modelTrigger = await screen.findByRole("button", { name: "Default model: DeepSeek V4 Flash" });
    const thinkingTrigger = screen.getByRole("button", { name: "Thinking Level: High" });
    expect(modelTrigger).toHaveTextContent("DeepSeek V4 Flash");
    expect(thinkingTrigger).toHaveTextContent("High");
    // No native comboboxes remain anywhere in the LLM tab: model, thinking,
    // vendor picker and endpoint protocol are all Radix menus now.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Default model" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Thinking Level" })).toBeNull();
  });

  it("opens the model menu with the current model marked and saves the new model", async () => {
    const { saveModel } = renderTab();
    const trigger = screen.getByRole("button", { name: "Default model: DeepSeek V4 Flash" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    const current = screen.getByRole("menuitemradio", { name: "DeepSeek V4 Flash" });
    expect(current).toHaveClass("bg-accent-soft");
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "DeepSeek V4 Flash" }).querySelector("svg")).not.toBeNull();
    fireEvent.click(current);
    // Switching to the same model re-saves it with the clamped thinking level.
    expect(saveModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash", "high");
  });

  it("opens the thinking menu and saves the selected level", async () => {
    const { saveModel } = renderTab();
    const trigger = screen.getByRole("button", { name: "Thinking Level: High" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "High" })).toHaveClass("bg-accent-soft");
    expect(screen.getByRole("menuitemradio", { name: "High" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Max" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Max" }));
    expect(saveModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash", "max");
  });

  it("clamps a stale config thinking level to the selected model's actual options", async () => {
    const { saveModel } = renderTab({
      ...baseConfig,
      thinking: "max",
      available_models: [
        { ...baseConfig.available_models[0], thinking_levels: ["off", "high"] },
      ],
    });
    // "max" is not in the model's options; the trigger must show the clamped
    // level and the menu must only offer the actual options.
    const trigger = await screen.findByRole("button", { name: "Thinking Level: High" });
    expect(trigger).toHaveTextContent("High");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Max" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "High" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    expect(saveModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash", "high");
  });

  it("saves the thinking level clamped to the next model's supported levels", async () => {
    const { saveModel } = renderTab({
      ...baseConfig,
      available_models: [
        { ...baseConfig.available_models[0], id: "deepseek/deepseek-v4-flash", model: "DeepSeek V4 Flash", label: "DeepSeek V4 Flash", thinking_levels: ["off", "max"] },
        { ...baseConfig.available_models[0], id: "deepseek/deepseek-v4-pro", model: "DeepSeek V4 Pro", label: "DeepSeek V4 Pro", thinking_levels: ["off", "high"] },
      ],
    });
    const trigger = await screen.findByRole("button", { name: "Default model: DeepSeek V4 Flash" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "DeepSeek V4 Pro" }));
    // The current thinking "high" is legal on the next model, so it is kept;
    // switching to a model whose levels exclude the value would clamp down.
    expect(saveModel).toHaveBeenCalledWith("deepseek/deepseek-v4-pro", "high");
  });

  it("vendor picker is a dropdown menu that selects a vendor and closes", async () => {
    renderTab({
      ...baseConfig,
      providers: [{ id: "openai", name: "OpenAI", models: ["openai/gpt-5"], has_key: false }],
    });
    fireEvent.click(await screen.findByRole("button", { name: /Add vendor/i }));
    const picker = await screen.findByLabelText(/Choose a vendor/);
    fireEvent.pointerDown(picker);
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "OpenAI" }));
    await waitFor(() => expect(screen.queryByLabelText(/Choose a vendor/)).toBeNull());
  });

  it("splits a 'provider · model' label: short trigger name, provider as menu hint", async () => {
    const { saveModel } = renderTab({
      ...baseConfig,
      available_models: [
        { ...baseConfig.available_models[0], model: "deepseek-v4-flash", label: "deepseek · DeepSeek V4 Flash" },
      ],
    });
    // The trigger accessible name is the short model name only — no duplicated
    // provider prefix, no separator.
    const trigger = await screen.findByRole("button", { name: "Default model: DeepSeek V4 Flash" });
    expect(trigger).toHaveAccessibleName("Default model: DeepSeek V4 Flash");
    expect(trigger).toHaveTextContent("DeepSeek V4 Flash");
    expect(trigger).not.toHaveTextContent("·");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    // The menu item label is the short name; the provider display name is the
    // smaller hint inside the item (aria-hidden, so it does not join the name).
    const item = await screen.findByRole("menuitemradio", { name: "DeepSeek V4 Flash" });
    expect(item).toHaveTextContent("DeepSeek V4 Flash");
    expect(item).toHaveTextContent("deepseek");
    // The full model id is still what gets saved.
    fireEvent.click(item);
    expect(saveModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash", "high");
  });

  it("falls back to the raw model name when the label is empty without a separator", async () => {
    renderTab({
      ...baseConfig,
      available_models: [
        { ...baseConfig.available_models[0], model: "deepseek-v4-flash", label: "" },
      ],
    });
    const trigger = await screen.findByRole("button", { name: "Default model: deepseek-v4-flash" });
    expect(trigger).toHaveTextContent("deepseek-v4-flash");
  });

  it("disables the model menu without configured models and shows the hint", async () => {
    renderTab({ ...baseConfig, model: "", available_models: [] });
    const trigger = await screen.findByRole("button", { name: "Default model: Configure a provider first" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("Configure a provider first");
  });

  it("disables the thinking menu for models without configurable reasoning", async () => {
    renderTab({
      ...baseConfig,
      available_models: [
        { ...baseConfig.available_models[0], reasoning: false, thinking_levels: [] },
      ],
    });
    const trigger = await screen.findByRole("button", { name: "Thinking Level: This model does not expose configurable reasoning." });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("This model does not expose configurable reasoning.");
  });
});

describe("LLMTab dynamic provider inventory", () => {
  const dynamicProvider = (overrides: Partial<Provider>): Provider => ({
    id: "opencode-go",
    name: "OpenCode Go",
    models: ["opencode-go/opencode-go-latest"],
    has_key: false,
    ...overrides,
  });

  /** Stateful harness: the real input state lives in React so the Save button
   *  enables after typing into the API key field. */
  function renderDynamicTab(config: SettingsConfig, props: Partial<LLMTabProps> = {}) {
    const saveKey = props.saveKey ?? vi.fn();
    const deleteKey = props.deleteKey ?? vi.fn();
    function Harness() {
      const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});
      const [showKey, setShowKey] = useState<Record<string, boolean>>({});
      return (
        <QueryClientProvider client={queryClient}>
          <LLMTab
            config={config}
            apiKeyInput={apiKeyInput}
            setApiKeyInput={setApiKeyInput}
            showKey={showKey}
            setShowKey={setShowKey}
            saving={null}
            saveKey={saveKey}
            deleteKey={deleteKey}
            saveModel={vi.fn()}
            saveCompaction={vi.fn()}
            onConfigReload={vi.fn()}
          />
        </QueryClientProvider>
      );
    }
    render(<Harness />);
    return { saveKey, deleteKey };
  }

  function openVendorPicker() {
    fireEvent.click(screen.getByRole("button", { name: /Add vendor/i }));
    const picker = screen.getByLabelText(/Choose a vendor/);
    fireEvent.pointerDown(picker);
    fireEvent.click(picker);
    return picker;
  }

  it("searches the dynamic vendor list and configures an API-key provider (OpenCode Go)", async () => {
    const { saveKey } = renderDynamicTab({
      ...baseConfig,
      providers: [
        dynamicProvider({
          id: "opencode-go",
          name: "OpenCode Go",
          auth: { kind: "api_key", api_key_supported: true, oauth_supported: false, login_supported: false },
          credential_status: "needs_key",
          enabled: false,
        }),
        dynamicProvider({
          id: "opencode",
          name: "OpenCode Zen",
          models: ["opencode/opencode-latest"],
          auth: { kind: "api_key", api_key_supported: true, oauth_supported: false, login_supported: false },
          credential_status: "needs_key",
          enabled: false,
        }),
      ],
    });
    openVendorPicker();
    const search = await screen.findByLabelText("Search providers");
    fireEvent.change(search, { target: { value: "opencode go" } });
    // The provider is findable by search and the auth hint is rendered.
    const item = await screen.findByRole("menuitemradio", { name: "OpenCode Go" });
    expect(item).toHaveTextContent("API key");
    fireEvent.click(item);
    // Selecting the vendor closes the picker and shows the API key form.
    await waitFor(() => expect(screen.queryByLabelText(/Choose a vendor/)).toBeNull());
    const input = await screen.findByLabelText("OpenCode Go API key");
    fireEvent.change(input, { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveKey).toHaveBeenCalledWith("opencode-go");
  });

  it("shows the provider model count for an OAuth-only needs_login provider without a key form", async () => {
    renderTab({
      ...baseConfig,
      providers: [
        dynamicProvider({
          id: "openai-codex",
          name: "OpenAI Codex",
          models: ["gpt-5.1-codex"],
          auth: { kind: "oauth", api_key_supported: false, oauth_supported: true, login_supported: false },
          credential_status: "needs_login",
          enabled: false,
        }),
      ],
    });
    openVendorPicker();
    const item = await screen.findByRole("menuitemradio", { name: "OpenAI Codex" });
    expect(item).toHaveTextContent("OAuth");
    fireEvent.click(item);
    // The row shows the model count and the login-unavailable notice, and no
    // API key input or save button is rendered for an OAuth-only provider.
    expect(await screen.findByText("1 models available")).toBeInTheDocument();
    expect(screen.getByText("Subscription login required")).toBeInTheDocument();
    expect(screen.getByText(/Sign in through Pi Orbit/)).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI Codex API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("keeps the API key form for a mixed api_key_or_oauth provider that needs a key", async () => {
    renderTab({
      ...baseConfig,
      providers: [
        dynamicProvider({
          id: "github-copilot",
          name: "GitHub Copilot",
          models: ["github-copilot/gpt-5.1"],
          auth: { kind: "api_key_or_oauth", api_key_supported: true, oauth_supported: true, login_supported: false },
          credential_status: "needs_key",
          enabled: false,
        }),
      ],
    });
    openVendorPicker();
    const item = await screen.findByRole("menuitemradio", { name: "GitHub Copilot" });
    expect(item).toHaveTextContent("API key or OAuth");
    fireEvent.click(item);
    expect(await screen.findByLabelText("GitHub Copilot API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("shows Connected for configured and OAuth-connected providers and only offers delete for configured keys", async () => {
    const deleteKey = vi.fn();
    renderTab(
      {
        ...baseConfig,
        providers: [
          dynamicProvider({
            id: "deepseek",
            name: "DeepSeek",
            models: ["deepseek/deepseek-v4-flash"],
            has_key: true,
            auth: { kind: "api_key", api_key_supported: true, oauth_supported: false, login_supported: false },
            credential_status: "configured",
            enabled: true,
          }),
          dynamicProvider({
            id: "openai-codex",
            name: "OpenAI Codex",
            models: ["gpt-5.1-codex"],
            auth: { kind: "oauth", api_key_supported: false, oauth_supported: true, login_supported: false },
            credential_status: "connected",
            enabled: true,
          }),
        ],
      },
      { deleteKey },
    );
    const badges = await screen.findAllByText("Connected");
    expect(badges).toHaveLength(2);
    // The configured API-key provider may be removed; the OAuth-connected
    // provider has no Pi-Science key to delete.
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    expect(deleteButtons).toHaveLength(1);
    fireEvent.click(deleteButtons[0]);
    expect(deleteKey).toHaveBeenCalledWith("deepseek");
    expect(screen.queryByLabelText("DeepSeek API key")).toBeNull();
  });

  it("falls back to legacy has_key behavior when the auth fields are absent", async () => {
    const { saveKey } = renderDynamicTab({
      ...baseConfig,
      providers: [{ id: "mistral", name: "Mistral", models: ["mistral/devstral-latest"], has_key: false }],
    });
    openVendorPicker();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mistral" }));
    const input = await screen.findByLabelText("Mistral API key");
    fireEvent.change(input, { target: { value: "sk-legacy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveKey).toHaveBeenCalledWith("mistral");
    // Legacy connected providers keep the existing delete affordance.
    cleanup();
    renderDynamicTab({
      ...baseConfig,
      providers: [{ id: "deepseek", name: "DeepSeek", models: ["deepseek/deepseek-v4-flash"], has_key: true }],
    });
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
