import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ModelSelection } from "@pi-science/contracts";
import { useModelConfig } from "./useModelConfig";
import { queryClient } from "../lib/client/query-client";
import { modelSelectionApi, modelSelectionKeys } from "../lib/model-selection";
import { useRuntimeStore } from "../lib/agent-runtime";
import i18n from "../i18n";

const flash = "deepseek/deepseek-flash";
const pro = "deepseek/deepseek-v4-pro";
const models = [flash, pro].map((id) => ({ id, provider: "deepseek", model: id.split("/")[1], label: id, reasoning: true, thinking_levels: ["off", "high", "max"] }));
let defaults: ModelSelection;
let sessions: Record<string, ModelSelection>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
async function respond(input: RequestInfo | URL, init: RequestInit = {}) {
  const path = new URL(String(input), "http://localhost");
  if (path.pathname === "/api/model-selection/catalog") return json({ available_models: models });
  if (path.pathname === "/api/model-selection/default") {
    if (init.method === "PUT") defaults = JSON.parse(String(init.body));
    return json({ scope: "default", selection: defaults });
  }
  const id = path.pathname.match(/^\/api\/sessions\/([^/]+)\/model-selection$/)?.[1];
  if (id) {
    if (!sessions[id]) return json({ error: "session not found" }, 404);
    if (init.method === "PUT") sessions[id] = JSON.parse(String(init.body));
    return json({ scope: "session", session_id: id, selection: sessions[id] });
  }
  return json({ error: `Unexpected request ${path.pathname}` }, 404);
}
const fetchMock = vi.fn(respond);
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => {
  cleanup(); queryClient.clear();
  defaults = { model: flash, thinking: "high" };
  sessions = { s1: { model: flash, thinking: "high" }, s2: { model: pro, thinking: "max" } };
  fetchMock.mockReset().mockImplementation(respond);
  vi.stubGlobal("fetch", fetchMock);
  useRuntimeStore.setState({ cwd: "proj", activeSessionId: null, model: null, thinking: null, client: null, draftModelSelection: null });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); });

