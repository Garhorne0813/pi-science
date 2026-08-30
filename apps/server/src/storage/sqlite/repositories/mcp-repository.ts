import { randomUUID } from "node:crypto";
import { mcpRuntimeConfigSchema, type McpConnectorCreate, type McpProjectBindingUpdate, type McpRuntimeConfig, type McpToolSummary } from "@pi-science/contracts";
import type { SqliteStateStore } from "../state-store.js";

export interface StoredMcpConnector {
  connector_id: string;
  name: string;
  display_name: string;
  description: string;
  source: "builtin" | "custom" | "imported";
  transport: "stdio" | "streamable_http" | "sse" | "socket";
  endpoint_url: string | null;
  command: string | null;
  args: string[];
  socket_path: string | null;
  runtime_config: McpRuntimeConfig;
  credential_ref: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface StoredMcpBinding {
  project_id: string;
  connector_id: string;
  enabled: boolean;
  include_tools: string[];
  exclude_tools: string[];
  approval_mode: "ask" | "custom" | "allow_all";
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface StoredMcpToolCache {
  connector_id: string;
  config_revision: number;
  fingerprint: string;
  tools: McpToolSummary[];
  fetched_at: number;
  expires_at: number;
}

type ConnectorRow = Omit<StoredMcpConnector, "args" | "runtime_config"> & { args_json: string; runtime_config_json: string };
type BindingRow = Omit<StoredMcpBinding, "enabled" | "include_tools" | "exclude_tools"> & { enabled: number; include_tools_json: string; exclude_tools_json: string };
type CacheRow = Omit<StoredMcpToolCache, "tools"> & { tools_json: string };

export class McpRepository {
  constructor(private readonly store: SqliteStateStore) {}

  async create(input: McpConnectorCreate, source: StoredMcpConnector["source"] = "custom"): Promise<StoredMcpConnector> {
    const connectorId = `mcp_${randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    await this.store.run(
      `INSERT INTO mcp_connectors
       (connector_id, name, display_name, description, source, transport, endpoint_url, command, args_json, socket_path, runtime_config_json, credential_ref, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [connectorId, input.name, input.display_name, input.description, source, input.transport, input.endpoint_url ?? null, input.command ?? null, JSON.stringify(input.args), input.socket_path ?? null, JSON.stringify(input.runtime_config), input.credential_ref ?? null, now, now],
    );
    return (await this.get(connectorId))!;
  }

  async upsertBuiltin(connectorId: string, input: Omit<McpConnectorCreate, "enable_for_project">): Promise<StoredMcpConnector> {
    const existing = await this.getByName(input.name);
    if (!existing) {
      const now = Date.now();
      await this.store.run(
        `INSERT INTO mcp_connectors
         (connector_id, name, display_name, description, source, transport, endpoint_url, command, args_json, socket_path, runtime_config_json, credential_ref, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'builtin', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [connectorId, input.name, input.display_name, input.description, input.transport, input.endpoint_url ?? null, input.command ?? null, JSON.stringify(input.args), input.socket_path ?? null, JSON.stringify(input.runtime_config), input.credential_ref ?? null, now, now],
      );
      return (await this.get(connectorId))!;
    }
    const unchanged = existing.source === "builtin" && existing.display_name === input.display_name && existing.description === input.description
      && existing.transport === input.transport && existing.endpoint_url === (input.endpoint_url ?? null) && existing.command === (input.command ?? null)
      && JSON.stringify(existing.args) === JSON.stringify(input.args) && existing.socket_path === (input.socket_path ?? null)
      && JSON.stringify(existing.runtime_config) === JSON.stringify(input.runtime_config) && existing.credential_ref === (input.credential_ref ?? null);
    if (unchanged) return existing;
    const now = Date.now();
    await this.store.run(
      `UPDATE mcp_connectors SET display_name = ?, description = ?, source = 'builtin', transport = ?, endpoint_url = ?, command = ?, args_json = ?, socket_path = ?, runtime_config_json = ?, credential_ref = ?, revision = revision + 1, updated_at = ? WHERE connector_id = ?`,
      [input.display_name, input.description, input.transport, input.endpoint_url ?? null, input.command ?? null, JSON.stringify(input.args), input.socket_path ?? null, JSON.stringify(input.runtime_config), input.credential_ref ?? null, now, existing.connector_id],
    );
    await this.store.run("DELETE FROM mcp_tool_cache WHERE connector_id = ?", [existing.connector_id]);
    return (await this.get(existing.connector_id))!;
  }

  async get(connectorId: string): Promise<StoredMcpConnector | null> {
    const row = await this.store.get<ConnectorRow>("SELECT * FROM mcp_connectors WHERE connector_id = ?", [connectorId]);
    return row ? connector(row) : null;
  }

  async getByName(name: string): Promise<StoredMcpConnector | null> {
    const row = await this.store.get<ConnectorRow>("SELECT * FROM mcp_connectors WHERE name = ? COLLATE NOCASE", [name]);
    return row ? connector(row) : null;
  }

  async list(): Promise<StoredMcpConnector[]> {
    return (await this.store.all<ConnectorRow>("SELECT * FROM mcp_connectors ORDER BY display_name COLLATE NOCASE, name")).map(connector);
  }

  async update(connectorId: string, expectedRevision: number, input: Omit<McpConnectorCreate, "enable_for_project">): Promise<StoredMcpConnector | null> {
    const now = Date.now();
    const result = await this.store.run(
      `UPDATE mcp_connectors SET
         name = ?, display_name = ?, description = ?, transport = ?, endpoint_url = ?, command = ?, args_json = ?, socket_path = ?,
         runtime_config_json = ?, credential_ref = ?, revision = revision + 1, updated_at = ?
       WHERE connector_id = ? AND revision = ?`,
      [input.name, input.display_name, input.description, input.transport, input.endpoint_url ?? null, input.command ?? null, JSON.stringify(input.args), input.socket_path ?? null, JSON.stringify(input.runtime_config), input.credential_ref ?? null, now, connectorId, expectedRevision],
    );
    if (Number(result.changes) === 0) return null;
    await this.store.run("DELETE FROM mcp_tool_cache WHERE connector_id = ?", [connectorId]);
    return this.get(connectorId);
  }

  async delete(connectorId: string): Promise<boolean> {
    return Number((await this.store.run("DELETE FROM mcp_connectors WHERE connector_id = ?", [connectorId])).changes) > 0;
  }

  async binding(projectId: string, connectorId: string): Promise<StoredMcpBinding | null> {
    const row = await this.store.get<BindingRow>("SELECT * FROM mcp_project_bindings WHERE project_id = ? AND connector_id = ?", [projectId, connectorId]);
    return row ? binding(row) : null;
  }

  async bindingsForProject(projectId: string): Promise<StoredMcpBinding[]> {
    return (await this.store.all<BindingRow>("SELECT * FROM mcp_project_bindings WHERE project_id = ? ORDER BY connector_id", [projectId])).map(binding);
  }

  async bindingReferences(connectorId: string): Promise<Array<{ project_id: string; name: string }>> {
    return this.store.all(
      `SELECT b.project_id, p.name FROM mcp_project_bindings b JOIN projects p ON p.project_id = b.project_id
       WHERE b.connector_id = ? ORDER BY p.name`,
      [connectorId],
    );
  }

  async bindingLocations(connectorId: string): Promise<Array<{ project_id: string; canonical_path: string }>> {
    return this.store.all(
      `SELECT DISTINCT b.project_id, l.canonical_path FROM mcp_project_bindings b
       JOIN project_locations l ON l.project_id = b.project_id
       WHERE b.connector_id = ? AND l.missing_since IS NULL ORDER BY l.canonical_path`,
      [connectorId],
    );
  }

  async upsertBinding(projectId: string, connectorId: string, input: McpProjectBindingUpdate): Promise<StoredMcpBinding | null> {
    const now = Date.now();
    const existing = await this.binding(projectId, connectorId);
    if (existing) {
      if (input.revision !== undefined && existing.revision !== input.revision) return null;
      await this.store.run(
        `UPDATE mcp_project_bindings SET enabled = ?, include_tools_json = ?, exclude_tools_json = ?, approval_mode = ?, revision = revision + 1, updated_at = ?
         WHERE project_id = ? AND connector_id = ? AND revision = ?`,
        [input.enabled ? 1 : 0, JSON.stringify(input.include_tools), JSON.stringify(input.exclude_tools), input.approval_mode, now, projectId, connectorId, existing.revision],
      );
    } else {
      await this.store.run(
        `INSERT INTO mcp_project_bindings
         (project_id, connector_id, enabled, include_tools_json, exclude_tools_json, approval_mode, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [projectId, connectorId, input.enabled ? 1 : 0, JSON.stringify(input.include_tools), JSON.stringify(input.exclude_tools), input.approval_mode, now, now],
      );
    }
    return this.binding(projectId, connectorId);
  }

  async setToolGrant(projectId: string, connectorId: string, toolName: string, decision: "allow" | "ask" | "deny"): Promise<void> {
    await this.store.run(
      `INSERT INTO mcp_tool_grants (project_id, connector_id, tool_name, decision, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, connector_id, tool_name) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`,
      [projectId, connectorId, toolName, decision, Date.now()],
    );
  }

  async toolGrants(projectId: string, connectorId: string): Promise<Map<string, "allow" | "ask" | "deny">> {
    const rows = await this.store.all<{ tool_name: string; decision: "allow" | "ask" | "deny" }>("SELECT tool_name, decision FROM mcp_tool_grants WHERE project_id = ? AND connector_id = ?", [projectId, connectorId]);
    return new Map(rows.map((row) => [row.tool_name, row.decision]));
  }

  async toolCache(connectorId: string): Promise<StoredMcpToolCache | null> {
    const row = await this.store.get<CacheRow>("SELECT connector_id, config_revision, fingerprint, tools_json, fetched_at, expires_at FROM mcp_tool_cache WHERE connector_id = ?", [connectorId]);
    return row ? { ...row, tools: JSON.parse(row.tools_json) as McpToolSummary[] } : null;
  }

  async replaceToolCache(input: StoredMcpToolCache): Promise<void> {
    await this.store.run(
      `INSERT INTO mcp_tool_cache (connector_id, config_revision, fingerprint, tools_json, resources_json, server_info_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, '[]', NULL, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET config_revision = excluded.config_revision, fingerprint = excluded.fingerprint,
         tools_json = excluded.tools_json, resources_json = excluded.resources_json, server_info_json = excluded.server_info_json,
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      [input.connector_id, input.config_revision, input.fingerprint, JSON.stringify(input.tools), input.fetched_at, input.expires_at],
    );
  }
}

function connector(row: ConnectorRow): StoredMcpConnector {
  return { ...row, args: JSON.parse(row.args_json) as string[], runtime_config: mcpRuntimeConfigSchema.parse(JSON.parse(row.runtime_config_json)) };
}

function binding(row: BindingRow): StoredMcpBinding {
  return { ...row, enabled: row.enabled === 1, include_tools: JSON.parse(row.include_tools_json) as string[], exclude_tools: JSON.parse(row.exclude_tools_json) as string[] };
}
