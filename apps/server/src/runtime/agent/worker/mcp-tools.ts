import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "typebox";
import { loadProjectedServers } from "../../pi/extensions/pi-science-mcp.js";
import { createMcpFetch } from "../../../mcp/runtime-fetch.js";
import { UnixSocketClientTransport } from "../../../mcp/connector-probe.js";
import type { InteractionBridge } from "./interaction-bridge.js";

type ServerDefinition = {
  command?: string;
  transport?: "stdio" | "socket" | "streamable_http" | "sse";
  socket?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  includeTools?: string[];
  excludeTools?: string[];
  approveTools?: boolean | string[];
  __piScienceAllowedTools?: string[];
  __piScienceConnectorId?: string;
  __piScienceProjectId?: string;
  __piScienceAllowPrivate?: boolean;
  requestTimeoutMs?: number;
  auth?: "oauth" | "bearer" | false;
};

function permissionRequired(server: ServerDefinition, toolName: string): boolean {
  if (server.__piScienceAllowedTools?.includes(toolName)) return false;
  if (server.approveTools === false) return false;
  if (Array.isArray(server.approveTools)) return server.approveTools.includes(toolName);
  return true;
}

function visible(server: ServerDefinition, toolName: string): boolean {
  if (server.includeTools?.length && !server.includeTools.includes(toolName)) return false;
  return !server.excludeTools?.includes(toolName);
}

/** Official MCP SDK clients owned by one session worker. Managed snapshot policy stays authoritative. */
export class AgentMcpTools {
  private readonly clients: Client[] = [];
  readonly tools: AgentHarnessTool<{ env: NodeExecutionEnv }>[] = [];
  readonly diagnostics: string[] = [];

  static async open(cwd: string, bridge: InteractionBridge, environment: Record<string, string>): Promise<AgentMcpTools> {
    const result = new AgentMcpTools();
    const servers = loadProjectedServers(cwd) as Record<string, ServerDefinition>;
    for (const [name, server] of Object.entries(servers)) {
      try { await result.connect(name, server, cwd, bridge, environment); }
      catch (error) { result.diagnostics.push(`${name}: ${error instanceof Error ? error.message : String(error)}${typeof (error as { code?: unknown }).code === "number" ? ` (HTTP ${(error as { code: number }).code})` : ""}`); }
    }
    return result;
  }

  private async connect(name: string, server: ServerDefinition, cwd: string, bridge: InteractionBridge, environment: Record<string, string>): Promise<void> {
    if (server.auth === "oauth" && !Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
      throw new Error("OAuth MCP connector requires an authorized credential binding");
    }
    if (!server.__piScienceConnectorId) throw new Error("managed MCP connector id is missing");
    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | UnixSocketClientTransport;
    if (server.transport === "socket" && server.socket) {
      transport = new UnixSocketClientTransport(server.socket);
    } else if ((server.transport === "stdio" || !server.transport) && server.command) {
      transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], cwd: server.cwd ?? cwd,
        env: { ...environment, ...server.env }, stderr: "pipe" });
    } else if ((server.transport === "sse" || server.transport === "streamable_http" || !server.transport) && server.url) {
      const connectorId = server.__piScienceConnectorId;
      const checkedFetch = createMcpFetch({ connectorId, projectId: server.__piScienceProjectId,
        endpoint: server.url, allowPrivate: server.__piScienceAllowPrivate === true });
      const requestInit = { headers: server.headers ?? {} };
      transport = (server.transport === "sse" || (!server.transport && server.url.endsWith("/sse")))
        ? new SSEClientTransport(new URL(server.url), { fetch: checkedFetch, requestInit })
        : new StreamableHTTPClientTransport(new URL(server.url), { fetch: checkedFetch, requestInit });
    } else throw new Error("unsupported MCP transport");
    const client = new Client({ name: "pi-science-agent-core", version: "0.1.0" });
    try {
      await client.connect(transport, { timeout: server.requestTimeoutMs ?? 15_000 });
      const listing = await client.listTools(undefined, { timeout: server.requestTimeoutMs ?? 15_000 });
      const count = listing.tools.length;
      if (count > 500) throw new Error("MCP server advertised too many tools");
      for (const tool of listing.tools) {
        if (!visible(server, tool.name)) continue;
        this.tools.push({
          name: `mcp__${name}__${tool.name}`,
          label: `${name}: ${tool.name}`,
          description: tool.description ?? `${name} MCP tool ${tool.name}`,
          parameters: tool.inputSchema as TSchema,
          async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
            if (permissionRequired(server, tool.name)) {
              const approved = await bridge.confirmPermission(`Allow ${name}: ${tool.name}?`,
                `Arguments: ${JSON.stringify(params).slice(0, 4_000)}`, context.abortSignal);
              if (!approved) return { content: [{ type: "text", text: "MCP tool call was declined by the user" }], details: { declined: true }, isError: true };
            }
            const response = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined,
              { signal: context.abortSignal, timeout: server.requestTimeoutMs ?? 60_000 });
            const parts = Array.isArray(response.content) ? response.content as Array<Record<string, unknown>> : [];
            const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
            for (const part of parts) {
              if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
              if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
                content.push({ type: "image", data: part.data, mimeType: part.mimeType });
              }
            }
            return { content, details: response.structuredContent, isError: response.isError === true };
          },
        });
      }
      this.clients.push(client);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
    this.clients.length = 0;
  }
}
