import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpEnvironmentBinding } from "./runtime-projection-types.js";
import type { McpRepository, StoredMcpConnector } from "../storage/sqlite/repositories/mcp-repository.js";
import { validateWorkspaceCwd } from "../security/workspace-security.js";
import { metadataRoot, writeJsonAtomic } from "../storage/persistence.js";

export const MCP_RUNTIME_SNAPSHOT = ".pi-science/mcp-runtime.json";

export interface ProjectedMcpServer {
  command?: string;
  args?: string[];
  socket?: string;
  url?: string;
  cwd?: string;
  lifecycle?: string;
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources?: boolean;
  includeTools?: string[];
  excludeTools?: string[];
  approveTools?: boolean | string[];
  auth?: "oauth" | "bearer" | false;
  oauth?: { clientId?: string; scope?: string };
  __piScienceEnvironment?: Record<string, McpEnvironmentBinding>;
  __piScienceHeaders?: Record<string, McpEnvironmentBinding>;
}

export class McpRuntimeProjection {
  constructor(private readonly repository: McpRepository) {}

  async materialize(cwd: string, projectId: string): Promise<void> {
    const workspace = await validateWorkspaceCwd(cwd);
    const bindings = (await this.repository.bindingsForProject(projectId)).filter((item) => item.enabled);
    const connectors = new Map((await this.repository.list()).map((item) => [item.connector_id, item]));
    const mcpServers: Record<string, ProjectedMcpServer> = {};
    for (const binding of bindings) {
      const connector = connectors.get(binding.connector_id);
      if (!connector) continue;
      const grants = await this.repository.toolGrants(projectId, connector.connector_id);
      const denied = [...grants].filter(([, decision]) => decision === "deny").map(([name]) => name);
      const asked = [...grants].filter(([, decision]) => decision === "ask").map(([name]) => name);
      const includeTools = unique([...connector.runtime_config.include_tools, ...binding.include_tools]);
      const excludeTools = unique([...connector.runtime_config.exclude_tools, ...binding.exclude_tools, ...denied]);
      mcpServers[connector.name] = projectServer(connector, includeTools, excludeTools,
        binding.approval_mode === "allow_all" ? false : binding.approval_mode === "ask" ? true : asked);
    }
    await atomicSnapshot(workspace, { version: 1, project_id: projectId, generated_at: Date.now(), mcpServers });
  }
}

function projectServer(connector: StoredMcpConnector, includeTools: string[], excludeTools: string[], approveTools: boolean | string[]): ProjectedMcpServer {
  const runtime = connector.runtime_config;
  return {
    ...(connector.transport === "stdio" ? { command: connector.command!, args: connector.args } : {}),
    ...(connector.transport === "socket" ? { socket: connector.socket_path! } : {}),
    ...(connector.transport === "streamable_http" || connector.transport === "sse" ? { url: connector.endpoint_url! } : {}),
    ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    lifecycle: runtime.lifecycle,
    ...(runtime.idle_timeout_minutes != null ? { idleTimeout: runtime.idle_timeout_minutes } : {}),
    ...(runtime.request_timeout_ms != null ? { requestTimeoutMs: runtime.request_timeout_ms } : {}),
    exposeResources: runtime.expose_resources,
    ...(includeTools.length ? { includeTools } : {}),
    ...(excludeTools.length ? { excludeTools } : {}),
    approveTools,
    ...(runtime.auth === "none" ? { auth: false as const } : runtime.auth === "oauth" ? { auth: "oauth" as const } : runtime.auth === "bearer" ? { auth: "bearer" as const } : {}),
    ...(runtime.oauth_client_id || runtime.oauth_scope ? { oauth: { ...(runtime.oauth_client_id ? { clientId: runtime.oauth_client_id } : {}), ...(runtime.oauth_scope ? { scope: runtime.oauth_scope } : {}) } } : {}),
    ...(Object.keys(runtime.environment).length ? { __piScienceEnvironment: runtime.environment } : {}),
    ...(Object.keys(runtime.headers).length ? { __piScienceHeaders: runtime.headers } : {}),
  };
}

async function atomicSnapshot(cwd: string, payload: unknown): Promise<void> {
  const directory = metadataRoot(cwd);
  try { if ((await lstat(directory)).isSymbolicLink()) throw new Error("Workspace .pi-science directory must not be a symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(join(directory, "mcp-runtime.json"), payload, { mode: 0o600 });
}

function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
