import { randomUUID } from "node:crypto";
import { McpExecutionClock } from "./mcp-execution-clock.js";
import { fingerprintMcpConnection } from "../../../mcp/connection-identity.js";
import {
  authorizeMcpConnector,
  authorizeMcpTool,
  mcpApprovalKey,
} from "../../../mcp/runtime-policy.js";
import { redactMcpError } from "../../../mcp/diagnostics.js";
import { readSessionApproval, sessionMode } from "../../sandbox/session-approval.js";
import { acquireMcpCall } from "../../../mcp/call-scheduler.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "typebox";
import {
  loadProjectedServers,
  loadProjectedSnapshot,
} from "../../shared/extensions/pi-science-mcp.js";
import { builtinNetworkEnvironment } from "../../../mcp/bindings.js";
import { createMcpFetch } from "../../../mcp/runtime-fetch.js";
import { UnixSocketClientTransport } from "../../../mcp/connector-probe.js";
import type { InteractionBridge } from "./interaction-bridge.js";
import { toolEnvironment } from "../agent-runtime-environment.js";
import { localMcpTransport } from "../../../mcp/sandbox-transport.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolProgressV1 } from "@pi-science/contracts";

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
  __piScienceConnectorRevision?: number;
  __piScienceSettingsRevision?: number;
  __piScienceBuiltin?: boolean;
  __piScienceProjectId?: string;
  __piScienceAllowPrivate?: boolean;
  requestTimeoutMs?: number;
  auth?: "oauth" | "bearer" | false;
};

const DISCOVERY_BUDGET_MS = 10_000;

function visible(server: ServerDefinition, toolName: string): boolean {
  if (server.includeTools?.length && !server.includeTools.includes(toolName)) return false;
  return !server.excludeTools?.includes(toolName);
}

/** Official MCP SDK clients owned by one session worker. Discovery and dispatch are admitted by the control plane. */
export class AgentMcpTools {
  private readonly clients: Client[] = [];
  approvalBoundProcesses = 0;
  readonly tools: AgentHarnessTool<{ env: NodeExecutionEnv }>[] = [];
  readonly diagnostics: string[] = [];

  static async open(
    cwd: string,
    bridge: InteractionBridge,
    environment: Record<string, string>,
    budgetMs = DISCOVERY_BUDGET_MS,
    allowedTools?: readonly string[],
    preauthorizedOnly = false,
    authorize?: (tool: string, signal?: AbortSignal) => Promise<void>,
    sessionId?: string,
    clock = new McpExecutionClock(),
    signal?: AbortSignal,
  ): Promise<AgentMcpTools> {
    const result = new AgentMcpTools();
    const capabilities = allowedTools === undefined ? undefined : new Set(allowedTools);
    const rawSnapshot = loadProjectedSnapshot(cwd);
    await Promise.all(
      Object.entries(rawSnapshot.mcpServers).map(async ([name, raw]) => {
        if (
          capabilities &&
          ![...capabilities].some(
            (tool) => tool.split("__").length === 3 && tool.split("__")[1] === name,
          )
        )
          return;
        const contextId = randomUUID();
        const deadline = clock.activeNow(contextId) + budgetMs;
        try {
          // Admit the exact raw snapshot before resolving credentials or constructing
          // a transport. Never re-read a different snapshot after authorization.
          await clock.run(
            contextId,
            deadline,
            "MCP discovery budget exceeded",
            (activeSignal) =>
              authorizeMcpConnector(
                cwd,
                {
                  connectorId: raw.__piScienceConnectorId as string,
                  projectId: rawSnapshot.project_id,
                  connectorRevision: raw.__piScienceConnectorRevision as number,
                  settingsRevision: raw.__piScienceSettingsRevision as number,
                  connectionFingerprint: fingerprintMcpConnection(name, raw),
                },
                activeSignal,
              ),
            signal,
          );
          const server = loadProjectedServers(
            cwd,
            undefined,
            (candidate) => candidate === name,
            rawSnapshot,
          )[name] as ServerDefinition;
          await result.connect(
            name,
            server,
            cwd,
            bridge,
            environment,
            deadline,
            capabilities,
            preauthorizedOnly,
            raw,
            authorize,
            sessionId,
            clock,
            contextId,
            signal,
          );
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          const status =
            typeof code === "number" && code >= 400 && code <= 599 ? ` (HTTP ${code})` : "";
          result.diagnostics.push(
            (
              redactMcpError(
                `${name}: ${error instanceof Error ? error.message : String(error)}${status}`,
              ) ?? "MCP discovery failed"
            ).slice(0, 2048),
          );
        }
      }),
    );
    if (signal?.aborted) {
      await result.close();
      signal.throwIfAborted();
    }
    return result;
  }

