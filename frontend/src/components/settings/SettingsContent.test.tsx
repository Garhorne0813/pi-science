import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { SettingsContent } from "./SettingsContent";
import { queryClient } from "../../lib/client/query-client";
import { useUiStore } from "../../lib/ui";
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
      available_models: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", model: "DeepSeek V4 Flash", label: "DeepSeek V4 Flash", provider: "deepseek", reasoning: true, thinking_levels: ["high", "max"] }],
      model: "",
      thinking: "high",
    }));
  }
  if (url.startsWith("/api/settings/model")) {
    putCalls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("fail")) return Promise.resolve(jsonResponse({ ok: false, error: "boom" }, 500));
    return Promise.resolve(jsonResponse({ ok: true, model: "deepseek/deepseek-v4-flash", thinking: "high" }));
  }
  if (url.startsWith("/api/settings/subagents?")) return Promise.resolve(jsonResponse({ agents: [{ name: "reviewer", path: ".pi/agents/reviewer.md" }] }));
  if (url === "/api/mcp/connectors") return Promise.resolve(jsonResponse({ connectors: [] }));
  if (url === "/api/settings/skills" || url.startsWith("/api/settings/skills?cwd=")) {
    return Promise.resolve(jsonResponse({
      skills: [{ skill_id: "alpha", name: "alpha", description: "Analyze alpha data", enabled: true, validation: { valid: true } }],
      configured: false,
    }));
  }
  return Promise.resolve(jsonResponse({ error: `unhandled ${method} ${url}` }, 404));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => defaultFetch(String(input), init));