describe("ModelSelection composer ownership", () => {
  it("keeps 10,000 model options stable through context updates and refreshes changed catalogs", async () => {
    const large = Array.from({ length: 10000 }, (_, index) => ({ ...models[0], id: `deepseek/model-${index}`, model: `model-${index}` }));
    queryClient.setQueryData(modelSelectionKeys.catalog("proj"), { available_models: large });
    fetchMock.mockImplementation((url, init) => String(url).includes("/catalog") ? Promise.resolve(json({ available_models: large })) : respond(url, init));
    const { result } = renderHook(() => {
      useRuntimeStore((state) => state.contextTokens);
      return useModelConfig("proj", "s1");
    });
    await waitFor(() => expect(result.current.models).toHaveLength(10000));
    const first = result.current.models;
    for (let index = 0; index < 20; index++) {
      act(() => useRuntimeStore.setState({ contextTokens: index * 100 }));
      expect(result.current.models).toBe(first);
    }
    act(() => queryClient.setQueryData(modelSelectionKeys.catalog("proj"), { available_models: [...large, models[1]] }));
    await waitFor(() => expect(result.current.models).toHaveLength(10001));
    expect(result.current.models).not.toBe(first);
  });
  it("uses the durable session selection and ignores the default and stale runtime", async () => {
    useRuntimeStore.setState({ model: flash, thinking: "off" });
    const { result } = renderHook(() => useModelConfig("proj", "s2"));
    await waitFor(() => expect(result.current.selectedModel).toBe(pro));
    expect(result.current.thinking).toBe("max");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("settings/config"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("selection/default"))).toBe(false);
    await act(async () => { await modelSelectionApi.saveDefault({ model: pro, thinking: "off" }); });
    expect(result.current.selectedModel).toBe(pro);
    expect(result.current.thinking).toBe("max");
  });
  it("writes only session A and preserves the default and session B", async () => {
    const { result } = renderHook(() => useModelConfig("proj", "s1"));
    await waitFor(() => expect(result.current.selectedModel).toBe(flash));
    act(() => result.current.handleModelChange(pro));
    await waitFor(() => expect(result.current.configuringModel).toBe(false));
    expect(sessions.s1).toEqual({ model: pro, thinking: "high" });
    expect(sessions.s2).toEqual({ model: pro, thinking: "max" });
    expect(defaults).toEqual({ model: flash, thinking: "high" });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([url]) => String(url))).toEqual(["/api/sessions/s1/model-selection?cwd=proj"]);
  });
  it("switches ownership when navigating between sessions in one workspace", async () => {
    const { result, rerender } = renderHook(({ id }) => useModelConfig("proj", id), { initialProps: { id: "s1" } });
    await waitFor(() => expect(result.current.selectedModel).toBe(flash));
    rerender({ id: "s2" });
    await waitFor(() => expect(result.current.selectedModel).toBe(pro));
    expect(result.current.thinking).toBe("max");
  });
  it("keeps a blank conversation's selection as a draft without writing defaults", async () => {
    const { result } = renderHook(() => useModelConfig("proj", undefined));
    await waitFor(() => expect(result.current.selectedModel).toBe(flash));
    act(() => result.current.handleModelChange(pro));
    expect(result.current.selectedModel).toBe(pro);
    expect(useRuntimeStore.getState().draftModelSelection).toEqual({ cwd: "proj", selection: { model: pro, thinking: "high" } });
    await act(async () => { await modelSelectionApi.saveDefault({ model: flash, thinking: "off" }); });
    expect(result.current.selectedModel).toBe(pro);
    expect(result.current.thinking).toBe("high");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });
  it("does not leak a draft or runtime selection into another workspace", async () => {
    useRuntimeStore.setState({ draftModelSelection: { cwd: "proj", selection: { model: pro, thinking: "max" } }, activeSessionId: "s2", model: pro });
    const { result } = renderHook(() => useModelConfig("other", undefined));
    await waitFor(() => expect(result.current.selectedModel).toBe(flash));
    expect(result.current.thinking).toBe("high");
  });
  it("reports an unavailable durable model without substituting defaults", async () => {
    sessions.s1 = { model: "user-missing/model", thinking: "off" };
    const { result } = renderHook(() => useModelConfig("proj", "s1"));
    await waitFor(() => expect(result.current.needsModelSwitch).toBe(true));
    expect(result.current.selectedModel).toBe("");
    expect(result.current.modelError).toContain("user-missing/model");
  });
  it("does not substitute a default when the session read fails", async () => {
    delete sessions.s1;
    const { result } = renderHook(() => useModelConfig("proj", "s1"));
    await waitFor(() => expect(result.current.modelError).toContain("session not found"));
    expect(result.current.selectedModel).toBe("");
  });
  it("retains the committed choice after a failed session write", async () => {
    fetchMock.mockImplementation((url, init) => init?.method === "PUT" ? Promise.resolve(json({ error: "agent is busy" }, 409)) : respond(url, init));
    const { result } = renderHook(() => useModelConfig("proj", "s1"));
    await waitFor(() => expect(result.current.selectedModel).toBe(flash));
    act(() => result.current.handleModelChange(pro));
    await waitFor(() => expect(result.current.modelError).toBe("agent is busy"));
    expect(result.current.selectedModel).toBe(flash);
    expect(defaults.model).toBe(flash);
  });
  it("isolates late writes and failures from a newly viewed session", async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementation((url, init) => init?.method === "PUT" ? new Promise((resolve) => { release = resolve; }) : respond(url, init));
    const { result, rerender } = renderHook(({ id }) => useModelConfig("proj", id), { initialProps: { id: "s1" } });
    await waitFor(() => expect(result.current.selectedModel).toBe(flash));
    act(() => result.current.handleModelChange(pro));
    await waitFor(() => expect(release).toBeDefined());
    rerender({ id: "s2" });
    await waitFor(() => expect(result.current.selectedModel).toBe(pro));
    await act(async () => { release(json({ error: "old request failed" }, 409)); });
    expect(result.current.modelError).toBeNull();
    expect(result.current.thinking).toBe("max");
    rerender({ id: "s1" });
    await waitFor(() => expect(result.current.selectedModel).toBe(flash));
    expect(result.current.configuringModel).toBe(false);
  });
  it("validates session identity in the server response", async () => {
    fetchMock.mockImplementation((url, init) => String(url).includes("/sessions/") ? Promise.resolve(json({ scope: "session", session_id: "wrong", selection: defaults })) : respond(url, init));
    const { result } = renderHook(() => useModelConfig("proj", "s1"));
    await waitFor(() => expect(result.current.modelError).toContain("different session"));
    expect(result.current.selectedModel).toBe("");
  });
});
