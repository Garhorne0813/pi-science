import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WebAccessSettings } from "./WebAccessSettings";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const putCalls: { url: string; body: unknown }[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("/api/settings/web-access")) {
    if (method === "PUT") {
      putCalls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true, provider: "auto", workflow: "none", providers: [] });
    }
    return jsonResponse({
      provider: "auto",
      workflow: "none",
      providers: [{ id: "brave", has_key: false, key_source: null, env: "BRAVE_API_KEY" }],
    });
  }
  return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  putCalls.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSettings() {
  return render(
    <QueryClientProvider client={queryClient}>
      <WebAccessSettings />
    </QueryClientProvider>,
  );
}

describe("WebAccessSettings row menus", () => {
  it("switching the provider saves immediately through the dropdown menu", async () => {
    renderSettings();
    const trigger = await screen.findByRole("button", { name: "Provider: Auto fallback" });
    expect(trigger).toHaveTextContent("Auto fallback");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "brave" }));
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0].body).toMatchObject({ provider: "brave", workflow: "none" });
  });

  it("switching the workflow saves immediately through the dropdown menu", async () => {
    renderSettings();
    const trigger = await screen.findByRole("button", { name: "Result workflow: Raw results" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Automatic summary" }));
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0].body).toMatchObject({ provider: "auto", workflow: "auto-summary" });
  });
});
