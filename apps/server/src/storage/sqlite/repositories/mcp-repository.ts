import { randomUUID } from "node:crypto";
import { mcpRuntimeConfigSchema, type McpConnectorCreate, type McpConnectorSettingsUpdate, type McpRuntimeConfig, type McpToolSummary } from "@pi-science/contracts";
import type { SqliteStateStore } from "../state-store.js";

export type McpToolDecision = "allow" | "ask" | "deny";

export interface StoredMcpMigrationConflict {
  connector_id: string;
  kind: "enabled" | "include_tools" | "exclude_tools" | "approval_mode" | "tool_grant";
  tool_name: string | null;
  project_ids: string[];
  details: string;
  created_at: number;
}

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
  enabled: boolean;
  include_tools: string[];
  exclude_tools: string[];
  approval_mode: "ask" | "custom" | "allow_all";
  settings_revision: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface StoredMcpSettings {
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

type ConnectorRow = Omit<StoredMcpConnector, "args" | "runtime_config" | "enabled" | "include_tools" | "exclude_tools"> & { args_json: string; runtime_config_json: string; enabled: number; include_tools_json: string; exclude_tools_json: string };
type CacheRow = Omit<StoredMcpToolCache, "tools"> & { tools_json: string };

export class McpRepository {
  constructor(private readonly store: SqliteStateStore) {}

  async create(input: McpConnectorCreate, source: StoredMcpConnector["source"] = "custom"): Promise<StoredMcpConnector> {
    const connectorId = `mcp_${randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    await this.store.run(
      `INSERT INTO mcp_connectors
       (connector_id, name, display_name, description, source, transport, endpoint_url, command, args_json, socket_path, runtime_config_json, credential_ref, enabled, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [connectorId, input.name, input.display_name, input.description, source, input.transport, input.endpoint_url ?? null, input.command ?? null, JSON.stringify(input.args), input.socket_path ?? null, JSON.stringify(input.runtime_config), input.credential_ref ?? null, input.enabled ? 1 : 0, now, now],
    );
    return (await this.get(connectorId))!;
  }

  async upsertBuiltin(connectorId: string, input: Omit<McpConnectorCreate, "enabled">): Promise<StoredMcpConnector> {
    const existing = await this.getByName(input.name);
    if (!existing) {
      const now = Date.now();
      await this.store.run(
        `INSERT INTO mcp_connectors
         (connector_id, name, display_name, description, source, transport, endpoint_url, command, args_json, socket_path, runtime_config_json, credential_ref, enabled, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'builtin', ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
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

  async update(connectorId: string, expectedRevision: number, input: Omit<McpConnectorCreate, "enabled">): Promise<StoredMcpConnector | null> {
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

  async settings(connectorId: string): Promise<StoredMcpSettings | null> {
    const connector = await this.get(connectorId);
    return connector ? connectorSettings(connector) : null;
  }

  async updateSettings(connectorId: string, input: McpConnectorSettingsUpdate): Promise<StoredMcpSettings | null> {
    const now = Date.now();
    const existing = await this.settings(connectorId);
    if (!existing || (input.revision !== undefined && existing.revision !== input.revision)) return null;
    const result = await this.store.run(
      `UPDATE mcp_connectors SET enabled = ?, include_tools_json = ?, exclude_tools_json = ?, approval_mode = ?, settings_revision = settings_revision + 1, updated_at = ?
       WHERE connector_id = ? AND settings_revision = ?`,
      [input.enabled ? 1 : 0, JSON.stringify(input.include_tools), JSON.stringify(input.exclude_tools), input.approval_mode, now, connectorId, existing.revision],
    );
    return Number(result.changes) > 0 ? this.settings(connectorId) : null;
  }

  async setGlobalToolGrant(connectorId: string, toolName: string, decision: McpToolDecision): Promise<void> {
    const now = Date.now();
    await this.store.batch([
      {
        sql: `INSERT INTO mcp_global_tool_grants (connector_id, tool_name, decision, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(connector_id, tool_name) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`,
        params: [connectorId, toolName, decision, now],
      },
      { sql: "UPDATE mcp_connectors SET approval_mode = 'custom', settings_revision = settings_revision + 1, updated_at = ? WHERE connector_id = ?", params: [now, connectorId] },
    ]);
  }

  /** Kept as the compatibility name for callers that do not provide a workspace. */
  async setToolGrant(connectorId: string, toolName: string, decision: McpToolDecision): Promise<void> {
    return this.setGlobalToolGrant(connectorId, toolName, decision);
  }

  async clearGlobalToolGrant(connectorId: string, toolName: string): Promise<void> {
    await this.store.run("DELETE FROM mcp_global_tool_grants WHERE connector_id = ? AND tool_name = ?", [connectorId, toolName]);
  }

  async setProjectToolGrant(projectId: string, connectorId: string, toolName: string, decision: McpToolDecision): Promise<void> {
    await this.store.run(
      `INSERT INTO mcp_project_tool_grants (project_id, connector_id, tool_name, decision, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, connector_id, tool_name) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`,
      [projectId, connectorId, toolName, decision, Date.now()],
    );
  }

  async clearProjectToolGrant(projectId: string, connectorId: string, toolName: string): Promise<void> {
    await this.store.run("DELETE FROM mcp_project_tool_grants WHERE project_id = ? AND connector_id = ? AND tool_name = ?", [projectId, connectorId, toolName]);
  }

  async globalToolGrants(connectorId: string): Promise<Map<string, McpToolDecision>> {
    const rows = await this.store.all<{ tool_name: string; decision: McpToolDecision }>("SELECT tool_name, decision FROM mcp_global_tool_grants WHERE connector_id = ?", [connectorId]);
    return new Map(rows.map((row) => [row.tool_name, row.decision]));
  }

  /** Compatibility alias for the global-default view. */
  async toolGrants(connectorId: string): Promise<Map<string, McpToolDecision>> {
    return this.globalToolGrants(connectorId);
  }

  async projectToolGrants(projectId: string, connectorId: string): Promise<Map<string, McpToolDecision>> {
    const rows = await this.store.all<{ tool_name: string; decision: McpToolDecision }>(
      "SELECT tool_name, decision FROM mcp_project_tool_grants WHERE project_id = ? AND connector_id = ?",
      [projectId, connectorId],
    );
    return new Map(rows.map((row) => [row.tool_name, row.decision]));
  }

  async migrationConflicts(): Promise<StoredMcpMigrationConflict[]> {
    const rows = await this.store.all<{
      connector_id: string;
      conflict_kind: StoredMcpMigrationConflict["kind"];
      tool_name: string;
      project_ids_json: string;
      details: string;
      created_at: number;
    }>("SELECT connector_id, conflict_kind, tool_name, project_ids_json, details, created_at FROM mcp_scope_migration_conflicts ORDER BY connector_id, conflict_kind, tool_name");
    return rows.map((row) => ({
      connector_id: row.connector_id,
      kind: row.conflict_kind,
      tool_name: row.tool_name || null,
      project_ids: JSON.parse(row.project_ids_json) as string[],
      details: row.details,
      created_at: row.created_at,
    }));
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
  const { args_json, runtime_config_json, include_tools_json, exclude_tools_json, enabled, ...values } = row;
  return { ...values, enabled: enabled === 1, args: JSON.parse(args_json) as string[], runtime_config: mcpRuntimeConfigSchema.parse(JSON.parse(runtime_config_json)), include_tools: JSON.parse(include_tools_json) as string[], exclude_tools: JSON.parse(exclude_tools_json) as string[] };
}

function connectorSettings(connector: StoredMcpConnector): StoredMcpSettings {
  return { connector_id: connector.connector_id, enabled: connector.enabled, include_tools: connector.include_tools, exclude_tools: connector.exclude_tools, approval_mode: connector.approval_mode, revision: connector.settings_revision, created_at: connector.created_at, updated_at: connector.updated_at };
}
