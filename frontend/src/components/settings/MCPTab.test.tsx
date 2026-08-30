import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";
import { MCPTab } from "./MCPTab";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("/api/mcp/catalog?cwd=")) {
    return jsonResponse({
      servers: [{
        id: "paper-search",
        name: "Paper Search",
        description: "Search scientific literature",
        enabled: true,
        health: "ready",
        auth: "none",
        data_egress: "remote",
        transport: "stdio",
        tools: [{ name: "search_pubmed" }, { name: "search_arxiv" }],
      }],
    });
  }
  if (url === "/api/settings/mcp/paper-search?enabled=false" && method === "PUT") {
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
});

function renderTab(cwd: string | null) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MCPTab workspaceCwd={cwd} />
    </QueryClientProvider>,
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCPTab", () => {
  it("presents MCP servers using the same table pattern as Skills", async () => {
    renderTab("/tmp/ws");

    const table = await screen.findByRole("table");
    expect(screen.getByRole("heading", { name: "MCP servers" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Tools" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Enabled" })).toBeInTheDocument();
    expect(within(table).getByText("Paper Search")).toBeInTheDocument();
    expect(within(table).getByText("2 tools")).toBeInTheDocument();
    expect(within(table).getByRole("checkbox", { name: "Enable Paper Search" })).toBeChecked();
  });

  it("toggles a server with the enabled checkbox", async () => {
    renderTab("/tmp/ws");

    const checkbox = await screen.findByRole("checkbox", { name: "Enable Paper Search" });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings/mcp/paper-search?enabled=false",
        expect.objectContaining({ method: "PUT" }),
      );
    });
    expect(checkbox).not.toBeChecked();
  });

  it("keeps the Skills-style empty table when no server is configured", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ servers: [] }));
    renderTab("/tmp/ws");

    const table = await screen.findByRole("table");
    expect(within(table).getByText("No MCP servers configured.")).toBeInTheDocument();
  });
});
