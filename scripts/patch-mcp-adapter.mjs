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
