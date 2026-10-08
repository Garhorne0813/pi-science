import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function labConfig(status: "needs_key" | "invalid" | "needs_login" | "configured" = "needs_key", enabled = true): SettingsConfig {
  return { ...config, providers: [{ id: "user-lab", name: "Lab", models: ["model-a"], has_key: status === "configured", credential_status: status, enabled, custom: true,
    auth: { kind: status === "needs_login" ? "oauth" : "api_key", api_key_supported: status !== "needs_login", oauth_supported: status === "needs_login", login_supported: false } }], custom_providers: [], available_models: [] };
}

function connectionApi(failFirstSave = false) {
  let saves = 0;
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown = { ok: true };
    let status = 200;
    if (url === "/api/endpoints") body = { endpoints: [{ id: "endpoint-lab", name: "Lab", base_url: "https://lab.example/v1", protocol: "openai", health: "unknown", credential_ref: null }] };
    else if (url === "/api/provider-endpoint-bindings") body = { bindings: [{ id: "binding-lab", provider_id: "user-lab", endpoint_id: "endpoint-lab" }] };
    else if (method === "PUT" && url === "/api/custom-providers/user-lab" && failFirstSave && ++saves === 1) { status = 500; body = { error: "Repair failed" }; }
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => queryClient.clear());
afterEach(() => { queryClient.clear(); vi.unstubAllGlobals(); });

