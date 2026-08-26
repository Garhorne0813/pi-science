import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ModelResourceSection } from "./ModelResourceSection";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const provider = {
  id: "user-lab",
  name: "Lab",
  kind: "user",
  adapter: "openai-compatible",
  enabled: true,
  catalog_mode: "hybrid",
  auth_kind: "api_key",
  source: "user",
  models: ["model-a"],
  has_key: true,
  credential_status: "configured",
  routes: 1,
};
const endpoint = { id: "ep-lab", endpoint_id: "ep-lab", name: "Lab connection", base_url: "http://127.0.0.1:8000/v1", protocol: "openai", credential_ref: "cred-lab", enabled: true, health: "ready", data_egress: "local" };
const binding = { id: "bind-lab", provider_id: "user-lab", endpoint_id: "ep-lab", enabled: true, priority: 100 };
const model = { id: "user-lab/model-a", provider_id: "user-lab", model_id: "model-a", display_name: "Lab · model-a", enabled: true, available: true, availability_reason: null, capabilities: { reasoning: false, thinking_levels: ["off"], context_window: null, max_output_tokens: null }, capability_source: "fallback", routes: [] };

let providers = [provider];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url === "/api/providers") return jsonResponse({ providers });
  if (url === "/api/endpoints") return jsonResponse({ endpoints: providers.length ? [endpoint] : [] });
  if (url.startsWith("/api/provider-endpoint-bindings")) return jsonResponse({ bindings: providers.length ? [binding] : [] });
  if (url.startsWith("/api/models")) return jsonResponse({ models: providers.length ? [model] : [] });
  if (url === "/api/custom-providers/test" && method === "POST") return jsonResponse({ ok: true, health: "ready", models: [{ id: "model-a", display_name: "model-a" }] });
  if (url === "/api/endpoints/ep-lab/health" && method === "POST") return jsonResponse({ ok: true, ...endpoint, endpoint });
  if (url === "/api/custom-providers/user-lab" && method === "PUT") return jsonResponse({ ok: true, provider, endpoint, binding });
  return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
});

function renderSection() {
  const onConfigReload = vi.fn().mockResolvedValue(undefined);
  render(<QueryClientProvider client={queryClient}><ModelResourceSection onConfigReload={onConfigReload} /></QueryClientProvider>);
  return { onConfigReload };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  providers = [provider];
  fetchMock.mockClear();
  queryClient.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelResourceSection", () => {
  it("sends auth none when an existing provider disables authentication", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const auth = screen.getByRole("button", { name: "Authentication: API key stored by Pi-Science" });
    fireEvent.pointerDown(auth);
    fireEvent.click(auth);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "No authentication" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/custom-providers/user-lab" && (init?.method ?? "GET") === "PUT");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ auth: { kind: "none" } });
    });
  });

  it("reloads model settings after probing a provider connection", async () => {
    const { onConfigReload } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    await waitFor(() => expect(onConfigReload).toHaveBeenCalledTimes(1));
  });

  it("drops discovered models when connection fields change after a test", async () => {
    providers = [];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByPlaceholderText("Provider name"), { target: { value: "Lab" } });
    const baseUrl = screen.getByPlaceholderText("Base URL, for example https://api.example.com/v1");
    fireEvent.change(baseUrl, { target: { value: "http://127.0.0.1:8000/v1" } });
    fireEvent.change(screen.getByPlaceholderText("API key"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Test and discover" }));
    expect(await screen.findByText(/Connection successful/)).toBeInTheDocument();

    fireEvent.change(baseUrl, { target: { value: "http://127.0.0.1:9000/v1" } });
    expect(screen.queryByText(/Connection successful/)).toBeNull();
  });
});
