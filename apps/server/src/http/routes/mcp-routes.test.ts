import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { McpConnectorService } from "../../mcp/connector-service.js";
import { McpRuntimeProjection } from "../../mcp/runtime-projection.js";
import { McpRepository } from "../../storage/sqlite/repositories/mcp-repository.js";
import { WorkspaceRepository } from "../../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "../../storage/sqlite/state-store.js";
import { registerMcpRoutes } from "./mcp-routes.js";

const stores: InMemorySqliteStateStore[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.allSettled(stores.splice(0).map((store) => store.close())); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-mcp-routes-")); directories.push(cwd); await mkdir(join(cwd, "src")); await mkdir(join(cwd, ".pi-science"));
  const store = new InMemorySqliteStateStore(); stores.push(store); await store.start();
  const repository = new McpRepository(store);
  const service = new McpConnectorService(repository, new WorkspaceRepository(store), { read: async () => ({}) } as never, undefined, new McpRuntimeProjection(repository));
  const app = Fastify({ logger: false }); registerMcpRoutes(app, service);
  await service.materializeWorkspace(cwd);
  return { app, cwd, service };
}

describe("canonical MCP routes", () => {
  it("creates, globally configures and deletes a connector while materializing every workspace runtime", async () => {
    const { app, cwd } = await fixture();
    const created = await app.inject({ method: "POST", url: "/api/mcp/connectors", payload: {
      name: "local-tools", display_name: "Local tools", description: "test", transport: "stdio", command: process.execPath, args: ["server.js"],
      runtime_config: { cwd: "src", lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false }, enabled: true,
    } });
    expect(created.statusCode).toBe(201);
    const connector = created.json();
    expect(connector).toMatchObject({ name: "local-tools", settings: { enabled: true, approval_mode: "ask" } });

    const listed = await app.inject({ method: "GET", url: "/api/mcp/connectors" });
    expect(listed.json().connectors).toHaveLength(1);
    const snapshot = JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8"));
    expect(snapshot.mcpServers["local-tools"]).toMatchObject({ command: process.execPath, args: ["server.js"], cwd: "src", approveTools: true });

    const disabled = await app.inject({ method: "PUT", url: `/api/mcp/connectors/${connector.connector_id}/settings`, payload: { enabled: false, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: connector.settings.revision } });
    expect(disabled.statusCode).toBe(200);
    expect(JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8")).mcpServers).toEqual({});

    expect((await app.inject({ method: "DELETE", url: `/api/mcp/connectors/${connector.connector_id}` })).statusCode).toBe(204);
    await app.close();
  });

  it("rejects local connector working directories that escape the workspace", async () => {
    const { app, cwd } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/mcp/connectors", payload: {
      name: "escape", display_name: "Escape", transport: "stdio", command: process.execPath, args: [],
      runtime_config: { cwd: "../outside", lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false }, enabled: false,
    } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "workspace_escape" });
    await app.close();
  });

  it("seeds paper-search as an immutable builtin with three discoverable tools", async () => {
    const { app, cwd, service } = await fixture();
    await service.ensureBuiltins();
    await service.ensureBuiltins();
    const listed = await app.inject({ method: "GET", url: `/api/mcp/connectors?cwd=${encodeURIComponent(cwd)}` });
    expect(listed.json().connectors).toEqual([expect.objectContaining({ connector_id: "mcp_builtin_paper_search", name: "paper-search", source: "builtin", transport: "stdio", tool_count: 3 })]);

    const cachedTools = await app.inject({ method: "GET", url: `/api/mcp/connectors/mcp_builtin_paper_search/tools?cwd=${encodeURIComponent(cwd)}` });
    expect(cachedTools.statusCode).toBe(200);
    expect(cachedTools.json().tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["search_arxiv", "search_crossref", "search_pubmed"]);

    const probe = await app.inject({ method: "POST", url: "/api/mcp/connectors/mcp_builtin_paper_search/probe" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["search_arxiv", "search_crossref", "search_pubmed"]);

    expect((await app.inject({ method: "DELETE", url: "/api/mcp/connectors/mcp_builtin_paper_search" })).statusCode).toBe(403);
    await app.close();
  });

  it("lists globally enabled connectors and cached tools without workspace parameters", async () => {
    const { app, cwd, service } = await fixture();
    await service.ensureBuiltins();

    const listed = await app.inject({ method: "GET", url: "/api/mcp/connectors" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ connectors: [expect.objectContaining({ name: "paper-search", source: "builtin", settings: expect.objectContaining({ enabled: true }), tool_count: 3 })] });

    const tools = await app.inject({ method: "GET", url: "/api/mcp/connectors/mcp_builtin_paper_search/tools" });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().tools).toHaveLength(3);

    const grant = await app.inject({ method: "PUT", url: "/api/mcp/connectors/mcp_builtin_paper_search/tools/search_pubmed", payload: { decision: "allow" } });
    expect(grant.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/mcp/connectors" })).json().connectors[0].settings.approval_mode).toBe("custom");
    expect(JSON.parse(await readFile(join(cwd, ".pi-science", "mcp-runtime.json"), "utf8")).mcpServers["paper-search"].approveTools.sort())
      .toEqual(["search_arxiv", "search_crossref"]);
    await app.close();
  });
});
