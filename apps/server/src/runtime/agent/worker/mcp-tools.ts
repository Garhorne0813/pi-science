import { redactMcpError } from "../../../mcp/diagnostics.js";
import { readSessionApproval, sessionMode } from "../../sandbox/session-approval.js";
import { acquireMcpCall } from "../../../mcp/call-scheduler.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "typebox";
import { loadProjectedServers, loadProjectedSnapshot } from "../../shared/extensions/pi-science-mcp.js";
import { builtinNetworkEnvironment } from "../../../mcp/bindings.js";
import { createMcpFetch } from "../../../mcp/runtime-fetch.js";
import { UnixSocketClientTransport } from "../../../mcp/connector-probe.js";
import type { InteractionBridge } from "./interaction-bridge.js";
import { toolEnvironment } from "../agent-runtime-environment.js";
import { localMcpTransport } from "../../../mcp/sandbox-transport.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

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
  __piScienceBuiltin?: boolean;
  __piScienceProjectId?: string;
  __piScienceAllowPrivate?: boolean;
  requestTimeoutMs?: number;
  auth?: "oauth" | "bearer" | false;
};

const DISCOVERY_BUDGET_MS = 10_000;

async function beforeDeadline<T>(operation: Promise<T>, deadline: number, client: Client): Promise<T> {
  const remaining = Math.max(1, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void client.close().catch(() => undefined);
          reject(new Error("MCP discovery budget exceeded"));
        }, remaining);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

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
  approvalBoundProcesses = 0;
  readonly tools: AgentHarnessTool<{ env: NodeExecutionEnv }>[] = [];
  readonly diagnostics: string[] = [];

  static async open(cwd: string, bridge: InteractionBridge, environment: Record<string, string>, budgetMs = DISCOVERY_BUDGET_MS,
    allowedTools?: readonly string[], preauthorizedOnly = false, authorize?: (tool: string, signal?: AbortSignal) => Promise<void>, sessionId?: string): Promise<AgentMcpTools> {
    const result = new AgentMcpTools();
    const capabilities = allowedTools === undefined ? undefined : new Set(allowedTools);
    const rawSnapshot = loadProjectedSnapshot(cwd);
    const servers = loadProjectedServers(cwd, (name, error) => {
      result.diagnostics.push((redactMcpError(`${name}: ${error instanceof Error ? error.message : String(error)}`) ?? "MCP discovery failed").slice(0, 2048));
    }, (name) => capabilities === undefined || [...capabilities].some((tool) => tool.split("__").length === 3 && tool.split("__")[1] === name)) as Record<string, ServerDefinition>;
    const deadline = Date.now() + budgetMs;
    await Promise.all(Object.entries(servers).map(async ([name, server]) => {
      try { await result.connect(name, server, cwd, bridge, environment, deadline, capabilities, preauthorizedOnly, rawSnapshot.mcpServers[name], authorize, sessionId); }
      catch (error) {
        const code = (error as { code?: unknown }).code;
        const status = typeof code === "number" && code >= 400 && code <= 599 ? ` (HTTP ${code})` : "";
        result.diagnostics.push((redactMcpError(`${name}: ${error instanceof Error ? error.message : String(error)}${status}`) ?? "MCP discovery failed").slice(0, 2048));
      }
    }));
    return result;
  }

  private async connect(name: string, server: ServerDefinition, cwd: string, bridge: InteractionBridge, environment: Record<string, string>, deadline: number,
    capabilities?: ReadonlySet<string>, preauthorizedOnly = false, initial?: Record<string, unknown>, authorize?: (tool: string, signal?: AbortSignal) => Promise<void>, sessionId?: string): Promise<void> {
    if (server.auth === "oauth" && !Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
      throw new Error("OAuth MCP connector requires an authorized credential binding");
    }
    if (!server.__piScienceConnectorId) throw new Error("managed MCP connector id is missing");
    let transport: Transport;
    if (server.transport === "socket" && server.socket) {
      transport = new UnixSocketClientTransport(server.socket);
    } else if ((server.transport === "stdio" || !server.transport) && server.command) {
      if (!server.__piScienceBuiltin) this.approvalBoundProcesses++;
      transport = await localMcpTransport(cwd, server.command, server.args ?? [], server.cwd ?? cwd,
        { ...toolEnvironment(environment), ...server.env, ...(server.__piScienceBuiltin ? builtinNetworkEnvironment() : {}) }, server.__piScienceBuiltin ? name : undefined, sessionId);
    } else if ((server.transport === "sse" || server.transport === "streamable_http" || !server.transport) && server.url) {
      const connectorId = server.__piScienceConnectorId;
      const checkedFetch = createMcpFetch({ connectorId, projectId: server.__piScienceProjectId,
        endpoint: server.url, allowPrivate: server.__piScienceAllowPrivate === true });
      const requestInit = { headers: server.headers ?? {} };
      transport = (server.transport === "sse" || (!server.transport && server.url.endsWith("/sse")))
        ? new SSEClientTransport(new URL(server.url), { fetch: checkedFetch, requestInit })
        : new StreamableHTTPClientTransport(new URL(server.url), { fetch: checkedFetch, requestInit });
    } else throw new Error("unsupported MCP transport");
    const connectionIdentity = (value: Record<string, unknown> | undefined) => {
      if (!value) return "";
      const { approveTools, includeTools, excludeTools, __piScienceAllowedTools, ...connection } = value;
      return JSON.stringify(connection);
    };
    const initialIdentity = connectionIdentity(initial);
    const currentPolicy = (toolName: string): ServerDefinition => {
      const snapshot = loadProjectedSnapshot(cwd);
      const current = snapshot.mcpServers[name] as ServerDefinition | undefined;
      if (!current || snapshot.project_id !== server.__piScienceProjectId || connectionIdentity(current) !== initialIdentity || !visible(current, toolName)) {
        throw new Error(`MCP tool disabled or connector changed: ${name}: ${toolName}; refresh the worker`);
      }
      return current;
    };
    if (connectionIdentity(loadProjectedSnapshot(cwd).mcpServers[name]) !== initialIdentity) throw new Error("MCP connector changed during discovery");
    const client = new Client({ name: "pi-science-agent-core", version: "0.1.0" });
    try {
      await beforeDeadline(client.connect(transport, { timeout: Math.min(server.requestTimeoutMs ?? 15_000, Math.max(1, deadline - Date.now())) }), deadline, client);
      const listing = await beforeDeadline(client.listTools(undefined, { timeout: Math.min(server.requestTimeoutMs ?? 15_000, Math.max(1, deadline - Date.now())) }), deadline, client);
      const count = listing.tools.length;
      if (count > 500) throw new Error("MCP server advertised too many tools");
      for (const tool of listing.tools) {
        if (capabilities && !capabilities.has(`mcp__${name}__${tool.name}`)) continue;
        if (!visible(server, tool.name)) continue;
        this.tools.push({
          name: `mcp__${name}__${tool.name}`,
          label: `${name}: ${tool.name}`,
          description: tool.description ?? `${name} MCP tool ${tool.name}`,
          parameters: tool.inputSchema as TSchema,
          async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
            let policy = currentPolicy(tool.name);
            const approvalRevision = sessionId && !preauthorizedOnly ? (await readSessionApproval(cwd, sessionId)).revision : undefined;
            const mode = sessionId && !preauthorizedOnly ? await sessionMode(cwd, sessionId) : "ask";
            const safe = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true && (tool.annotations?.idempotentHint === true || server.__piScienceBuiltin === true);
            let approvedByUser = mode === "full" || mode === "auto" && safe;
            let approvalMs = 0;
            if (permissionRequired(policy, tool.name) && !approvedByUser) {
              if (preauthorizedOnly) throw new Error(`Delegated MCP tool requires explicit preauthorization in MCP settings: ${name}: ${tool.name}`);
              const approvalStarted = Date.now();
              _onUpdate({ content: [], details: { approval: "waiting" } });
              const approved = await bridge.confirmPermission(`Allow ${name}: ${tool.name}?`,
                `Arguments: ${JSON.stringify(params).slice(0, 4_000)}`, context.abortSignal, _toolCallId);
              approvalMs = Date.now() - approvalStarted;
              _onUpdate({ content: [], details: { approval: "resolved" } });
              approvedByUser = approved;
              if (!approved) return { content: [{ type: "text", text: "MCP tool call was declined by the user" }], details: { declined: true, scheduling: { approval_ms: approvalMs } }, isError: true };
            }
            // Approval may race with connector disable/revocation. Recheck before dispatch.
            policy = currentPolicy(tool.name);
            if (permissionRequired(policy, tool.name) && !approvedByUser) throw new Error("MCP authorization revoked before dispatch");
            if (context.abortSignal?.aborted) throw context.abortSignal.reason;
            const slot = await acquireMcpCall(cwd, JSON.stringify([server.__piScienceProjectId, server.__piScienceConnectorId]), context.abortSignal);
            const started = Date.now();
            try {
            // Queued calls must observe revocations made while they waited.
            await authorize?.(`mcp__${name}__${tool.name}`, context.abortSignal);
            context.abortSignal?.throwIfAborted();
            policy = currentPolicy(tool.name);
            if (permissionRequired(policy, tool.name) && !approvedByUser) throw new Error("MCP authorization revoked before dispatch");
            if (approvalRevision !== undefined && sessionId && (await readSessionApproval(cwd, sessionId)).revision !== approvalRevision) throw new Error("MCP approval revision changed while queued; request fresh authorization");
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
            return { content, details: { result: response.structuredContent, scheduling: { approval_ms: approvalMs, queued_ms: slot.queuedMs, execution_ms: Date.now() - started } }, isError: response.isError === true };
            } finally { await slot.release(); }
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
