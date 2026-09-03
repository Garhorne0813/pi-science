import { bindingError, resolveBindings as bindings, mcpBaseEnvironment } from "./bindings.js";
import { createMcpFetch } from "./runtime-fetch.js";
import { resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolSummary } from "@pi-science/contracts";
import type { StoredMcpConnector } from "../storage/sqlite/repositories/mcp-repository.js";

export async function connectAndListMcpTools(connector: StoredMcpConnector, workspace: string): Promise<McpToolSummary[]> {
  const invalid = bindingError(connector.runtime_config, connector.credential_ref);
  if (invalid) throw new Error(invalid);
  const guardedFetch = createMcpFetch({ connectorId: connector.connector_id, endpoint: connector.endpoint_url, allowPrivate: connector.runtime_config.allow_private, note: "mcp_probe" });
  const timeoutMs = connector.runtime_config.request_timeout_ms ?? 15_000;
  const headers = bindings(connector.runtime_config.headers);
  let transport: Transport;
  if (connector.transport === "socket") {
    transport = new UnixSocketClientTransport(connector.socket_path!);
  } else if (connector.transport === "stdio") {
    transport = new StdioClientTransport({
      command: connector.command!, args: connector.args,
      cwd: resolve(workspace, connector.runtime_config.cwd ?? "."),
      env: { ...mcpBaseEnvironment(), ...bindings(connector.runtime_config.environment) }, stderr: "pipe",
    });
  } else if (connector.transport === "sse") {
    transport = new SSEClientTransport(new URL(connector.endpoint_url!), { requestInit: { headers }, fetch: guardedFetch });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(connector.endpoint_url!), { requestInit: { headers }, fetch: guardedFetch });
  }
  const client = new Client({ name: "pi-science-control-plane", version: "0.1.0" });
  try {
    await limited(client.connect(transport), timeoutMs);
    const response = await limited(client.listTools(), timeoutMs);
    return response.tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      read_only: tool.annotations?.readOnlyHint ?? null,
      decision: "ask" as const,
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

class UnixSocketClientTransport implements Transport {
  private socket?: Socket;
  private readonly buffer = new ReadBuffer();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(private readonly path: string) {}
  async start(): Promise<void> {
    await new Promise<void>((resolveStart, reject) => {
      const socket = createConnection(this.path); this.socket = socket; let connected = false;
      socket.once("connect", () => { connected = true; resolveStart(); });
      socket.on("data", (chunk) => { try { this.buffer.append(chunk); for (;;) { const message = this.buffer.readMessage(); if (message === null) break; this.onmessage?.(message); } } catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); void this.close(); } });
      socket.on("error", (error) => { if (!connected) reject(error); this.onerror?.(error); });
      socket.on("close", () => { if (this.socket === socket) this.socket = undefined; this.buffer.clear(); this.onclose?.(); });
    });
  }
  async close(): Promise<void> { const socket = this.socket; this.socket = undefined; this.buffer.clear(); if (!socket || socket.destroyed) return; await new Promise<void>((resolveClose) => { const timer = setTimeout(() => socket.destroy(), 2_000); timer.unref(); socket.once("close", () => { clearTimeout(timer); resolveClose(); }); socket.end(); }); }
  async send(message: JSONRPCMessage): Promise<void> { const socket = this.socket; if (!socket || socket.destroyed) throw new Error("Unix socket is not connected"); await new Promise<void>((resolveSend, reject) => socket.write(serializeMessage(message), (error) => error ? reject(error) : resolveSend())); }
}

async function limited<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP probe timed out after ${timeoutMs}ms`)), timeoutMs); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