describe("AIModelsTab", () => {
  it("shows connected services and model capabilities without runtime controls", () => {
    renderTab();
    expect(screen.getByText("Models available to Pi")).toBeInTheDocument();
    expect(screen.getByText("Configured services")).toBeInTheDocument();
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

  it("keeps keyless builtin inventory visible without offering key maintenance", () => {
    renderTab({ config: { ...config, providers: [{ id: "local", name: "Local", models: [], has_key: false, enabled: false, credential_status: "connected", auth: { kind: "none", api_key_supported: false, oauth_supported: false, login_supported: false } }] } });
    expect(screen.getByText("Local")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    expect(screen.queryByRole("menuitem", { name: "Replace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("keeps a rejected builtin key replacement open for retry", async () => {
    const saveKey = vi.fn().mockRejectedValueOnce(new Error("Key save failed")).mockResolvedValue(undefined);
    renderTab({ apiKeyInput: { anthropic: "replacement-key" }, saveKey });
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Replace" }));
    const dialog = screen.getByRole("dialog", { name: "Replace API key" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Key save failed");
    expect(within(dialog).getByLabelText(/Anthropic API key/)).toHaveValue("replacement-key");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Replace API key" })).not.toBeInTheDocument());
    expect(saveKey).toHaveBeenCalledTimes(2);
  });

  it("keeps a rejected builtin connection open for retry", async () => {
    const saveKey = vi.fn().mockRejectedValueOnce(new Error("Connect failed")).mockResolvedValue(undefined);
    renderTab({ apiKeyInput: { openai: "new-key" }, saveKey });
    fireEvent.click(screen.getByRole("button", { name: "+ Connect" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
    const dialog = screen.getByRole("dialog", { name: "+ Connect OpenAI" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Connect failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "+ Connect OpenAI" })).not.toBeInTheDocument());
    expect(saveKey).toHaveBeenCalledTimes(2);
  });

  it("keeps rejected builtin deletion open for retry", async () => {
    const deleteKey = vi.fn().mockRejectedValueOnce(new Error("Delete failed")).mockResolvedValue(undefined);
    renderTab({ deleteKey });
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect service" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Delete failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disconnect service" })).not.toBeInTheDocument());
    expect(deleteKey).toHaveBeenCalledTimes(2);
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
  it("filters models by name and clears an empty search", () => {
    renderTab();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.queryByText("Claude Sonnet 4.6")).not.toBeInTheDocument();
    expect(screen.getByText("No services or models match your search.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sonnet" } });
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Anthropic.*Connected/ }));
    expect(screen.queryByText("Claude Sonnet 4.6")).not.toBeInTheDocument();
  });

  it("marks subscription providers unavailable even when a credential exists", () => {
    renderTab({ config: { ...config, providers: [...config.providers, { id: "subscription", name: "Subscription provider", models: [], has_key: true, credential_status: "connected", auth: { kind: "oauth", api_key_supported: false, oauth_supported: true, login_supported: false } }] } });
    expect(screen.getByRole("heading", { name: "Unavailable services" })).toBeInTheDocument();
    expect(screen.getByText("Subscription provider")).toBeInTheDocument();
    expect(screen.getByText("Login required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Subscription provider/ })).not.toBeInTheDocument();
  });

  it("keeps a custom provider with missing credentials visible and repairs it through the canonical API", async () => {
    const calls = connectionApi();
    const reload = vi.fn(async () => undefined);
    renderTab({ config: labConfig(), onConfigReload: reload });
    expect(screen.getByText("Lab")).toBeInTheDocument();
    expect(screen.getByText("Needs authentication")).toBeInTheDocument();
    expect(screen.getByText("model-a")).toBeInTheDocument();
    expect(screen.getByText("Not currently available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configure connection" }));
    const editor = screen.getByRole("dialog", { name: "Edit connection" });
    const url = within(editor).getByLabelText("Base URL");
    await waitFor(() => expect(url).toHaveValue("https://lab.example/v1"));
    fireEvent.change(url, { target: { value: "https://repaired.example/v1" } });
    const key = within(editor).getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "test-repair-key" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit connection" })).not.toBeInTheDocument());
    expect(calls).toContainEqual({ url: "/api/custom-providers/user-lab", method: "PUT", body: { name: "Lab", base_url: "https://repaired.example/v1", auth: { kind: "api_key", secret: "test-repair-key" } } });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("retains a failed credential repair for retry without clearing the draft", async () => {
    const calls = connectionApi(true);
    renderTab({ config: labConfig("invalid") });
    fireEvent.click(screen.getByRole("button", { name: "Configure connection" }));
    const editor = screen.getByRole("dialog", { name: "Edit connection" });
    await waitFor(() => expect(within(editor).getByLabelText("Base URL")).toHaveValue("https://lab.example/v1"));
    const key = within(editor).getByLabelText("API key");
    fireEvent.change(key, { target: { value: "test-repair-key" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("Repair failed");
    expect(key).toHaveValue("test-repair-key");
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit connection" })).not.toBeInTheDocument());
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(2);
  });

  it("keeps the existing credential when editing only the endpoint", async () => {
    const calls = connectionApi();
    renderTab({ config: labConfig("configured") });
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit connection" }));
    const editor = screen.getByRole("dialog", { name: "Edit connection" });
    await waitFor(() => expect(within(editor).getByLabelText("Base URL")).toHaveValue("https://lab.example/v1"));
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit connection" })).not.toBeInTheDocument());
    expect(calls).toContainEqual({ url: "/api/custom-providers/user-lab", method: "PUT", body: { name: "Lab", base_url: "https://lab.example/v1" } });
  });

  it.each([true, false])("keeps enable/disable and delete actions available (enabled=%s)", async enabled => {
    const calls = connectionApi();
    const reload = vi.fn(async () => undefined);
    renderTab({ config: labConfig("configured", enabled), onConfigReload: reload });
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    expect(screen.getByRole("menuitem", { name: "Edit connection" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: enabled ? "Disable service" : "Enable service" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(calls).toContainEqual({ url: `/api/custom-providers/user-lab/enabled?enabled=${!enabled}`, method: "PUT", body: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Disconnect service" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/custom-providers/user-lab", method: "DELETE", body: undefined }));
  });

  it("keeps an unsupported-login custom provider visible and editable", async () => {
    connectionApi();
    renderTab({ config: labConfig("needs_login") });
    expect(screen.getByText("Lab")).toBeInTheDocument();
    expect(screen.getByText("Login required")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connection settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit connection" }));
    const editor = screen.getByRole("dialog", { name: "Edit connection" });
    await waitFor(() => expect(within(editor).getByLabelText("Base URL")).toHaveValue("https://lab.example/v1"));
    expect(within(editor).queryByLabelText("API key")).not.toBeInTheDocument();
  });

  it("bounds a 10,000-model inventory and finds models beyond the first page", async () => {
    const models = Array.from({ length: 10_000 }, (_, index) => ({ ...config.available_models[0], id: `anthropic/model-${index}`, model: `model-${index}`, label: `Model ${index}` }));
    renderTab({ config: { ...config, providers: [{ ...config.providers[0], models: models.map(model => model.id) }], available_models: models } });
    expect(screen.getByText("Model 0")).toBeInTheDocument();
    expect(screen.queryByText("Model 50")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Model 50")).toBeInTheDocument();
    expect(screen.queryByText("Model 0")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "model-9999" } });
    expect(await screen.findByText("Model 9999")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Model 0")).toBeInTheDocument();
    expect(screen.queryByText("Model 50")).not.toBeInTheDocument();
  });

  it("bounds provider cards without expanding every service on search", async () => {
    const providers = Array.from({ length: 45 }, (_, index) => ({ id: `provider-${index}`, name: `Service ${index}`, models: [`provider-${index}/model`], has_key: true, credential_status: "configured" as const, enabled: true }));
    renderTab({ config: { ...config, providers, available_models: providers.map(provider => ({ ...config.available_models[0], id: `${provider.id}/model`, provider: provider.id, model: "model", label: `Model ${provider.id}` })) } });
    expect(screen.getAllByRole("button", { name: "Connection settings" })).toHaveLength(20);
    expect(screen.getAllByRole("region", { name: /Service \d+ models/ })).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Service" } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Connection settings" })).toHaveLength(20));
    expect(screen.getAllByRole("region", { name: /Service \d+ models/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Service 20")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Service \d+ models/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Service 44" } });
    expect(await screen.findByText("Service 44")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connection settings" })).toHaveLength(1);
  });

});