  private async connect(
    name: string,
    server: ServerDefinition,
    cwd: string,
    bridge: InteractionBridge,
    environment: Record<string, string>,
    deadline: number,
    capabilities?: ReadonlySet<string>,
    preauthorizedOnly = false,
    initial?: Record<string, unknown>,
    authorize?: (tool: string, signal?: AbortSignal) => Promise<void>,
    sessionId?: string,
    clock = new McpExecutionClock(),
    contextId = randomUUID(),
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      server.auth === "oauth" &&
      !Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === "authorization")
    ) {
      throw new Error("OAuth MCP connector requires an authorized credential binding");
    }
    if (!server.__piScienceConnectorId) throw new Error("managed MCP connector id is missing");
    let transport: Transport;
    if (server.transport === "socket" && server.socket) {
      transport = new UnixSocketClientTransport(server.socket);
    } else if ((server.transport === "stdio" || !server.transport) && server.command) {
      if (!server.__piScienceBuiltin) this.approvalBoundProcesses++;
      transport = await localMcpTransport(
        cwd,
        server.command,
        server.args ?? [],
        server.cwd ?? cwd,
        {
          ...toolEnvironment(environment),
          ...server.env,
          ...(server.__piScienceBuiltin ? builtinNetworkEnvironment() : {}),
        },
        server.__piScienceBuiltin ? name : undefined,
        sessionId,
        contextId,
      );
    } else if (
      (server.transport === "sse" || server.transport === "streamable_http" || !server.transport) &&
      server.url
    ) {
      const connectorId = server.__piScienceConnectorId;
      const checkedFetch = createMcpFetch({
        connectorId,
        projectId: server.__piScienceProjectId,
        endpoint: server.url,
        allowPrivate: server.__piScienceAllowPrivate === true,
      });
      const requestInit = { headers: server.headers ?? {} };
      transport =
        server.transport === "sse" || (!server.transport && server.url.endsWith("/sse"))
          ? new SSEClientTransport(new URL(server.url), { fetch: checkedFetch, requestInit })
          : new StreamableHTTPClientTransport(new URL(server.url), {
              fetch: checkedFetch,
              requestInit,
            });
    } else throw new Error("unsupported MCP transport");
    // Use the same identity as control-plane admission: mutable policy and
    // discovery counts must not invalidate an otherwise unchanged transport.
    const connectionIdentity = (value: Record<string, unknown> | undefined) =>
      value ? fingerprintMcpConnection(name, value) : "";
    const connectionFingerprint = connectionIdentity(initial);
    const currentPolicy = (toolName: string): ServerDefinition => {
      const snapshot = loadProjectedSnapshot(cwd);
      const current = snapshot.mcpServers[name] as ServerDefinition | undefined;
      if (
        !current ||
        snapshot.project_id !== server.__piScienceProjectId ||
        connectionIdentity(current) !== connectionFingerprint ||
        !visible(current, toolName)
      ) {
        throw new Error(
          `MCP tool disabled or connector changed: ${name}: ${toolName}; refresh the worker`,
        );
      }
      return current;
    };
    const client = new Client({ name: "pi-science-agent-core", version: "0.1.0" });
    try {
      if (connectionIdentity(loadProjectedSnapshot(cwd).mcpServers[name]) !== connectionFingerprint)
        throw new Error("MCP connector changed during discovery");
      const discovery = <T>(operation: (activeSignal: AbortSignal) => Promise<T>) =>
        clock.run(
          contextId,
          Math.min(deadline, clock.activeNow(contextId) + (server.requestTimeoutMs ?? 15_000)),
          "MCP discovery budget exceeded",
          operation,
          signal,
        );
      await discovery((activeSignal) =>
        client.connect(transport, { timeout: 2_147_483_647, signal: activeSignal }),
      );
      const listing = await discovery((activeSignal) =>
        client.listTools(undefined, { timeout: 2_147_483_647, signal: activeSignal }),
      );
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
            currentPolicy(tool.name);
            const checkAuthority = () =>
              authorizeMcpTool(
                cwd,
                {
                  connectorId: server.__piScienceConnectorId!,
                  projectId: server.__piScienceProjectId!,
                  toolName: tool.name,
                  connectorRevision: server.__piScienceConnectorRevision!,
                  settingsRevision: server.__piScienceSettingsRevision!,
                  connectionFingerprint,
                },
                context.abortSignal,
              );
            const decision = await checkAuthority();
            const approvalRevision =
              sessionId && !preauthorizedOnly
                ? (await readSessionApproval(cwd, sessionId)).revision
                : undefined;
            const mode =
              sessionId && !preauthorizedOnly ? await sessionMode(cwd, sessionId) : "ask";
            // Third-party annotations are untrusted claims, never permission.
            // The builtin flag is admitted against the database connection
            // fingerprint before discovery and again by checkAuthority above.
            const safe =
              server.__piScienceBuiltin === true &&
              tool.annotations?.readOnlyHint === true &&
              tool.annotations?.destructiveHint !== true;
            let approvedByUser = mode === "full" || (mode === "auto" && safe);
            let approvalMs = 0;
            if (decision === "ask" && !approvedByUser) {
              if (preauthorizedOnly)
                throw new Error(
                  `Delegated MCP tool requires explicit preauthorization in MCP settings: ${name}: ${tool.name}`,
                );
              const approvalStarted = Date.now();
              _onUpdate({ content: [], details: { approval: "waiting" } });
              let outcome: "allowed" | "approved" | "declined";
              try {
                outcome = await bridge.withPermission(
                  mcpApprovalKey({
                    projectId: server.__piScienceProjectId!,
                    connectorId: server.__piScienceConnectorId!,
                    toolName: tool.name,
                    connectorRevision: server.__piScienceConnectorRevision!,
                    settingsRevision: server.__piScienceSettingsRevision!,
                  }),
                  async () => {
                    currentPolicy(tool.name);
                    if (
                      approvalRevision !== undefined &&
                      sessionId &&
                      (await readSessionApproval(cwd, sessionId)).revision !== approvalRevision
                    )
                      throw new Error(
                        "MCP approval revision changed while queued; request fresh authorization",
                      );
                    // Another worker may have saved Always allow while this call waited.
                    if ((await checkAuthority()) === "allow") return "allowed";
                    const argumentsPreview = JSON.stringify(params).slice(0, 4_000);
                    return (await bridge.confirmPermission(
                      `Allow ${name}: ${tool.name}?`,
                      `Arguments: ${argumentsPreview}`,
                      context.abortSignal,
                      _toolCallId,
                      {
                        connectorId: server.__piScienceConnectorId!,
                        toolName: tool.name,
                        connectorRevision: server.__piScienceConnectorRevision,
                        settingsRevision: server.__piScienceSettingsRevision,
                      },
                      {
                        titleKey: "interaction.mcpPermission.title",
                        titleParams: { connector: name, tool: tool.name },
                        messageKey: "interaction.mcpPermission.arguments",
                        messageParams: { preview: argumentsPreview },
                      },
                    ))
                      ? "approved"
                      : "declined";
                  },
                  context.abortSignal,
                );
              } finally {
                approvalMs = Date.now() - approvalStarted;
                _onUpdate({ content: [], details: { approval: "resolved" } });
              }
              approvedByUser = outcome === "approved";
              if (outcome === "declined")
                return {
                  content: [{ type: "text", text: "MCP tool call was declined by the user" }],
                  details: { declined: true, scheduling: { approval_ms: approvalMs } },
                  isError: true,
                };
            }
            // Approval may race with connector disable/revocation. Recheck before dispatch.
            currentPolicy(tool.name);
            if (context.abortSignal?.aborted) throw context.abortSignal.reason;
            const slot = await acquireMcpCall(
              cwd,
              JSON.stringify([server.__piScienceProjectId, server.__piScienceConnectorId]),
              context.abortSignal,
            );
            const started = Date.now();
            try {
              // Queued calls must observe revocations made while they waited.
              await authorize?.(`mcp__${name}__${tool.name}`, context.abortSignal);
              context.abortSignal?.throwIfAborted();
              currentPolicy(tool.name);
              if (
                approvalRevision !== undefined &&
                sessionId &&
                (await readSessionApproval(cwd, sessionId)).revision !== approvalRevision
              )
                throw new Error(
                  "MCP approval revision changed while queued; request fresh authorization",
                );
              if ((await checkAuthority()) === "ask" && !approvedByUser)
                throw new Error("MCP authorization revoked before dispatch");
              let lastProgress: Omit<ToolProgressV1, "determinate"> | undefined;
              const response = await clock.run(
                contextId,
                clock.activeNow(contextId) + (server.requestTimeoutMs ?? 60_000),
                "MCP request timed out",
                (activeSignal) =>
                  client.callTool(
                    { name: tool.name, arguments: params as Record<string, unknown> },
                    undefined,
                    {
                      signal: activeSignal,
                      timeout: 2_147_483_647,
                      onprogress: ({ progress, total }) => {
                        if (
                          typeof progress !== "number" ||
                          !Number.isFinite(progress) ||
                          progress < 0
                        )
                          return;
                        // An external server re-estimates its total freely, and nothing in the
                        // protocol promises otherwise, so its total is never treated as fixed.
                        const value: Omit<ToolProgressV1, "determinate"> = {
                          version: 1,
                          scopeId: `mcp:${name}/${tool.name}`,
                          scopeLabel: `${name}: ${tool.name}`,
                          current: progress,
                          ...(total === undefined ? {} : { total }),
                          totalKind: total === undefined ? "unknown" : "reestimated",
                          source: "mcp",
                        };
                        lastProgress = value;
                        _onUpdate({ content: [], details: { progress: value } });
                      },
                    },
                  ),
                context.abortSignal,
              );
              const parts = Array.isArray(response.content)
                ? (response.content as Array<Record<string, unknown>>)
                : [];
              const content: Array<
                { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
              > = [];
              for (const part of parts) {
                if (part.type === "text" && typeof part.text === "string")
                  content.push({ type: "text", text: part.text });
                if (
                  part.type === "image" &&
                  typeof part.data === "string" &&
                  typeof part.mimeType === "string"
                ) {
                  content.push({ type: "image", data: part.data, mimeType: part.mimeType });
                }
              }
              return {
                content,
                details: {
                  result: response.structuredContent,
                  // The final notification is the value the row settles on;
                  // history restores it from these details.
                  ...(lastProgress ? { progress: lastProgress } : {}),
                  scheduling: {
                    approval_ms: approvalMs,
                    queued_ms: slot.queuedMs,
                    execution_ms: Date.now() - started,
                  },
                },
                isError: response.isError === true,
              };
            } finally {
              await slot.release();
            }
          },
        });
      }
      this.clients.push(client);
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
    this.clients.length = 0;
  }
}
