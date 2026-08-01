import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { useModelConfig } from "./useModelConfig";
import { queryClient } from "../lib/client/query-client";
import { settingsApi } from "../lib/settings";
import { useRuntimeStore } from "../lib/agent-runtime";
import i18n from "../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let currentModel = "deepseek/deepseek-v4-flash";

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("/api/settings/config")) {
    return Promise.resolve(jsonResponse({
      ok: true,
      providers: [{ id: "deepseek", name: "DeepSeek", has_key: true }],
      available_models: [
        { id: "deepseek/deepseek-v4-flash", name: "V4 Flash", provider: "deepseek", reasoning: true, thinking_levels: ["high", "max"] },
        { id: "deepseek/deepseek-v4-pro", name: "V4 Pro", provider: "deepseek", reasoning: true, thinking_levels: ["high", "max"] },
      ],
      model: currentModel,
      thinking: "high",
    }));
  }
  if (url.startsWith("/api/settings/model")) {
    const body = JSON.parse(String(init.body)) as { model: string; thinking: string };
    currentModel = body.model;
    return Promise.resolve(jsonResponse({ ok: true, model: body.model, thinking: body.thinking }));
  }
  return Promise.resolve(jsonResponse({ error: `unhandled ${method} ${url}` }, 404));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => defaultFetch(String(input), init));

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/workspace/proj/session/s1"]}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  currentModel = "deepseek/deepseek-v4-flash";
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
  useRuntimeStore.setState({ model: null, thinking: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useModelConfig", () => {
  it("tracks the shared settings config cache so dialog saves refresh the composer", async () => {
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    // Simulate the settings dialog save flow: PUT succeeds, then the dialog
    // reloads the config (loadConfig), which updates the shared cache that the
    // composer now subscribes to while it stays mounted under the modal.
    await act(async () => {
      await settingsApi.saveModel("deepseek/deepseek-v4-pro", "high", "proj");
      await settingsApi.config("proj");
    });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-pro"));
    const putCall = fetchMock.mock.calls.find(([url, _init]) => String(url).startsWith("/api/settings/model"));
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({ model: "deepseek/deepseek-v4-pro", thinking: "high" });
  });

  it("reflects the workspace-scoped config from the shared cache", async () => {
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/settings/config?cwd=proj"), expect.anything());
  });
});
