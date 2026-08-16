import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { useModelConfig } from "./useModelConfig";
import { queryClient } from "../lib/client/query-client";
import { settingsApi, settingsKey } from "../lib/settings";
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
        { id: "deepseek/deepseek-v4-mini", name: "V4 Mini", provider: "deepseek", reasoning: true, thinking_levels: ["low", "medium"] },
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

let lastLocation = "";
function LocationProbe() {
  lastLocation = useLocation().pathname;
  return null;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/workspace/proj/session/s1"]}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function navWrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/workspace/proj/session/s1"]}>
      <QueryClientProvider client={queryClient}>
        {children}
        <LocationProbe />
      </QueryClientProvider>
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
  lastLocation = "";
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
  useRuntimeStore.setState({
    activeSessionId: null,
    cwd: "",
    model: null,
    thinking: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useModelConfig", () => {
  it("keeps the session model while the dialog save updates the workspace default", async () => {
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high" });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    // Simulate the settings dialog save flow: PUT succeeds, then the dialog
    // reloads the config (loadConfig), which updates the shared cache that the
    // composer now subscribes to while it stays mounted under the modal. The
    // session model stays authoritative for the composer display.
    await act(async () => {
      await settingsApi.saveModel("deepseek/deepseek-v4-pro", "high", "proj");
      await settingsApi.config("proj");
    });
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash");
    const putCall = fetchMock.mock.calls.find(([url, _init]) => String(url).startsWith("/api/settings/model"));
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({ model: "deepseek/deepseek-v4-pro", thinking: "high" });
  });

  it("reflects the session model from the synced store while the model list comes from the config cache", async () => {
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high" });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));
    await waitFor(() => {
      expect(result.current.models.some((model) => model.id === "deepseek/deepseek-v4-mini")).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/settings/config?cwd=proj"), expect.anything());
  });

  it("does not paint workspace defaults while the store is still syncing", async () => {
    // Race window: the route shows a session and connect() has already
    // reset the store, but the session-state read has not returned yet.
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: null, thinking: null });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => {
      expect(result.current.models.some((model) => model.id === "deepseek/deepseek-v4-mini")).toBe(true);
    });
    // The workspace defaults (deepseek/deepseek-v4-flash / high from the
    // config cache) must not overwrite the composer while the store syncs.
    expect(result.current.selectedModel).toBe("");
    expect(result.current.thinking).toBe("high");
    expect(result.current.models.length).toBe(3);
  });

  it("changes thinking for the active session through the runtime store only", async () => {
    const setModel = vi.fn(async (model: string, thinking?: string) => {
      useRuntimeStore.setState({ model, thinking: thinking ?? null });
      return "s1";
    });
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high", setModel });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    await act(async () => { await result.current.handleThinkingChange("max"); });

    expect(setModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash", "max");
    // The workspace-default endpoint is never touched for session-local changes.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/settings/model"))).toBe(false);
    expect(result.current.thinking).toBe("max");
  });

  it("clamps thinking to the next model's levels on a session-local model switch", async () => {
    const setModel = vi.fn(async (model: string, thinking?: string) => {
      useRuntimeStore.setState({ model, thinking: thinking ?? null });
      return "s1";
    });
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "max", setModel });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash");
      // Wait for the config fetch so the v4-mini catalog entry is present;
      // the store effect alone would satisfy the selectedModel check early.
      expect(result.current.models.some((model) => model.id === "deepseek/deepseek-v4-mini")).toBe(true);
    });
    expect(result.current.thinking).toBe("max");

    // v4-mini only supports low/medium: switching from max must clamp to medium.
    await act(async () => { await result.current.handleModelChange("deepseek/deepseek-v4-mini"); });

    expect(setModel).toHaveBeenCalledWith("deepseek/deepseek-v4-mini", "medium");
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-mini");
    expect(result.current.thinking).toBe("medium");
  });

  it("navigates to the replacement session and adopts the store state", async () => {
    const setModel = vi.fn(async () => {
      useRuntimeStore.setState({ activeSessionId: "s2", model: "deepseek/deepseek-v4-pro", thinking: "max" });
      return "s2";
    });
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high", setModel });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper: navWrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    await act(async () => { await result.current.handleModelChange("deepseek/deepseek-v4-pro"); });

    expect(lastLocation).toBe("/workspace/proj/session/s2");
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-pro");
    expect(result.current.thinking).toBe("max");
  });

  it("rolls back local state and surfaces the error when the store save fails", async () => {
    const setModel = vi.fn(async () => { throw new Error("runtime busy"); });
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high", setModel });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    await act(async () => { await result.current.handleThinkingChange("max"); });

    expect(setModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash", "max");
    expect(result.current.thinking).toBe("high");
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(result.current.modelError).toBe("runtime busy");
  });

  it("falls back to the workspace default save when no active session exists", async () => {
    useRuntimeStore.setState({ activeSessionId: null, cwd: "", model: null, thinking: null });
    const { result } = renderHook(() => useModelConfig("proj", undefined), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    await act(async () => { await result.current.handleModelChange("deepseek/deepseek-v4-pro"); });

    const putCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/settings/model"));
    expect(putCall).toBeDefined();
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({ model: "deepseek/deepseek-v4-pro", thinking: "high" });
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("does not write the workspace settings cache for session-local changes", async () => {
    const setModel = vi.fn(async (model: string, thinking?: string) => {
      useRuntimeStore.setState({ model, thinking: thinking ?? null });
      return "s1";
    });
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high", setModel });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));
    const cachedBefore = queryClient.getQueryData(settingsKey("config", "proj"));

    await act(async () => { await result.current.handleThinkingChange("max"); });

    expect(queryClient.getQueryData(settingsKey("config", "proj"))).toBe(cachedBefore);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/settings/model"))).toBe(false);
  });

  it("refuses the change when the route session is not the active store session", async () => {
    const setModel = vi.fn(async () => "s2");
    useRuntimeStore.setState({ activeSessionId: "s2", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high", setModel });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    await act(async () => { await result.current.handleThinkingChange("max"); });

    // Neither the session-local action nor the workspace-default save may run
    // when the route and the store disagree about the active session.
    expect(setModel).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/settings/model"))).toBe(false);
    expect(result.current.modelError).toContain("not available");
    expect(result.current.thinking).toBe("high");
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash");
  });

  it("invalidates an in-flight change when the session changes so the stale completion cannot navigate or overwrite", async () => {
    let resolveSetModel!: (value: string) => void;
    const setModel = vi.fn(() => new Promise<string>((resolve) => { resolveSetModel = resolve; }));
    useRuntimeStore.setState({ activeSessionId: "s1", cwd: "proj", model: "deepseek/deepseek-v4-flash", thinking: "high", setModel });
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | undefined }) => useModelConfig("proj", sid),
      { wrapper: navWrapper, initialProps: { sid: "s1" } },
    );
    await waitFor(() => expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash"));

    let changePromise!: Promise<void>;
    await act(async () => { changePromise = result.current.handleModelChange("deepseek/deepseek-v4-pro"); });
    expect(setModel).toHaveBeenCalledWith("deepseek/deepseek-v4-pro", "high");
    expect(result.current.configuringModel).toBe(true);

    // The route moves to another session while the save is still in flight.
    await act(async () => {
      useRuntimeStore.setState({ activeSessionId: "s2", model: "deepseek/deepseek-v4-flash", thinking: "high" });
      rerender({ sid: "s2" });
    });
    // Loading must reset even though the old async completion will skip its
    // own finally (it was invalidated).
    expect(result.current.configuringModel).toBe(false);
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash");

    // The stale save resolves afterwards: its replacement id must not trigger
    // navigation and its store state must not be applied by the old operation.
    await act(async () => {
      resolveSetModel("s2");
      await changePromise;
    });
    expect(lastLocation).toBe("/workspace/proj/session/s1");
    expect(result.current.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(result.current.configuringModel).toBe(false);
  });

  it("resolves immediately when no model is selected yet", async () => {
    // Hang the config fetch so the model list never arrives: the composer is
    // still unselected when the user touches the thinking menu.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    useRuntimeStore.setState({ activeSessionId: null, cwd: "", model: null, thinking: null });
    const { result } = renderHook(() => useModelConfig("proj", "s1"), { wrapper });
    expect(result.current.selectedModel).toBe("");

    let settled = false;
    await act(async () => { await result.current.handleThinkingChange("max"); settled = true; });

    expect(settled).toBe(true);
    expect(result.current.thinking).toBe("high");
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/settings/model"))).toBe(false);
  });
});