function renderContent(scope: string | null) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <SettingsContent scope={scope} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => defaultFetch(String(input), init));
  putCalls.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
  useUiStore.setState({ settingsOpen: false, settingsScope: null });
  useUiStore.getState().setPreviewPaneSide("right");
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
    const panel = screen.getByRole("tabpanel", { name: "General" });
    expect(panel).toHaveAttribute("aria-labelledby", "settings-tab-general");
    expect(panel.querySelector(":scope > div > div")).toHaveClass("md:px-0");
    expect(panel.querySelector(":scope > div > div")).not.toHaveClass("md:px-6");
  });

  it("marks the active tab with the selected surface and the rest with hover surfaces", async () => {
    renderContent(null);
    const nav = await screen.findByRole("tablist", { name: "Settings" });
    expect(nav).toHaveClass("gap-1");
    const general = screen.getByRole("tab", { name: "General" });
    const models = screen.getByRole("tab", { name: "AI Models" });
    expect(general).toHaveClass("bg-surface-selected");
    expect(models).not.toHaveClass("bg-surface-selected");
    expect(models).toHaveClass("hover:bg-surface-hover");
  });

  it("renders the DeepSeek-style sidebar chrome with distinct outline icons", async () => {
    renderContent(null);
    const nav = await screen.findByRole("tablist", { name: "Settings" });
    const aside = nav.closest("aside");
    if (!aside) throw new Error("settings aside not found");
    // Desktop column is exactly 188px with 12px side padding and 22px top
    // padding; mobile stays a 56px icon rail with 10px side padding.
    expect(aside).toHaveClass("w-14", "px-2.5", "md:w-[188px]", "md:px-3", "md:pt-[22px]", "md:pb-0");
    // A settings heading sits above the list on desktop (hidden on mobile).
    expect(screen.getByRole("heading", { name: "Settings" })).toHaveClass("hidden", "md:block", "text-base", "font-medium");
    // Tabs: 36px circle centered on mobile; 40px full-width rounded row with
    // an 8px icon gap on desktop; no separate icon tile background.
    const general = screen.getByRole("tab", { name: "General" });
    expect(general).toHaveClass("h-9", "w-9", "rounded-full", "md:h-10", "md:w-full", "md:rounded-card", "md:px-3", "md:gap-2");
    expect(general).toHaveClass("bg-surface-selected", "text-text");
    expect(screen.getByRole("tab", { name: "Agent Capabilities" })).toHaveClass("hover:bg-surface-hover");
    expect(screen.getByRole("tab", { name: "Environments" })).toBeInTheDocument();
    // Every nav item uses a different outline icon (distinct svg content).
    const icons = screen.getAllByRole("tab").map((tab) => tab.querySelector("svg")?.innerHTML ?? null);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(9);
  });

  it("moves the close control into the content header, outside the sidebar", async () => {
    renderContent(null);
    const close = await screen.findByLabelText("Close");
    const header = close.closest("header");
    if (!header) throw new Error("close button is not inside a header");
    expect(header).toHaveClass("sticky", "top-0");
    const aside = screen.getByRole("tablist", { name: "Settings" }).closest("aside");
    expect(aside?.contains(close)).toBe(false);
    // 28px circular close button with a hover overlay, matching the DeepSeek
    // panel chrome (content header, not the sidebar).
    expect(close).toHaveClass("h-7", "w-7", "rounded-full", "hover:bg-surface-hover");
  });

  it("persists the selected conversation and preview order", async () => {
    renderContent(null);
    const order = await screen.findByLabelText(/Conversation and preview layout/);

    fireEvent.pointerDown(order);
    fireEvent.click(order);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Preview · Conversation" }));

    expect(useUiStore.getState().previewPaneSide).toBe("left");
    expect(window.localStorage.getItem("pi-science.layout.previewPaneSide")).toBe('"left"');
  });

  it("switches tabs and resets aria-selected", async () => {
    renderContent(null);
    await screen.findByRole("tablist", { name: "Settings" });
    fireEvent.click(screen.getByRole("tab", { name: "AI Models" }));
    expect(screen.getByRole("tab", { name: "AI Models" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "AI Models" })).toHaveAttribute("aria-labelledby", "settings-tab-models");
    expect(await screen.findByText("Configured services")).toBeInTheDocument();
  });

  it("shows separate Built-in and User Skills tables inside Settings", async () => {
    renderContent(null);
    await screen.findByRole("tablist", { name: "Settings" });
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(await screen.findByText("Analyze alpha data")).toBeInTheDocument();
    expect(screen.getByLabelText("Enable alpha")).toBeChecked();
    expect(screen.getByRole("heading", { name: "Built-in Skills" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "User Skills" })).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByText("Scientific Environment")).not.toBeInTheDocument();
    expect(screen.queryByText("Project Skills")).not.toBeInTheDocument();
  });

  it("uses Core capabilities and links to MCP without obsolete extension requests", async () => {
    renderContent(null);
    expect(screen.queryByRole("tab", { name: "Extensions" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("tab", { name: "Agent Capabilities" }));
    expect(await screen.findByText(/no Pi extension installation is required/)).toBeInTheDocument();
    expect(screen.queryByText("Installed Extensions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage MCP connectors" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "MCP" })).toHaveFocus());
    const requests = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requests.some((url) => /extensions|web-access|agent-profiles|settings\/config/.test(url))).toBe(false);
  });

  it("describes Core capabilities consistently in Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");
    try {
      renderContent(null);
      fireEvent.click(await screen.findByRole("tab", { name: "智能体能力" }));
      expect(await screen.findByText(/无需安装 Pi 扩展/)).toBeInTheDocument();
      expect(screen.queryByText("已安装扩展")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "管理 MCP 连接器" })).toBeInTheDocument();
    } finally { await i18n.changeLanguage("en"); }
  });

  it("lists workspace subagent files without unsupported mutation controls", async () => {
    renderContent("/lab/project");
    fireEvent.click(await screen.findByRole("tab", { name: "Agent Capabilities" }));
    expect(await screen.findByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText(".pi/agents/reviewer.md")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New subagent" })).not.toBeInTheDocument();
    expect(screen.queryByText("Fork parent")).not.toBeInTheDocument();
  });

  it("supports arrow-key navigation between tabs", async () => {
    renderContent(null);
    const nav = await screen.findByRole("tablist", { name: "Settings" });
    const general = screen.getByRole("tab", { name: "General" });
    general.focus();
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "AI Models" })).toHaveAttribute("aria-selected", "true"));
    // Keyboard navigation moves focus into the newly activated tab.
    await waitFor(() => expect(screen.getByRole("tab", { name: "AI Models" })).toHaveFocus());
    fireEvent.keyDown(nav, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Compute" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(nav, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Environments" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(nav, { key: "Home" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true"));
  });

  it("keeps runtime model controls out of Settings", async () => {
    renderContent(null);
    fireEvent.click(await screen.findByRole("tab", { name: "AI Models" }));
    expect(await screen.findByText("Configured services")).toBeInTheDocument();
    expect(screen.queryByText("Default model")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking Level")).not.toBeInTheDocument();
    expect(screen.queryByText("Context Management")).not.toBeInTheDocument();
  });

  it("opens Agent with context management controls", async () => {
    renderContent(null);
    fireEvent.click(await screen.findByRole("tab", { name: "Agent" }));
    expect(await screen.findByText("Control how Pi manages long-running work.")).toBeInTheDocument();
    expect(screen.getByText("Context Management")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configured model" })).toBeInTheDocument();
    expect(screen.getByText(/They affect new conversations and are also applied to other open conversations/)).toBeInTheDocument();
    expect(screen.queryByText(/Configured model defaults/)).not.toBeInTheDocument();
  });
  it("uses a single keyboard tab stop in the navigation and links Agent to model connections", async () => {
    renderContent("/lab/project");
    const nav = await screen.findByRole("tablist", { name: "Settings" });
    expect(nav.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "Agent" }));
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("tabindex", "0");
    fireEvent.click(await screen.findByRole("button", { name: "Manage models" }));
    expect(screen.getByRole("tab", { name: "AI Models" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("tab", { name: "AI Models" })).toHaveFocus());
    expect(screen.getByText("/lab/project")).toBeInTheDocument();
  });

  it("reloads a repaired custom provider before the settings cache TTL expires", async () => {
    let repaired = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith("/api/settings/config")) return jsonResponse({ model: "", thinking: "off", api_keys: {}, custom_providers: [], available_models: [], compaction_enabled: true, compaction_threshold_percent: 85,
        providers: [{ id: "user-lab", name: "Lab", custom: true, enabled: true, models: ["model-a"], has_key: repaired, credential_status: repaired ? "configured" : "needs_key" }] });
      if (url === "/api/endpoints") return jsonResponse({ endpoints: [{ id: "lab-endpoint", base_url: "https://lab.example/v1", protocol: "openai", health: "unknown" }] });
      if (url === "/api/provider-endpoint-bindings") return jsonResponse({ bindings: [{ provider_id: "user-lab", endpoint_id: "lab-endpoint" }] });
      if (url === "/api/custom-providers/user-lab" && init.method === "PUT") { repaired = true; return jsonResponse({ ok: true }); }
      return defaultFetch(url, init);
    });
    renderContent(null);
    fireEvent.click(await screen.findByRole("tab", { name: "AI Models" }));
    fireEvent.click(await screen.findByRole("button", { name: "Configure connection" }));
    await waitFor(() => expect(screen.getByLabelText("Base URL")).toHaveValue("https://lab.example/v1"));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-repair-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: /Lab.*Connected/ })).toBeInTheDocument();
    expect(screen.queryByText("Needs authentication")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Edit connection" })).not.toBeInTheDocument();
  });

  it("keeps General and Skills usable while model configuration is delayed", async () => {
    let resolveModel!: (response: Response) => void;
    const modelResponse = new Promise<Response>((resolve) => { resolveModel = resolve; });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => String(input).startsWith("/api/settings/config") ? modelResponse : defaultFetch(String(input), init));
    renderContent(null);
    expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "AI Models" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(useUiStore.getState().theme).toBe("dark");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(await screen.findByText("Analyze alpha data")).toBeInTheDocument();
    await act(async () => resolveModel(jsonResponse({ providers: [], available_models: [], api_keys: {}, custom_providers: [], model: "", thinking: "off" })));
  });

  it("isolates model loading errors from General and supports retry", async () => {
    let attempts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).startsWith("/api/settings/config") && ++attempts <= 2) return jsonResponse({ error: "Catalog unavailable" }, 400);
      return defaultFetch(String(input), init);
    });
    renderContent(null);
    fireEvent.click(screen.getByRole("tab", { name: "AI Models" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "AI Models" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByText("Configured services")).toBeInTheDocument();
    expect(attempts).toBe(3);
  });

  it.each(["save", "delete"])("propagates API key %s failures to the open maintenance dialog", async (operation) => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).startsWith("/api/settings/api-key")) return jsonResponse({ error: "Credential write failed" }, 500);
      return defaultFetch(String(input), init);
    });
    renderContent(null);
    fireEvent.click(screen.getByRole("tab", { name: "AI Models" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connection settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: operation === "save" ? "Replace" : "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: operation === "save" ? "Replace API key" : "Disconnect service" });
    if (operation === "save") fireEvent.change(within(dialog).getByLabelText(/DeepSeek API key/), { target: { value: "retained-test-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: operation === "save" ? "Save" : "Disconnect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Credential write failed");
    expect(dialog).toBeInTheDocument();
    if (operation === "save") expect(within(dialog).getByLabelText(/DeepSeek API key/)).toHaveValue("retained-test-key");
  });

});
