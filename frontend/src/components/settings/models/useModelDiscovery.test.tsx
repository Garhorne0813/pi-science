import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useModelDiscovery } from "./useModelDiscovery";

const response = (id: string) => new Response(JSON.stringify({ models: [{ id }, { id }], inference_verified: false }), { headers: { "Content-Type": "application/json" } });
const draft = { url: "https://models.example/v1", source: "managed", secret: "draft-key", variable: "" };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const advance = (ms = 800) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("never sends credentials while typing and discovers only on an explicit action", async () => {
  const fetch = vi.fn().mockResolvedValue(response("candidate")); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook((input) => useModelDiscovery(true, input.url, "openai-completions", input.source, input.secret, input.variable), { initialProps: { ...draft, secret: "" } });
  await advance(); expect(fetch).not.toHaveBeenCalled();
  rerender({ ...draft, secret: "partial" }); await advance(1500);
  rerender(draft); await advance(3000); expect(fetch).not.toHaveBeenCalled();
  await act(async () => result.current.retry());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ base_url: draft.url, api: "openai-completions", secret: draft.secret }) });
  expect(result.current).toMatchObject({ status: "success", models: [{ id: "candidate" }], inference_verified: false });
});

it("aborts obsolete requests and ignores their late responses while fields remain editable", async () => {
  let finishOld!: (value: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; })).mockResolvedValueOnce(response("new-model"));
  vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook((url) => useModelDiscovery(true, url, "openai-completions", "managed", draft.secret, ""), { initialProps: draft.url });
  await act(async () => result.current.retry()); expect(result.current.status).toBe("loading");
  const signal = fetch.mock.calls[0][1].signal as AbortSignal;
  rerender("https://other.example/v1");
  expect(signal.aborted).toBe(true); expect(result.current.models).toEqual([]);
  await advance(3000); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => result.current.retry()); expect(result.current.models).toEqual([{ id: "new-model" }]);
  await act(async () => { finishOld(response("stale-model")); });
  expect(result.current.models).toEqual([{ id: "new-model" }]);
});

it("reports discovery failure without echoing provider payloads and supports explicit retry", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("sensitive upstream payload")).mockResolvedValueOnce(response("retry-model")); vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useModelDiscovery(true, draft.url, "openai-completions", "managed", draft.secret, ""));
  await act(async () => result.current.retry()); expect(result.current).toMatchObject({ status: "error", models: [], errorCode: "discovery_failed" });
  expect(JSON.stringify(result.current)).not.toContain("sensitive upstream");
  act(() => result.current.retry()); await advance(0);
  expect(result.current.models).toEqual([{ id: "retry-model" }]); expect(fetch).toHaveBeenCalledTimes(2);
});

it("sends only the environment reference and handles keyless discovery without credentials", async () => {
  const fetch = vi.fn().mockImplementation(async () => response("candidate")); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook((source) => useModelDiscovery(true, draft.url, "anthropic-messages", source, "unused-key", "LAB_MODEL_KEY"), { initialProps: "environment" });
  await act(async () => result.current.retry());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ base_url: draft.url, api: "anthropic-messages", environment_variable: "LAB_MODEL_KEY" });
  rerender("keyless"); await advance(); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => result.current.retry());
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ base_url: draft.url, api: "anthropic-messages" });
});

it("does not discover invalid URLs and cancels on form dismissal", async () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
  const { result, rerender, unmount } = renderHook((url) => useModelDiscovery(true, url, "openai-completions", "keyless", "", ""), { initialProps: "ftp://example.com" });
  await advance(); expect(fetch).not.toHaveBeenCalled();
  rerender(draft.url); await act(async () => result.current.retry());
  const signal = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].signal as AbortSignal;
  unmount(); expect(signal.aborted).toBe(true);
});

it("cancels an outstanding discovery and does not accept its late response", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  const { result } = renderHook(() => useModelDiscovery(true, draft.url, "openai-completions", "keyless", "", ""));
  await act(async () => result.current.retry());
  act(() => result.current.cancel());
  await advance(15000); expect(result.current.status).toBe("idle");
  await act(async () => resolve(response("stale")));
  expect(result.current).toMatchObject({ status: "idle", models: [] });
});
it("uses a safe error classification and times out a stalled request", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: "discovery_auth", error: "secret" }), { status: 400, headers: { "Content-Type": "application/json" } })).mockImplementationOnce(() => new Promise<Response>(() => {})));
  const { result } = renderHook(() => useModelDiscovery(true, draft.url, "openai-completions", "keyless", "", ""));
  await act(async () => result.current.retry()); expect(result.current.errorCode).toBe("discovery_auth");
  expect(JSON.stringify(result.current)).not.toContain("secret");
  await act(async () => result.current.retry()); await advance(15000);
  expect(result.current).toMatchObject({ status: "error", errorCode: "discovery_timeout" });
});
