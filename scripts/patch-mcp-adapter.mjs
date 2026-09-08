import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? fileURLToPath(new URL("../runtime/pi/node_modules/pi-mcp-adapter", import.meta.url));
function patch(file, marker, edits) {
  const path = resolve(root, file);
  let source = readFileSync(path, "utf8");
  if (source.includes(marker)) return;
  for (const [before, after] of edits) {
    if (!source.includes(before)) throw new Error(`Unsupported MCP adapter layout: ${file}: ${before}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source + `\n// ${marker}\n`);
}
patch("tool-approval.ts", "PI_SCIENCE_EXACT_TOOL_GRANTS_V1", [[
  "  if (approval === true) return true;",
  '  const allowed = (definition as { __piScienceAllowedTools?: string[] } | undefined)?.__piScienceAllowedTools;\n  if (approval === true && allowed?.includes(toolMeta.originalName)) return false;\n  if (approval === true) return true;',
]]);

// Pi's web UI owns a single interactive selection surface. Concurrent MCP
// calls must not open multiple approval prompts at once: a later prompt can
// otherwise replace the earlier one and leave its Promise pending forever.
// Serialize approvals per session state while preserving cancellation for
// callers waiting their turn.
patch("tool-approval.ts", "PI_SCIENCE_SERIAL_APPROVALS_V1", [
  [
    'export type ToolCallApprovalResult =\n  | { ok: true }\n  | { ok: false; reason: "denied" | "approval_required_headless" };',
    `export type ToolCallApprovalResult =
  | { ok: true }
  | { ok: false; reason: "denied" | "approval_required_headless" };

const approvalQueues = new WeakMap<McpExtensionState, Promise<void>>();

async function withApprovalQueue<T>(
  state: McpExtensionState,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = approvalQueues.get(state) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  approvalQueues.set(state, tail);
  try {
    await abortable(previous.catch(() => undefined), signal);
    return await operation();
  } finally {
    release();
    if (approvalQueues.get(state) === tail) {
      void tail.finally(() => {
        if (approvalQueues.get(state) === tail) approvalQueues.delete(state);
      });
    }
  }
}`,
  ],
  [
    `  const decision = await abortable(
    state.ui.select(
      \`${"${title}"}\\n\\nArguments:\\n${"${preview}"}\`,
      ["Allow once", "Allow for session", "Deny"],
    ),
    ownedSignal,
  );`,
    `  const decision = await withApprovalQueue(state, ownedSignal, () => abortable(
    state.ui!.select(
      \`${"${title}"}\\n\\nArguments:\\n${"${preview}"}\`,
      ["Allow once", "Allow for session", "Deny"],
    ),
    ownedSignal,
  ));`,
  ],
]);

// Pi Orbit hosts many workspace sessions in one process. Allow the managed
// wrapper to resolve its in-memory config from the current session context;
// a config captured while the host boots would otherwise use orbit-host cwd.
patch("types.ts", "PI_SCIENCE_SESSION_CONFIG_FACTORY_TYPES_V1", [[
  "  config?: McpConfig;\n  configPath?: string;",
  "  config?: McpConfig;\n  configPath?: string;\n  configFactory?: (ctx: { cwd: string }) => McpConfig;",
]]);
patch("index.ts", "PI_SCIENCE_SESSION_CONFIG_FACTORY_V1", [
  [
    "const programmaticConfig = sessionConfig !== undefined;",
    "const programmaticConfig = sessionConfig !== undefined || options.configFactory !== undefined;",
  ],
  [
    "  const earlyConfig = programmaticConfig\n    ? cloneMcpConfig(sessionConfig)\n    : loadMcpConfig(earlyConfigPath);",
    "  const earlyConfig = options.configFactory !== undefined\n    ? { mcpServers: {} } as McpConfig\n    : programmaticConfig\n      ? cloneMcpConfig(sessionConfig!)\n      : loadMcpConfig(earlyConfigPath);",
  ],
  [
    "  function startInitialization(ctx: ExtensionContext, owner: McpRuntimeOwner, oauthRuntime: McpOAuthRuntime, generation: number, staleReason: string): Promise<void> {\n    const promise = initializeMcp(pi, ctx, owner, {\n      ...(programmaticConfig || options.configPath !== undefined\n        ? { configPath: earlyConfigPath, config: sessionConfig }\n        : {}),",
    "  function startInitialization(ctx: ExtensionContext, owner: McpRuntimeOwner, oauthRuntime: McpOAuthRuntime, generation: number, staleReason: string): Promise<void> {\n    const resolvedSessionConfig = options.configFactory?.(ctx) ?? sessionConfig;\n    const promise = initializeMcp(pi, ctx, owner, {\n      ...(resolvedSessionConfig !== undefined\n        ? { config: resolvedSessionConfig }\n        : options.configPath !== undefined\n          ? { configPath: earlyConfigPath }\n          : {}),",
  ],
  [
    "      configPath: options.configPath,\n      config: factoryConfig !== undefined ? cloneMcpConfig(factoryConfig) : undefined,",
    "      configPath: options.configPath,\n      config: factoryConfig !== undefined ? cloneMcpConfig(factoryConfig) : undefined,\n      configFactory: options.configFactory,",
  ],
]);

// `action` is only the dispatcher for UI/OAuth operations. Leaving it as an
// unconstrained string lets a plausible but invalid `{ action: "connect" }`
// pass schema validation and then fall through to the unrelated `server`
// listing branch. Constrain the model-facing schema and keep a runtime guard
// for hosts that do not enforce TypeBox validation.
patch("index.ts", "PI_SCIENCE_MCP_ACTION_ENUM_V1", [
  [
    '        action: Type.Optional(Type.String({ description: "Action: \'ui-messages\', \'auth-start\', or \'auth-complete\'" })),',
    `        action: Type.Optional(Type.Union([
          Type.Literal("ui-messages"),
          Type.Literal("auth-start"),
          Type.Literal("auth-complete"),
        ], { description: "Special action for UI/OAuth only; use the top-level connect field to connect a server" })),`,
  ],
  [
    "        if (params.action === \"ui-messages\") {",
    `        if (params.action !== undefined && params.action !== "ui-messages" && params.action !== "auth-start" && params.action !== "auth-complete") {
          const correction = params.action === "connect" && params.server
            ? \` To connect that server, use mcp({ connect: \"\${params.server}\" }).\`
            : "";
          return {
            content: [{ type: "text" as const, text: \`Unknown MCP action \"\${params.action}\". Supported actions: ui-messages, auth-start, auth-complete.\${correction}\` }],
            details: { mode: "action", error: "invalid_action", action: params.action },
          };
        }
        if (params.action === "ui-messages") {`,
  ],
]);
patch("server-manager.ts", "PI_SCIENCE_TRANSPORT_POLICY_V1", [
  ["    const serverUrl = resolveServerUrl(definition)!;", `    const policy = definition as ServerDefinition & { __piScienceFetchModule?: string; __piScienceConnectorId?: string; __piScienceAllowPrivate?: boolean };
    const guardedFetch = policy.__piScienceFetchModule
      ? (await import(policy.__piScienceFetchModule)).createMcpFetch({ connectorId: policy.__piScienceConnectorId ?? serverName, endpoint: definition.url, allowPrivate: policy.__piScienceAllowPrivate === true })
      : undefined;
    const serverUrl = resolveServerUrl(definition)!;`],
  ["        requestInit,\n        authProvider,", "        requestInit,\n        authProvider,\n        fetch: guardedFetch,"],
  ["new StreamableHTTPClientTransport(url, { requestInit, authProvider })", "new StreamableHTTPClientTransport(url, { requestInit, authProvider, fetch: guardedFetch })"],
  ["new SSEClientTransport(url, { requestInit, authProvider })", "new SSEClientTransport(url, { requestInit, authProvider, fetch: guardedFetch })"],
  ["    if (value !== undefined) resolved[key] = value;", '    if (["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"].includes(key) && value !== undefined) resolved[key] = value;'],
]);
patch("server-manager.ts", "PI_SCIENCE_RAW_BINDINGS_V1", [
  ["env: resolveEnv(definition.env, name),", 'env: resolveEnv(definition.env, name, (definition as ServerDefinition & { __piScienceRawBindings?: boolean }).__piScienceRawBindings === true),'],
  ["const hasCommandHeader = Object.values(definition.headers ?? {})", 'const rawBindings = (definition as ServerDefinition & { __piScienceRawBindings?: boolean }).__piScienceRawBindings === true;\n    const hasCommandHeader = !rawBindings && Object.values(definition.headers ?? {})'],
  ["const headers = resolveCommandSecretsRecord(", "const headers = rawBindings ? { ...definition.headers } : resolveCommandSecretsRecord("],
  ["function resolveEnv(env: Record<string, string> | undefined, serverName: string): Record<string, string> {", "function resolveEnv(env: Record<string, string> | undefined, serverName: string, raw = false): Record<string, string> {"],
  ["  const overrides = resolveCommandSecretsRecord(", "  const overrides = raw ? env : resolveCommandSecretsRecord("],
]);

patch("server-manager.ts", "PI_SCIENCE_AUDIT_HOME_V1", [
  ['["PATH", "HOME",', '["PI_SCIENCE_HOME", "PATH", "HOME",'],
]);

patch("server-manager.ts", "PI_SCIENCE_PROJECT_EGRESS_AUDIT_V1", [
  [
    "const policy = definition as ServerDefinition & { __piScienceFetchModule?: string; __piScienceConnectorId?: string; __piScienceAllowPrivate?: boolean };",
    "const policy = definition as ServerDefinition & { __piScienceFetchModule?: string; __piScienceConnectorId?: string; __piScienceAllowPrivate?: boolean; __piScienceProjectId?: string };",
  ],
  [
    "allowPrivate: policy.__piScienceAllowPrivate === true })",
    "allowPrivate: policy.__piScienceAllowPrivate === true, projectId: policy.__piScienceProjectId })",
  ],
]);

patch("mcp-probe.ts", "PI_SCIENCE_PROBE_TRANSPORT_POLICY_V1", [
  [
    "export async function probeMcpEndpoint(url: string | URL): Promise<McpProbeResult> {",
    "export async function probeMcpEndpoint(url: string | URL, fetchFn: typeof fetch = fetch): Promise<McpProbeResult> {",
  ],
  ["await fetch(url, {", "await fetchFn(url, {"],
  ["await fetch(url, {", "await fetchFn(url, {"],
]);

patch("server-manager.ts", "PI_SCIENCE_PROBE_TRANSPORT_POLICY_V1", [
  [
    "      const probe = await probeMcpEndpoint(resolveServerUrl(definition)!);",
    `      const policy = definition as ServerDefinition & { __piScienceFetchModule?: string; __piScienceConnectorId?: string; __piScienceAllowPrivate?: boolean; __piScienceProjectId?: string };
      const guardedFetch = policy.__piScienceFetchModule
        ? (await import(policy.__piScienceFetchModule)).createMcpFetch({ connectorId: policy.__piScienceConnectorId ?? "mcp-probe", endpoint: definition.url, allowPrivate: policy.__piScienceAllowPrivate === true, projectId: policy.__piScienceProjectId })
        : undefined;
      const probe = await probeMcpEndpoint(resolveServerUrl(definition)!, guardedFetch);`,
  ],
]);

patch("mcp-auth-flow.ts", "PI_SCIENCE_OAUTH_TRANSPORT_POLICY_V1", [
  [
    "export interface AuthenticateOptions {",
    "export interface AuthenticateOptions {\n  fetchFn?: typeof fetch",
  ],
  [
    "  authStorageOptions: AuthStorageOptions\n}",
    "  authStorageOptions: AuthStorageOptions\n  fetchFn?: typeof fetch\n}",
  ],
  [
    "async function probeAuthDiscovery(serverUrl: string, definition?: ServerEntry, signal?: AbortSignal): Promise<AuthDiscovery> {",
    `async function guardedFetchForDefinition(serverUrl: string, definition?: ServerEntry): Promise<typeof fetch | undefined> {
  const policy = definition as (ServerEntry & { __piScienceFetchModule?: string; __piScienceConnectorId?: string; __piScienceAllowPrivate?: boolean; __piScienceProjectId?: string }) | undefined
  if (!policy?.__piScienceFetchModule) return undefined
  const module = await import(policy.__piScienceFetchModule) as { createMcpFetch?: (policy: { connectorId: string; projectId?: string | null; endpoint?: string | null; allowPrivate: boolean }) => typeof fetch }
  if (typeof module.createMcpFetch !== "function") throw new Error("Managed MCP fetch policy is unavailable")
  return module.createMcpFetch({ connectorId: policy.__piScienceConnectorId ?? serverUrl, projectId: policy.__piScienceProjectId, endpoint: serverUrl, allowPrivate: policy.__piScienceAllowPrivate === true })
}

async function probeAuthDiscovery(serverUrl: string, definition?: ServerEntry, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<AuthDiscovery> {`,
  ],
  [
    "const response = await fetch(new URL(serverUrl), {",
    "const response = await fetchFn(new URL(serverUrl), {",
  ],
  [
    "  const generation = runtimeState.generation\n  throwIfAborted(signal)",
    "  const generation = runtimeState.generation\n  throwIfAborted(signal)\n  const fetchFn = options.fetchFn ?? await guardedFetchForDefinition(serverUrl, definition)",
  ],
  [
    "probeAuthDiscovery(serverUrl, definition, signal)",
    "probeAuthDiscovery(serverUrl, definition, signal, fetchFn)",
  ],
  [
    "probeAuthDiscovery(serverUrl, definition, signal)",
    "probeAuthDiscovery(serverUrl, definition, signal, fetchFn)",
  ],
  [
    "abortable(runSdkAuth(authProvider, { serverUrl, ...discovery }), signal)",
    "abortable(runSdkAuth(authProvider, { serverUrl, ...discovery, ...(fetchFn ? { fetchFn } : {}) }), signal)",
  ],
  [
    "abortable(runSdkAuth(authProvider, { serverUrl, ...discovery }), signal)",
    "abortable(runSdkAuth(authProvider, { serverUrl, ...discovery, ...(fetchFn ? { fetchFn } : {}) }), signal)",
  ],
  [
    "await setPendingAuth(runtime, serverName, { serverName, authProvider, serverUrl, authorizationUrl: capturedUrl.toString(), discovery, authStorageOptions }, oauthState, signal, generation)",
    "await setPendingAuth(runtime, serverName, { serverName, authProvider, serverUrl, authorizationUrl: capturedUrl.toString(), discovery, authStorageOptions, fetchFn }, oauthState, signal, generation)",
  ],
  [
    "  const oauthState = runtimeState.pendingAuthStates.get(key)\n  throwIfAborted(signal)\n\n  let keepPendingForRetry = false",
    "  const oauthState = runtimeState.pendingAuthStates.get(key)\n  throwIfAborted(signal)\n  const fetchFn = options.fetchFn ?? pendingAuth.fetchFn\n\n  let keepPendingForRetry = false",
  ],
  [
    "      ...pendingAuth.discovery,\n    }), signal)",
    "      ...pendingAuth.discovery,\n      ...(fetchFn ? { fetchFn } : {}),\n    }), signal)",
  ],
  [
    "const discovery = await probeAuthDiscovery(serverUrl, undefined, signal)",
    "const discovery = await probeAuthDiscovery(serverUrl, undefined, signal, options.fetchFn)",
  ],
  [
    "abortable(runSdkAuth(authProvider, { serverUrl, ...discovery }), signal)",
    "abortable(runSdkAuth(authProvider, { serverUrl, ...discovery, ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}) }), signal)",
  ],
]);

// Managed Pi-Science snapshots carry a runtime cache version. Include it in
// the adapter's fingerprint so a tool/resource contract change invalidates
// stale metadata discovered by an older runtime.
patch("metadata-cache.ts", "PI_SCIENCE_RUNTIME_CACHE_VERSION_V1", [
  [
    "    excludeTools: definition.excludeTools,\n  };",
    "    excludeTools: definition.excludeTools,\n    piScienceCacheVersion: (definition as ServerEntry & { __piScienceCacheVersion?: unknown }).__piScienceCacheVersion,\n  };",
  ],
]);

// Managed snapshots can also carry the last canonical tool-cache count. Use
// it for status before a lazy server has connected, while still preferring
// live metadata whenever it is available.
patch("metadata-cache.ts", "PI_SCIENCE_CONFIGURED_TOOL_COUNT_V1", [
  [
    "    piScienceCacheVersion: (definition as ServerEntry & { __piScienceCacheVersion?: unknown }).__piScienceCacheVersion,\n  };",
    "    piScienceCacheVersion: (definition as ServerEntry & { __piScienceCacheVersion?: unknown }).__piScienceCacheVersion,\n    piScienceToolCount: (definition as ServerEntry & { __piScienceToolCount?: unknown }).__piScienceToolCount,\n  };",
  ],
]);

// Listing a configured server is an explicit request for its tool inventory.
// For lazy servers with no valid metadata cache, connect once before deciding
// that the server is unavailable; this avoids the misleading \"configured but
// not connected\" result for a server that has simply never been used.
patch("proxy-modes.ts", "PI_SCIENCE_LAZY_LIST_CONNECT_V1", [
  [
    "export function executeList(state: McpExtensionState, server: string): ProxyToolResult {",
    "export async function executeList(state: McpExtensionState, server: string, signal?: AbortSignal): Promise<ProxyToolResult> {",
  ],
  [
    "  if (isServerDisabled(definition)) return disabledResult(\"list\", server);\n\n  const metadata = state.toolMetadata.get(server);",
    "  if (isServerDisabled(definition)) return disabledResult(\"list\", server);\n\n  const metadata = state.toolMetadata.get(server);\n  if (metadata === undefined && state.manager.getConnection(server)?.status !== \"connected\") {\n    const connected = await lazyConnect(state, server, signal);\n    if (connected) return executeList(state, server, signal);\n  }",
  ],
]);

// Make the aggregate status honest about lazy servers: cached metadata is
// useful for discovery, but it does not mean a live MCP connection exists.
patch("proxy-modes.ts", "PI_SCIENCE_STATUS_CACHE_LABEL_V1", [
  [
    "  const connectedCount = enabledServers.filter(s => s.status === \"connected\").length;\n\n  let text = `MCP: ${connectedCount}/${enabledServers.length} servers, ${totalTools} tools`;",
    "  const connectedCount = enabledServers.filter(s => s.status === \"connected\").length;\n  const cachedToolCount = enabledServers.filter(s => s.status === \"cached\").reduce((sum, server) => sum + server.toolCount, 0);\n\n  let text = `MCP: ${connectedCount}/${enabledServers.length} servers connected, ${totalTools} tools available`;\n  if (cachedToolCount > 0) text += ` (${cachedToolCount} cached)`;",
  ],
]);

patch("proxy-modes.ts", "PI_SCIENCE_CONFIGURED_TOOL_COUNT_V1", [
  [
    "    const toolCount = metadata?.length ?? 0;",
    "    const configuredToolCount = (definition as { __piScienceToolCount?: unknown }).__piScienceToolCount;\n    const toolCount = metadata?.length ?? (typeof configuredToolCount === \"number\" ? configuredToolCount : 0);",
  ],
  [
    "    text += `○ ${server.name} (not connected)\\n`;",
    "    text += `○ ${server.name}${server.toolCount > 0 ? ` (${server.toolCount} tools configured, not connected)` : \" (not connected)\"}\\n`;",
  ],
]);

patch("mcp-status.ts", "PI_SCIENCE_CONFIGURED_TOOL_COUNT_STATUS_V1", [
  [
    "    const toolCount = metadata?.length ?? (connection?.status === \"connected\" ? connection.tools.length : 0);",
    "    const configuredToolCount = (definition as { __piScienceToolCount?: unknown }).__piScienceToolCount;\n    const toolCount = metadata?.length ?? (connection?.status === \"connected\" ? connection.tools.length : typeof configuredToolCount === \"number\" ? configuredToolCount : 0);",
  ],
]);
