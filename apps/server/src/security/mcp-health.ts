/**
 * Bounded MCP server health probing. Checks configuration completeness only:
 * - stdio servers: executable present on PATH, required env vars set
 * - http servers: URL parses, resolves to a public address, required env set
 * Never performs an expensive handshake or query; unreachable-in-depth is left
 * to the runtime bridge at connect time.
 */
import { validateConnectorOutboundUrl } from "./outbound-security.js";
import { findExecutable } from "../support/platform-utils.js";

export type McpHealthResult = {
  health: "ok" | "error";
  error: string | null;
};

export type McpDefinition = {
  command?: unknown;
  url?: unknown;
  required_env?: unknown;
};

function missingEnv(definition: McpDefinition, environment: NodeJS.ProcessEnv): string | null {
  const required = Array.isArray(definition.required_env) ? definition.required_env.map(String).filter(Boolean) : [];
  for (const key of required) {
    if (!environment[key]) return `missing env: ${key}`;
  }
  return null;
}

export async function probeMcpHealth(
  definition: McpDefinition,
  environment: NodeJS.ProcessEnv = process.env,
  options: { allowPrivate?: boolean } = {},
): Promise<McpHealthResult> {
  const url = typeof definition.url === "string" && definition.url.trim() ? definition.url.trim() : null;
  if (url) {
    try {
      // Connectors are the outbound data plane: strict by default (public
      // addresses only) unless the caller opts into private destinations.
      await validateConnectorOutboundUrl(url, { allowPrivate: options.allowPrivate ?? false });
    } catch (error) {
      return { health: "error", error: error instanceof Error ? error.message : String(error) };
    }
    return missingEnv(definition, environment) ? { health: "error", error: missingEnv(definition, environment) } : { health: "ok", error: null };
  }
  const command = typeof definition.command === "string" && definition.command.trim() ? definition.command.trim() : null;
  if (!command) return { health: "error", error: "missing command or url" };
  const executable = await findExecutable(command, environment);
  if (!executable) return { health: "error", error: `command not found: ${command}` };
  return missingEnv(definition, environment) ? { health: "error", error: missingEnv(definition, environment) } : { health: "ok", error: null };
}
