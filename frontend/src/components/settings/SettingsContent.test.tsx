import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  if (url === "/api/settings/skills") {
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
    expect(screen.getByRole("tabpanel", { name: "General" })).toHaveAttribute("aria-labelledby", "settings-tab-general");
  });

  it("marks the active tab with the selected surface and the rest with hover surfaces", async () => {
    renderContent(null);
    const nav = await screen.findByRole("tablist", { name: "Settings" });
    expect(nav).toHaveClass("gap-1");
    const general = screen.getByRole("tab", { name: "General" });
    const llm = screen.getByRole("tab", { name: "LLM" });
    expect(general).toHaveClass("bg-surface-selected");
    expect(llm).not.toHaveClass("bg-surface-selected");
    expect(llm).toHaveClass("hover:bg-surface-hover");
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
    expect(screen.getByRole("tab", { name: "Extensions" })).toHaveClass("hover:bg-surface-hover");
    expect(screen.getByRole("tab", { name: "Environments" })).toBeInTheDocument();
    // Every nav item uses a different outline icon (distinct svg content).
    const icons = screen.getAllByRole("tab").map((tab) => tab.querySelector("svg")?.innerHTML ?? null);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(7);
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
    fireEvent.click(screen.getByRole("tab", { name: "LLM" }));
    expect(screen.getByRole("tab", { name: "LLM" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "LLM" })).toHaveAttribute("aria-labelledby", "settings-tab-llm");
    expect(await screen.findByText("Models")).toBeInTheDocument();
  });

  it("shows one unified Skills list inside Settings", async () => {
    renderContent(null);
    await screen.findByRole("tablist", { name: "Settings" });
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(await screen.findByText("Analyze alpha data")).toBeInTheDocument();
    expect(screen.getByLabelText("Enable alpha")).toBeChecked();
    expect(screen.queryByText("Scientific Environment")).not.toBeInTheDocument();
    expect(screen.queryByText("Built-in Skills")).not.toBeInTheDocument();
    expect(screen.queryByText("Project Skills")).not.toBeInTheDocument();
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
    const trigger = await screen.findByLabelText(/Default model/);
    const configCallsBefore = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/settings/config")).length;
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "DeepSeek V4 Flash" }));
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
    const trigger = await screen.findByLabelText(/Default model/);
    // Switch the fetch mock to failing mode for the PUT.
    vi.mocked(fetchMock).mockImplementationOnce(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      return defaultFetch("/api/settings/model?fail=1", init);
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "DeepSeek V4 Flash" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    // The saving flag resets in finally, so the trigger is usable again.
    await waitFor(() => expect(screen.getByLabelText(/Default model/)).toBeEnabled());
  });
});
