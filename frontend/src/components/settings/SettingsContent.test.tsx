import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SettingsContent } from "./SettingsContent";
import { queryClient } from "../../lib/query-client";
import { useUiStore } from "../../lib/store";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const putCalls: { url: string; body: unknown }[] = [];

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("/api/settings/config")) {
    return Promise.resolve(jsonResponse({
      ok: true,
      providers: [{ id: "deepseek", name: "DeepSeek", has_key: true, models: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" }] }],
      available_models: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", reasoning: true, thinking_levels: ["high", "max"] }],
      model: "",
      thinking: "high",
    }));
  }
  if (url.startsWith("/api/settings/model")) {
    putCalls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("fail")) return Promise.resolve(jsonResponse({ ok: false, error: "boom" }, 500));
    return Promise.resolve(jsonResponse({ ok: true, model: "deepseek/deepseek-v4-flash", thinking: "high" }));
  }
  return Promise.resolve(jsonResponse({ error: `unhandled ${method} ${url}` }, 404));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => defaultFetch(String(input), init));

function renderContent(scope: string | null) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsContent scope={scope} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  putCalls.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
  useUiStore.setState({ settingsOpen: false, settingsScope: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsContent", () => {
  it("loads config and exposes the vertical tablist", async () => {
    renderContent(null);
    const nav = await screen.findByRole("tablist", { name: "Settings" });
    expect(nav).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "General" })).toHaveAttribute("aria-labelledby", "settings-tab-general");
  });

  it("switches tabs and resets aria-selected", async () => {
    renderContent(null);
    await screen.findByRole("tablist", { name: "Settings" });
    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    expect(screen.getByRole("tab", { name: "LLM" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "LLM" })).toHaveAttribute("aria-labelledby", "settings-tab-llm");
    expect(await screen.findByText("Models")).toBeInTheDocument();
  });

  it("supports arrow-key navigation between tabs", async () => {
    renderContent(null);
    const nav = await screen.findByRole("tablist", { name: "Settings" });
    const general = screen.getByRole("tab", { name: "General" });
    general.focus();
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "LLM" })).toHaveAttribute("aria-selected", "true"));
    // Keyboard navigation moves focus into the newly activated tab.
    await waitFor(() => expect(screen.getByRole("tab", { name: "LLM" })).toHaveFocus());
    fireEvent.keyDown(nav, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Compute" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(nav, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(nav, { key: "Home" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true"));
  });

  it("saves the selected model with the workspace scope query", async () => {
    renderContent("proj");
    await screen.findByRole("tablist", { name: "Settings" });
    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    const select = await screen.findByLabelText("Default model");
    const configCallsBefore = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/settings/config")).length;
    fireEvent.change(select, { target: { value: "deepseek/deepseek-v4-flash" } });
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0].url).toContain("?cwd=proj");
    expect(putCalls[0].body).toMatchObject({ model: "deepseek/deepseek-v4-flash", thinking: "high" });
    // The save handler reloads the config (loadConfig) after the PUT.
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/settings/config")).length).toBe(configCallsBefore + 1));
  });

  it("shows a save failure as an alert and keeps the dialog usable", async () => {
    renderContent("proj");
    await screen.findByRole("tablist", { name: "Settings" });
    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    const select = await screen.findByLabelText("Default model");
    // Switch the fetch mock to failing mode for the PUT.
    vi.mocked(fetchMock).mockImplementationOnce(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      return defaultFetch("/api/settings/model?fail=1", init);
    });
    fireEvent.change(select, { target: { value: "deepseek/deepseek-v4-flash" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    // The saving flag resets in finally, so the select is usable again.
    await waitFor(() => expect(select).toBeEnabled());
  });
});
