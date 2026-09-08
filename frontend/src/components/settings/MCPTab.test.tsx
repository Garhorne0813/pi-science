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
    expect(screen.getByRole("button", { name: "Import existing config" })).toBeInTheDocument();
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

  it("shows the import entry at all times and annotates discovered legacy entries", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ connectors: [], legacy_count: 1 }));
    renderTab("/tmp/ws");
    expect(await screen.findByRole("button", { name: "Import existing config (1)" })).toBeInTheDocument();
  });

  it("clears transport-specific values when transport changes", async () => {
    renderTab("/tmp/ws");
    fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "stdio" } });
    expect(screen.getByLabelText("Command")).toHaveValue("");
  });

  it("rejects malformed remote URLs before submission", async () => {
    renderTab("/tmp/ws");
    fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Remote" } });
    fireEvent.change(screen.getByLabelText("ID"), { target: { value: "remote" } });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "not-a-url" } });
    expect(screen.getByRole("button", { name: "Create and enable" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/mcp/connectors", expect.objectContaining({ method: "POST" }));
  });

  it("searches and filters connectors", async () => {
    renderTab("/tmp/ws");
    await screen.findByText("Paper Search");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "missing" } });
    expect(screen.getByText("No connectors match the current search and filter.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter connectors"), { target: { value: "remote" } });
    expect(screen.getByText("No connectors match the current search and filter.")).toBeInTheDocument();
  });

  it("probes immediately after creating a connector", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); const method = (init.method || "GET").toUpperCase();
      if (url === "/api/mcp/connectors" && method === "POST") return jsonResponse({
        connector_id: "mcp-new", name: "new", display_name: "New", description: "", source: "custom", transport: "streamable_http", endpoint_url: "https://example.com/mcp", command: null, args: [], socket_path: null,
        runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "auto", allow_private: false }, credential_ref: null, revision: 1, created_at: 1, updated_at: 1,
        settings: { connector_id: "mcp-new", enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: 1, created_at: 1, updated_at: 1 }, config_state: "valid", auth_state: "not-required", runtime_state: "unknown", tool_count: 0, error: null,
      }, 201);
      if (url === "/api/mcp/connectors/mcp-new/probe" && method === "POST") return jsonResponse({ runtime_state: "ready", auth_state: "not-required", error: null, tools: [] });
      return defaultFetch(input, init);
    });
    renderTab("/tmp/ws");
    fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("ID"), { target: { value: "new" } });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and enable" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mcp/connectors/mcp-new/probe", expect.objectContaining({ method: "POST" })));
  });

  it("opens an editable form for custom connectors", async () => {
    renderTab(null);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Paper Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("heading", { name: "Edit connector" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Paper Search");
    expect(screen.getByLabelText("Command")).toHaveValue("node");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("previews importable legacy connectors before committing", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); const method = (init.method || "GET").toUpperCase();
      if (url === "/api/mcp/import/preview?cwd=%2Ftmp%2Fws" && method === "POST") return jsonResponse({ source: "/tmp/ws/.mcp.json", entries: [{ name: "legacy-tools", transport: "stdio", importable: true, conflict: false, contains_sensitive_fields: false }] });
      return defaultFetch(input, init);
    });
    renderTab("/tmp/ws");
    fireEvent.click(await screen.findByRole("button", { name: "Import existing config" }));
    expect(await screen.findByText("/tmp/ws/.mcp.json")).toBeInTheDocument();
    expect(screen.getByText("legacy-tools")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import selected (1)" })).toBeEnabled();
  });

  it("preserves quoted and escaped local command arguments", async () => {
    renderTab("/tmp/ws");
    fireEvent.click(await screen.findByRole("button", { name: "Add connector" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Local" } });
    fireEvent.change(screen.getByLabelText("ID"), { target: { value: "local" } });
    fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "stdio" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: '--config "/Users/me/My Project/config.json" --label escaped\\ value ""' } });
    fireEvent.click(screen.getByRole("button", { name: "Create and enable" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mcp/connectors", expect.objectContaining({ method: "POST" })));
    const request = fetchMock.mock.calls.find(([url, init]) => url === "/api/mcp/connectors" && (init as RequestInit)?.method === "POST")![1] as RequestInit;
    expect(JSON.parse(String(request.body)).args).toEqual(["--config", "/Users/me/My Project/config.json", "--label", "escaped value", ""]);
  });

  it("shows credential request failures instead of an endless loading state", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); const method = (init.method || "GET").toUpperCase();
      if (url === "/api/mcp/connectors/mcp-paper-search/credential" && method === "GET") return jsonResponse({ error: "Credential service unavailable" }, 503);
      return defaultFetch(input, init);
    });
    renderTab(null);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Paper Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Credential service unavailable");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("does not offer an API key for built-in connectors that cannot consume one", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); const method = (init.method || "GET").toUpperCase();
      if (url === "/api/mcp/connectors" && method === "GET") return jsonResponse({ connectors: [{
        connector_id: "mcp_builtin_clinical_trials", name: "clinical-trials", display_name: "Clinical Trials", description: "Search public trials",
        source: "builtin", transport: "stdio", endpoint_url: null, command: "node", args: ["server.js", "clinical_trials"], socket_path: null,
        runtime_config: { lifecycle: "lazy", expose_resources: false, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false },
        credential_ref: null, revision: 1, created_at: 1, updated_at: 1,
        settings: { connector_id: "mcp_builtin_clinical_trials", enabled: false, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: 1, created_at: 1, updated_at: 1 },
        config_state: "valid", auth_state: "not-required", runtime_state: "disabled", tool_count: 4, error: null,
      }], legacy_count: 0 });
      if (url === "/api/mcp/connectors/mcp_builtin_clinical_trials/tools" && method === "GET") return jsonResponse({ tools: [], cached_at: null });
      if (url === "/api/mcp/connectors/mcp_builtin_clinical_trials/credential" && method === "GET") return jsonResponse({ capability: "unsupported", credential_ref: null, configured: false, backend: null, delivery: null, target_name: null, environment_variable: null, suggested_delivery: null, suggested_target_name: null });
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    renderTab(null);

    fireEvent.click(await screen.findByRole("button", { name: "Show details for Clinical Trials" }));

    expect(await screen.findByText("This built-in connector uses public upstream endpoints and does not accept an API key.")).toBeInTheDocument();
    expect(screen.getByText("No key supported")).toBeInTheDocument();
    expect(screen.queryByLabelText("API key or token")).not.toBeInTheDocument();
    expect(screen.getByText("MCP connection: no authentication")).toBeInTheDocument();
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
