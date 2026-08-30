import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { configPath } from "../storage/persistence.js";
import { userHome } from "../support/platform-utils.js";

export interface McpConfigResolution {
  definitions: Record<string, unknown>;
  source: string | null;
}

function expandConfigPath(path: string): string {
  if (path === "~") return userHome();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(userHome(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

/** Resolve MCP definitions consistently for Settings, Catalog, and health routes. */
export async function resolveMcpConfig(options: { workspaceRoot?: string; explicitPath?: string } = {}): Promise<McpConfigResolution> {
  const candidates = [
    ...(options.explicitPath?.trim() ? [expandConfigPath(options.explicitPath.trim())] : []),
    ...(options.workspaceRoot ? [join(options.workspaceRoot, ".mcp.json"), join(options.workspaceRoot, ".pi", "mcp.json")] : []),
    join(userHome(), ".config", "mcp", "mcp.json"),
    configPath("mcp.json"),
  ];

  for (const source of new Set(candidates)) {
    try {
      const payload = JSON.parse(await readFile(source, "utf8")) as { mcpServers?: unknown };
      const definitions = payload.mcpServers && typeof payload.mcpServers === "object" && !Array.isArray(payload.mcpServers)
        ? payload.mcpServers as Record<string, unknown>
        : {};
      return { definitions, source };
    } catch {
      // Missing or malformed candidates do not prevent discovery from the
      // next standard location.
    }
  }
  return { definitions: {}, source: null };
}
