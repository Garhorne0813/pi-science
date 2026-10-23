import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AIModelsTab } from "./AIModelsTab";
import i18n from "../../../i18n";
beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => vi.unstubAllGlobals());
it("shows native load errors without exposing old controls or requesting the old inventory", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { requests.push(String(url)); return new Response(JSON.stringify({ error: "Repair native configuration" }), { status: 400, headers: { "Content-Type": "application/json" } }); }));
  const saveKey = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AIModelsTab apiKeyInput={{}} setApiKeyInput={vi.fn()} showKey={{}} setShowKey={vi.fn()} saving={null} saveKey={saveKey} deleteKey={vi.fn()} /></QueryClientProvider>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Repair native configuration");
  expect(screen.queryByRole("button", { name: "Advanced model configuration" })).not.toBeInTheDocument();
  expect(requests.sort()).toEqual(["/api/model-config", "/api/model-config/catalog"]);
  expect(saveKey).not.toHaveBeenCalled(); client.clear();
});
