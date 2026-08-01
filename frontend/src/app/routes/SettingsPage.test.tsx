import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SettingsPage } from "./SettingsPage";
import { WorkspaceProvider } from "../../lib/workspace-context";
import { queryClient } from "../../lib/query-client";
import { useUiStore } from "../../lib/store";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// The dialog content loads lazily under the shell; keep fetch deterministic so
// the lazy chunk never issues real requests (jsdom would reject them).
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith("/api/settings/config")) {
    return jsonResponse({ ok: true, providers: [], available_models: [], model: "", thinking: "high" });
  }
  return jsonResponse({ error: `unhandled ${url}` }, 404);
});

function renderShell(initial = "/settings") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<div>home-page</div>} />
        <Route path="/workspace/:cwd" element={<div>workspace-home</div>} />
        <Route path="/settings" element={<WorkspaceProvider><SettingsPage /></WorkspaceProvider>} />
        <Route path="/workspace/:cwd/settings" element={<WorkspaceProvider><SettingsPage /></WorkspaceProvider>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
  useUiStore.setState({ settingsOpen: false, settingsScope: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage legacy route shell", () => {
  it("opens the dialog on mount and returns to the project list when it closes", async () => {
    renderShell();
    await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(true));
    act(() => useUiStore.getState().closeSettings());
    await screen.findByText("home-page");
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });

  it("opens with the workspace scope and returns to the workspace home", async () => {
    renderShell("/workspace/proj/settings");
    await waitFor(() => {
      expect(useUiStore.getState().settingsOpen).toBe(true);
      expect(useUiStore.getState().settingsScope).toBe("proj");
    });
    act(() => useUiStore.getState().closeSettings());
    await screen.findByText("workspace-home");
  });
});
