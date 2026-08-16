import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FeedbackContext } from "../feedback/feedback-context";
import { SettingsDialog } from "./SettingsDialog";
import { queryClient } from "../../lib/client/query-client";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { useUiStore } from "../../lib/ui";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("/api/settings/config")) {
    return Promise.resolve(jsonResponse({ ok: true, providers: [], available_models: [], model: "", thinking: "high" }));
  }
  return Promise.resolve(jsonResponse({ error: `unhandled ${method} ${url}` }, 404));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => defaultFetch(String(input), init));

function renderDialog() {
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <SettingsDialog />
      </FeedbackContext.Provider>
    </QueryClientProvider>,
  );
}

function openSettings(scope: string | null): void {
  act(() => useUiStore.getState().openSettings(scope));
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
  useUiStore.setState({ settingsOpen: false, settingsScope: null, });
  useRuntimeStore.setState({ pendingInteraction: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsDialog", () => {
  it("renders nothing while closed", () => {
    renderDialog();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens with the global scope label", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await screen.findByText("Global settings")).toBeInTheDocument();
  });

  it("shows the workspace scope label when opened from a workspace", async () => {
    renderDialog();
    openSettings("proj");
    await screen.findByRole("dialog");
    expect(await screen.findByText("Workspace settings")).toBeInTheDocument();
  });

  it("opens with the DeepSeek-sized desktop panel above a lighter overlay", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass("md:h-[min(86vh,860px)]", "md:w-[min(920px,calc(100vw-32px))]", "md:rounded-large", "md:border");
    const overlay = dialog.parentElement;
    if (!overlay) throw new Error("overlay not found");
    expect(overlay).toHaveClass("z-[95]", "bg-black/40");
  });

  it("closes on Escape", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on overlay click", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    const overlay = dialog.parentElement;
    if (!overlay) throw new Error("overlay not found");
    fireEvent.mouseDown(overlay);
    await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(false));
  });

  it("does not close when clicking inside the panel", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it("closes via the X button", async () => {
    renderDialog();
    openSettings(null);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(false));
  });

  it("switches tabs through the vertical navigation", async () => {
    renderDialog();
    openSettings(null);
    await screen.findByRole("dialog");
    const llmTab = await screen.findByRole("tab", { name: "LLM" });
    fireEvent.click(llmTab);
    expect(await screen.findByText("Models")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "LLM" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "false");
  });

  it("auto-closes when an extension interaction arrives", async () => {
    renderDialog();
    openSettings(null);
    await screen.findByRole("dialog");
    act(() => {
      useRuntimeStore.setState({
        pendingInteraction: { requestId: "r1", method: "confirm", title: "Confirm", message: "proceed?" },
      });
    });
    await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(false));
  });

  it("stays closed when an interaction arrives while the dialog is closed", async () => {
    renderDialog();
    act(() => {
      useRuntimeStore.setState({
        pendingInteraction: { requestId: "r1", method: "confirm", title: "Confirm", message: "proceed?" },
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });

  it("restores focus to the trigger element after closing", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.appendChild(trigger);
    try {
      trigger.focus();
      renderDialog();
      openSettings(null);
      await screen.findByRole("dialog");
      act(() => useUiStore.getState().closeSettings());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      document.body.removeChild(trigger);
    }
  });

  it("moves focus into the panel when opened", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(dialog);
  });

  it("wraps Tab from the last control back to the first (sidebar General tab)", async () => {
    renderDialog();
    openSettings(null);
    await screen.findByRole("dialog");
    // The close button now lives in the content header, so the first focusable
    // is the sidebar's General tab and the panel-order select stays last.
    const panelOrder = await screen.findByLabelText(/Conversation and preview layout/);
    panelOrder.focus();
    fireEvent.keyDown(panelOrder, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "General" }));
  });

  it("wraps Shift+Tab from the first control (or the panel) to the last", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    // The sidebar's General tab is the first focusable control now.
    const general = screen.getByRole("tab", { name: "General" });
    general.focus();
    fireEvent.keyDown(general, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText(/Conversation and preview layout/));
    // Right after opening, focus sits on the panel itself: Shift+Tab wraps too.
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText(/Conversation and preview layout/));
  });

  it("keeps the close button in the panel's normal tab order", async () => {
    renderDialog();
    openSettings(null);
    const dialog = await screen.findByRole("dialog");
    // The close control sits between the sidebar tabs and the content
    // controls, so it must stay part of the focusable sequence.
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ));
    const labels = focusables.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
    const generalIndex = labels.indexOf("General");
    const closeIndex = labels.indexOf("Close");
    const panelOrderIndex = labels.findIndex((label) => label.includes("Conversation and preview layout"));
    expect(generalIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(generalIndex);
    expect(panelOrderIndex).toBeGreaterThan(closeIndex);
  });
});
