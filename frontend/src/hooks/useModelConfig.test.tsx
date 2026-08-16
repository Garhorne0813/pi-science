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
let currentThinking = "high";

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
      thinking: currentThinking,
    }));
  }
  if (url.startsWith("/api/settings/model")) {
    const body = JSON.parse(String(init.body)) as { model: string; thinking: string };
    currentModel = body.model;
    currentThinking = body.thinking;
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
  currentThinking = "high";
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

  it("prefers the saved settings config over a stale active-runtime model", async () => {
    // The runtime store still reports the old model (the server restarts
    // runtimes asynchronously after a settings save).
    useRuntimeStore.setState({ model: "deepseek/deepseek-v4-flash", thinking: "high" });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    // The settings dialog saves a new model; the composer must follow the
    // settings config, not the stale runtime snapshot.
    await act(async () => {
      await settingsApi.saveModel("deepseek/deepseek-v4-pro", "max", "proj");
      await settingsApi.config("proj");
    });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-pro"));
    expect(result.current.thinking).toBe("max");
  });

  it("does not let a late runtime state update override the settings config", async () => {
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    // A stale/racing session-state event lands after the config was applied.
    await act(async () => {
      useRuntimeStore.setState({ model: "deepseek/deepseek-v4-pro", thinking: "max" });
    });
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(result.current.thinking).toBe("high");
  });

  it("falls back to the active runtime model when settings carry none", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith("/api/settings/config")) {
        return Promise.resolve(jsonResponse({ ok: true, providers: [], available_models: [], model: undefined, thinking: undefined }));
      }
      if (url.startsWith("/api/settings/model")) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({ error: `unhandled ${init.method || "GET"} ${url}` }, 404));
    });
    useRuntimeStore.setState({ model: "deepseek/deepseek-v4-pro", thinking: "max" });

    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-pro"));
    expect(result.current.thinking).toBe("max");
  });

  it("does not let a previous workspace's saved config block this workspace's runtime model", async () => {
    // Workspace "proj2" config cannot be loaded (offline/error), so the
    // runtime store is the only model source there — and it must not be
    // shadowed by the stale saved config of the previously viewed workspace.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith("/api/settings/config")) {
        const cwd = new URL(url, "http://localhost").searchParams.get("cwd");
        if (cwd === "proj2") return Promise.reject(new Error("config unavailable"));
      }
      return defaultFetch(url, init);
    });

    // Workspace "proj" has a saved config, so the hook remembers it.
    const { result, rerender } = renderHook(({ cwd, sessionId }: { cwd: string; sessionId: string }) => useModelConfig(cwd, sessionId), {
      initialProps: { cwd: "proj", sessionId: "s1" },
      wrapper,
    });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    // Navigate to "proj2" (no reachable config): the late runtime state must
    // fill the composer instead of being blocked by proj's stale saved config.
    rerender({ cwd: "proj2", sessionId: "s2" });
    await act(async () => {
      useRuntimeStore.setState({ model: "deepseek/deepseek-v4-pro", thinking: "max" });
    });
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-pro");
    expect(result.current.thinking).toBe("max");
  });

  it("does not retain the previous workspace's model when the new workspace's config fails and the runtime store never updates", async () => {
    // Workspace "proj2" config cannot be loaded (offline/error) and no runtime
    // state ever arrives for it: the store keeps the value "proj"'s session
    // left behind. Since that value never changes after the switch, neither it
    // nor "proj"'s saved config may leak into the new workspace.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith("/api/settings/config")) {
        const cwd = new URL(url, "http://localhost").searchParams.get("cwd");
        if (cwd === "proj2") return Promise.reject(new Error("config unavailable"));
      }
      return defaultFetch(url, init);
    });

    // Workspace "proj" has a saved config; its session state also lands in the
    // runtime store before the switch.
    const { result, rerender } = renderHook(({ cwd, sessionId }: { cwd: string; sessionId: string }) => useModelConfig(cwd, sessionId), {
      initialProps: { cwd: "proj", sessionId: "s1" },
      wrapper,
    });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));
    await act(async () => {
      useRuntimeStore.setState({ model: "deepseek/deepseek-v4-pro", thinking: "max" });
    });

    // Navigate to "proj2": the stale store value is not applied (it describes
    // "proj" and never changes), so the composer shows no model at all.
    rerender({ cwd: "proj2", sessionId: "s2" });
    await waitFor(() => expect(result.current.selectedModel).toBe(""));
    expect(result.current.thinking).toBe("high");
  });
});
