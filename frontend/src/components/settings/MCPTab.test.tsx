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
  if (url === "/api/mcp/connectors" && method === "GET") {
    return jsonResponse({
      connectors: [{
        connector_id: "mcp-paper-search",
        name: "paper-search",
        display_name: "Paper Search",
        description: "Search scientific literature",
        source: "custom", transport: "stdio", endpoint_url: null, command: "node", args: ["server.js"], socket_path: null,
        runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false },
        credential_ref: null, revision: 1, created_at: 1, updated_at: 1,
        settings: { connector_id: "mcp-paper-search", enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: 1, created_at: 1, updated_at: 1 },
        config_state: "valid", auth_state: "not-required", runtime_state: "ready", tool_count: 2, error: null,
      }],
      legacy_count: 0,
    });
  }
  if (url === "/api/mcp/connectors/mcp-paper-search/settings" && method === "PUT") {
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

beforeEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCPTab", () => {
  it("offers the same global connector controls when no workspace is active", async () => {
    renderTab(null);
    expect(await screen.findByText("Paper Search")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Enable Paper Search" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add connector" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("presents canonical MCP connectors with explicit runtime state", async () => {
    renderTab("/tmp/ws");

    const table = await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Add connector" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import old configuration/ })).not.toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(within(table).getByText("Paper Search")).toBeInTheDocument();
    expect(within(table).getByText(/2 tools/)).toBeInTheDocument();
    expect(within(table).getByRole("checkbox", { name: "Enable Paper Search" })).toBeChecked();
  });

  it("toggles a server with the enabled checkbox", async () => {
    renderTab("/tmp/ws");

    const checkbox = await screen.findByRole("checkbox", { name: "Enable Paper Search" });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mcp/connectors/mcp-paper-search/settings",
        expect.objectContaining({ method: "PUT", body: expect.stringContaining('"enabled":false') }),
      );
    });
  });

  it("keeps the Skills-style empty table when no server is configured", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ connectors: [], legacy_count: 0 }));
    renderTab("/tmp/ws");

    const table = await screen.findByRole("table");
    expect(within(table).getByText("No MCP servers configured.")).toBeInTheDocument();
  });

  it("shows the connector creation form", async () => {
    renderTab("/tmp/ws");
    fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create and enable" })).toBeDisabled();
  });

  it("only offers legacy import when a safe old connector is available", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ connectors: [], legacy_count: 1 }));
    renderTab("/tmp/ws");
    expect(await screen.findByRole("button", { name: "Import old configuration (1)" })).toBeInTheDocument();
  });

  it("renders the MCP management controls in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");
    renderTab("/tmp/ws");

    expect(await screen.findByRole("button", { name: "添加连接器" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "状态" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "启用 Paper Search" })).toBeChecked();
    expect(screen.getByText("就绪")).toBeInTheDocument();
    expect(screen.getByText(/2 个工具/)).toBeInTheDocument();
  });

  it("hides the raw launch command for built-in connectors in the detail panel", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method || "GET").toUpperCase();
      if (url === "/api/mcp/connectors" && method === "GET") {
        return jsonResponse({
          connectors: [{
            connector_id: "mcp-paper-search",
            name: "paper-search",
            display_name: "Paper Search",
            description: "Search scientific literature",
            source: "builtin", transport: "stdio", endpoint_url: null, command: "/repo/apps/server/node_modules/.bin/tsx", args: ["/repo/apps/server/src/mcp/builtin/paper-search-server.ts"], socket_path: null,
            runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false },
            credential_ref: null, revision: 1, created_at: 1, updated_at: 1,
            settings: { connector_id: "mcp-paper-search", enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: 1, created_at: 1, updated_at: 1 },
            config_state: "valid", auth_state: "not-required", runtime_state: "ready", tool_count: 3, error: null,
          }],
          legacy_count: 0,
        });
      }
      if (url === "/api/mcp/connectors/mcp-paper-search/tools" && method === "GET") {
        return jsonResponse({ tools: [], cached_at: null });
      }
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    renderTab("/tmp/ws");

    fireEvent.click(await screen.findByRole("button", { name: /Paper Search/ }));

    expect(await screen.findByText("Built into Pi-Science and shipped with the app — no manual configuration needed.")).toBeInTheDocument();
    expect(screen.queryByText(/tsx/)).not.toBeInTheDocument();
  });
});
