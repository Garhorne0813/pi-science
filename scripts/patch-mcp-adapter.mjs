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
