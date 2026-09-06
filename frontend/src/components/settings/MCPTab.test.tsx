import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";
import { MCPTab } from "./MCPTab";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const defaultFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
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
  if (url === "/api/mcp/connectors/mcp-paper-search/tools" && method === "GET") return jsonResponse({ tools: [], cached_at: null });
  if (url === "/api/mcp/connectors/mcp-paper-search/credential" && method === "GET") return jsonResponse({ credential_ref: null, configured: false, backend: null, delivery: null, target_name: null, environment_variable: null, suggested_delivery: "environment", suggested_target_name: "NCBI_API_KEY" });
  if (url === "/api/mcp/connectors/mcp-paper-search/credential" && method === "PUT") return jsonResponse({ credential_ref: "mcp-paper-search", configured: true, backend: "managed", delivery: "environment", target_name: "NCBI_API_KEY", environment_variable: null, suggested_delivery: "environment", suggested_target_name: "NCBI_API_KEY" });
  return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
};
const fetchMock = vi.fn(defaultFetch);

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
  fetchMock.mockReset();
  fetchMock.mockImplementation(defaultFetch);
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

  it("expands connector details directly below its row and collapses in place", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method || "GET").toUpperCase();
      if (url === "/api/mcp/connectors" && method === "GET") return jsonResponse({
        connectors: [{
          connector_id: "mcp-paper-search", name: "paper-search", display_name: "Paper Search", description: "Search scientific literature",
          source: "builtin", transport: "stdio", endpoint_url: null, command: "node", args: ["server.js"], socket_path: null,
          runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false },
          credential_ref: null, revision: 1, created_at: 1, updated_at: 1,
          settings: { connector_id: "mcp-paper-search", enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: 1, created_at: 1, updated_at: 1 },
          config_state: "valid", auth_state: "not-required", runtime_state: "ready", tool_count: 1, error: null,
        }], legacy_count: 0,
      });
      if (url === "/api/mcp/connectors/mcp-paper-search/tools?cwd=%2Ftmp%2Fws" && method === "GET") return jsonResponse({ tools: [{ name: "search_pubmed", title: "Search PubMed", description: "Search papers", read_only: true, decision: "ask", decision_scope: "global" }], cached_at: 1 });
      if (url === "/api/mcp/connectors/mcp-paper-search/credential" && method === "GET") return jsonResponse({ credential_ref: null, configured: false, backend: null, delivery: null, target_name: null, environment_variable: null, suggested_delivery: "environment", suggested_target_name: "NCBI_API_KEY" });
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    renderTab("/tmp/ws");

    const toggle = await screen.findByRole("button", { name: "Show details for Paper Search" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    const permission = await screen.findByLabelText("Permission for search_pubmed");
    const summaryRow = toggle.closest("tr");
    const detailRow = permission.closest("tr");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(summaryRow?.nextElementSibling).toBe(detailRow);

    fireEvent.click(screen.getByRole("button", { name: "Hide details for Paper Search" }));
    expect(screen.queryByLabelText("Permission for search_pubmed")).not.toBeInTheDocument();
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

  it("saves connector authentication without displaying the secret again", async () => {
    renderTab(null);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Paper Search" }));
    const secret = await screen.findByLabelText("API key or token");
    fireEvent.change(secret, { target: { value: "test-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save authentication" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/mcp/connectors/mcp-paper-search/credential",
      expect.objectContaining({ method: "PUT", body: expect.stringContaining('"secret":"test-secret-value"') }),
    ));
    await waitFor(() => expect(secret).toHaveValue(""));
    expect(screen.queryByDisplayValue("test-secret-value")).not.toBeInTheDocument();
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
      if (url === "/api/mcp/connectors/mcp-paper-search/credential" && method === "GET") return jsonResponse({ credential_ref: null, configured: false, backend: null, delivery: null, target_name: null, environment_variable: null, suggested_delivery: "environment", suggested_target_name: "NCBI_API_KEY" });
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    renderTab("/tmp/ws");

    fireEvent.click(await screen.findByRole("button", { name: /Paper Search/ }));

    expect(await screen.findByText(/Built into Pi-Science/)).toBeInTheDocument();
    expect(screen.queryByText(/tsx/)).not.toBeInTheDocument();
  });
});
