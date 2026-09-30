import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AgentMcpTools } from "./mcp-tools.js";
import { InteractionBridge } from "./interaction-bridge.js";

describe("agent-core managed MCP tools", () => {
  it("uses the official SDK for a managed stdio connector and calls an exposed tool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-mcp-"));
    let mcp: AgentMcpTools | undefined;
    try {
      await mkdir(join(cwd, ".pi-science"));
      const server = join(cwd, "server.mjs");
      await writeFile(server, [
        `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};`,
        `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};`,
        `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};`,
        `const server = new McpServer({ name: "test", version: "1" });`,
        `server.registerTool("echo", { description: "Echo", inputSchema: { value: z.string() } }, async ({ value }) => ({ content: [{ type: "text", text: value }] }));`,
        `await server.connect(new StdioServerTransport());`,
      ].join("\n"));
      await writeFile(join(cwd, ".pi-science", "mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "project_test",
        mcpServers: { local: { command: process.execPath, args: [server], approveTools: true,
          __piScienceConnectorId: "connector_test", includeTools: ["echo"] } } }));
      const interactions: Array<Record<string, unknown>> = [];
      const bridge = new InteractionBridge((event) => interactions.push(event));
      mcp = await AgentMcpTools.open(cwd, bridge, { PATH: process.env.PATH ?? "" });
      expect(mcp.diagnostics).toEqual([]);
      expect(mcp.tools.map((tool) => tool.name)).toEqual(["mcp__local__echo"]);
      const pending = mcp.tools[0]!.execute("call-1", { value: "hello" }, () => undefined,
        {} as never, {} as never, { abortSignal: undefined } as never);
      expect(interactions).toMatchObject([{ type: "extension_ui_request", kind: "permission", method: "confirm", id: expect.any(String) }]);
      bridge.notify("extension_ui_response", { id: interactions[0]!.id, confirmed: true });
      const result = await pending;
      expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    } finally {
      await mcp?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it("uses the checked HTTP transport for a managed local endpoint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-mcp-http-"));
    const serverErrors: string[] = [];
    const http = createServer((request, response) => { void (async () => {
      const server = new McpServer({ name: "http-test", version: "1" });
      server.registerTool("echo", { description: "Echo", inputSchema: { value: z.string() } },
        async ({ value }) => ({ content: [{ type: "text", text: value }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      response.once("close", () => { void transport.close(); void server.close(); });
      await transport.handleRequest(request, response);
    })().catch((error) => {
      serverErrors.push(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }); });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    let mcp: AgentMcpTools | undefined;
    try {
      await mkdir(join(cwd, ".pi-science"));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      await writeFile(join(cwd, ".pi-science", "mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "project_test",
        mcpServers: { remote: { url: `http://127.0.0.1:${address.port}/mcp`, approveTools: false,
          __piScienceConnectorId: "connector_http", __piScienceAllowPrivate: true } } }));
      mcp = await AgentMcpTools.open(cwd, new InteractionBridge(() => undefined), { PATH: process.env.PATH ?? "" });
      expect({ diagnostics: mcp.diagnostics, serverErrors }).toEqual({ diagnostics: [], serverErrors: [] });
      expect(mcp.tools.map((tool) => tool.name)).toEqual(["mcp__remote__echo"]);
      const result = await mcp.tools[0]!.execute("call-1", { value: "over HTTP" }, () => undefined,
        {} as never, {} as never, { abortSignal: undefined } as never);
      expect(result.content).toEqual([{ type: "text", text: "over HTTP" }]);
    } finally {
      await mcp?.close();
      http.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it("bounds discovery across stalled connectors and reports both diagnostics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-mcp-stalled-"));
    const stalled = createServer(() => undefined);
    stalled.listen(0, "127.0.0.1");
    await once(stalled, "listening");
    try {
      const address = stalled.address();
      if (!address || typeof address === "string") throw new Error("missing port");
      await mkdir(join(cwd, ".pi-science"));
      const endpoint = `http://127.0.0.1:${address.port}/mcp`;
      await writeFile(join(cwd, ".pi-science", "mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "project_test",
        mcpServers: Object.fromEntries(["first", "second"].map((name) => [name, {
          url: endpoint, transport: "streamable_http", requestTimeoutMs: 15_000,
          __piScienceConnectorId: `connector_${name}`, __piScienceAllowPrivate: true,
        }])) }));
      const started = Date.now();
      const mcp = await AgentMcpTools.open(cwd, new InteractionBridge(() => undefined), {}, 300);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(mcp.tools).toEqual([]);
      expect(mcp.diagnostics).toHaveLength(2);
      await mcp.close();
    } finally {
      stalled.closeAllConnections();
      stalled.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 5_000);

  it("keeps the session usable when a connector binding is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-mcp-missing-"));
    try {
      await mkdir(join(cwd, ".pi-science"));
      await writeFile(join(cwd, ".pi-science", "mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "project_test",
        mcpServers: { unavailable: { __piScienceConnectorId: "connector_missing", command: "node",
          __piScienceEnvironment: { TOKEN: { kind: "environment", name: "UNSET_LAB_KEY_FOR_TEST" } } } } }));
      const mcp = await AgentMcpTools.open(cwd, new InteractionBridge(() => undefined), {});
      expect(mcp.tools).toEqual([]);
      expect(mcp.diagnostics).toEqual(["unavailable: Missing MCP environment variable: UNSET_LAB_KEY_FOR_TEST"]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
