import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  mcpConnectorCreateSchema,
  mcpConnectorUpdateSchema,
  mcpProjectBindingUpdateSchema,
  type McpConnector,
  type McpConnectorCreate,
  type McpConnectorUpdate,
  type McpProbeResult,
  type McpProjectBindingUpdate,
  type McpToolSummary,
} from "@pi-science/contracts";
import { resolveMcpConfig } from "../catalog/mcp-config.js";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";
import { validateConnectorOutboundUrl } from "../security/outbound-security.js";
import { probeMcpHealth } from "../security/mcp-health.js";
import { validateWorkspaceCwd } from "../security/workspace-security.js";
import { egressAuditEnabled, recordEgress } from "../security/egress-audit.js";
import type { McpRepository, StoredMcpBinding, StoredMcpConnector } from "../storage/sqlite/repositories/mcp-repository.js";
import type { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import type { SettingsStore } from "../storage/settings-store.js";
import type { McpRuntimeProjection } from "./runtime-projection.js";
import { connectAndListMcpTools } from "./connector-probe.js";
import { builtinMcpConnectors } from "./builtin-connectors.js";

export class McpServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly details?: unknown) {
    super(message);
  }
}

export class McpConnectorService {
  private readonly probeInflight = new Map<string, Promise<McpProbeResult>>();
  constructor(
    readonly repository: McpRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly settings: SettingsStore,
    private readonly sessions?: NodeSessionService,
    private readonly projection?: McpRuntimeProjection,
  ) {}

  async ensureBuiltins(): Promise<void> {
    for (const builtin of builtinMcpConnectors()) {
      const connector = await this.repository.upsertBuiltin(builtin.connector_id, builtin.definition);
      const cache = await this.repository.toolCache(connector.connector_id);
      const fingerprint = mcpConnectorFingerprint(connector);
      const cachedToolNames = cache?.tools.map((tool) => tool.name).sort().join("\0");
      const builtinToolNames = builtin.tools.map((tool) => tool.name).sort().join("\0");
      if (!cache || cache.config_revision !== connector.revision || cache.fingerprint !== fingerprint || cachedToolNames !== builtinToolNames) {
        const now = Date.now();
        await this.repository.replaceToolCache({
          connector_id: connector.connector_id,
          config_revision: connector.revision,
          fingerprint,
          tools: builtin.tools,
          fetched_at: now,
          expires_at: Number.MAX_SAFE_INTEGER,
        });
      }
      const locations = await this.repository.bindingLocations(connector.connector_id);
      await Promise.all(locations.map((item) => this.projection?.materialize(item.canonical_path, item.project_id)));
    }
  }

  async list(cwd?: string | null): Promise<{ connectors: McpConnector[]; project_id: string | null; legacy_config_path: string | null; legacy_count: number }> {
    const connectors = await this.repository.list();
    const project = cwd ? await this.project(cwd) : null;
    const bindings = new Map(project ? (await this.repository.bindingsForProject(project.project_id)).map((item) => [item.connector_id, item]) : []);
    const result = await Promise.all(connectors.map(async (item) => this.publicConnector(item, bindings.get(item.connector_id) ?? null)));
    const legacy = await this.legacyDefinitions(cwd);
    const canonicalNames = new Set(connectors.map((item) => item.name.toLowerCase()));
    const legacyCount = Object.entries(legacy.definitions).filter(([name, raw]) => {
      if (canonicalNames.has(name.toLowerCase())) return false;
      const definition = object(raw);
      const sensitive = Boolean(definition.env || definition.headers || definition.bearerToken || definition.oauth || definition.auth);
      return !sensitive && Boolean(definition.url || definition.socket || definition.command);
    }).length;
    return { connectors: result, project_id: project?.project_id ?? null, legacy_config_path: legacy.source, legacy_count: legacyCount };
  }

  async get(connectorId: string, cwd: string): Promise<McpConnector & { referenced_projects: Array<{ project_id: string; name: string }> }> {
    const project = await this.project(cwd);
    const connector = await this.requireConnector(connectorId);
    const view = await this.publicConnector(connector, await this.repository.binding(project.project_id, connectorId));
    return { ...view, referenced_projects: await this.repository.bindingReferences(connectorId) };
  }

  async create(raw: unknown, cwd: string, source: "custom" | "imported" = "custom"): Promise<McpConnector> {
    const input = mcpConnectorCreateSchema.parse(raw);
    const project = await this.project(cwd);
    await this.validate(input, cwd);
    if (await this.repository.getByName(input.name)) throw new McpServiceError("name_conflict", `Connector '${input.name}' already exists`, 409);
    let connector: StoredMcpConnector;
    try { connector = await this.repository.create(input, source); }
    catch (error) { throw sqliteConflict(error); }
    let binding: StoredMcpBinding | null = null;
    if (input.enable_for_project) {
      binding = await this.repository.upsertBinding(project.project_id, connector.connector_id, { enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask" });
      await this.projection?.materialize(cwd, project.project_id);
      await this.reload();
    }
    return this.publicConnector(connector, binding);
  }

  async update(connectorId: string, raw: unknown, cwd: string): Promise<McpConnector> {
    const patch = mcpConnectorUpdateSchema.parse(raw) as McpConnectorUpdate;
    const current = await this.requireConnector(connectorId);
    if (current.source === "builtin") throw new McpServiceError("read_only", "Builtin connectors cannot be edited", 403);
    const merged = mcpConnectorCreateSchema.parse({
      name: patch.name ?? current.name,
      display_name: patch.display_name ?? current.display_name,
      description: patch.description ?? current.description,
      transport: patch.transport ?? current.transport,
      endpoint_url: patch.endpoint_url === undefined ? current.endpoint_url : patch.endpoint_url,
      command: patch.command === undefined ? current.command : patch.command,
      args: patch.args ?? current.args,
      socket_path: patch.socket_path === undefined ? current.socket_path : patch.socket_path,
      runtime_config: patch.runtime_config ?? current.runtime_config,
      credential_ref: patch.credential_ref === undefined ? current.credential_ref : patch.credential_ref,
      enable_for_project: false,
    });
    await this.validate(merged, cwd);
    const duplicate = await this.repository.getByName(merged.name);
    if (duplicate && duplicate.connector_id !== connectorId) throw new McpServiceError("name_conflict", `Connector '${merged.name}' already exists`, 409);
    const { enable_for_project: _enableForProject, ...updateInput } = merged;
    const updated = await this.repository.update(connectorId, patch.revision, updateInput);
    if (!updated) throw new McpServiceError("revision_conflict", "Connector was changed by another request", 409);
    const project = await this.project(cwd);
    const locations = await this.repository.bindingLocations(connectorId);
    if (locations.length) await Promise.all(locations.map((item) => this.projection?.materialize(item.canonical_path, item.project_id)));
    else await this.projection?.materialize(cwd, project.project_id);
    await this.reload();
    return this.publicConnector(updated, await this.repository.binding(project.project_id, connectorId));
  }

  async remove(connectorId: string, cwd: string): Promise<void> {
    const project = await this.project(cwd);
    const connector = await this.requireConnector(connectorId);
    if (connector.source === "builtin") throw new McpServiceError("read_only", "Builtin connectors cannot be removed", 403);
    const references = await this.repository.bindingReferences(connectorId);
    const others = references.filter((item) => item.project_id !== project.project_id);
    if (others.length) throw new McpServiceError("connector_in_use", "Connector is enabled or configured in other projects", 409, { projects: others });
    await this.repository.delete(connectorId);
    await this.projection?.materialize(cwd, project.project_id);
    await this.reload();
  }

  async setBinding(connectorId: string, raw: unknown, cwd: string): Promise<McpConnector> {
    const input = mcpProjectBindingUpdateSchema.parse(raw) as McpProjectBindingUpdate;
    const project = await this.project(cwd);
    const connector = await this.requireConnector(connectorId);
    const binding = await this.repository.upsertBinding(project.project_id, connectorId, input);
    if (!binding) throw new McpServiceError("revision_conflict", "Project connector settings were changed by another request", 409);
    await this.projection?.materialize(cwd, project.project_id);
    const reload = await this.reload();
    const view = await this.publicConnector(connector, binding);
    return Object.assign(view, reload.length ? { reload_replacements: reload } : {});
  }

  async tools(connectorId: string, cwd?: string | null): Promise<{ tools: McpToolSummary[]; cached_at: number | null }> {
    const project = cwd ? await this.project(cwd) : null;
    await this.requireConnector(connectorId);
    const cache = await this.repository.toolCache(connectorId);
    const grants = project ? await this.repository.toolGrants(project.project_id, connectorId) : new Map<string, "allow" | "ask" | "deny">();
    return {
      tools: (cache?.tools ?? []).map((tool) => ({ ...tool, decision: grants.get(tool.name) ?? "ask" })),
      cached_at: cache?.fetched_at ?? null,
    };
  }

  async setToolGrant(connectorId: string, toolName: string, decision: "allow" | "ask" | "deny", cwd: string): Promise<void> {
    const project = await this.project(cwd);
    await this.requireConnector(connectorId);
    if (!(await this.repository.binding(project.project_id, connectorId))) throw new McpServiceError("binding_required", "Enable or configure the connector for this project first", 409);
    await this.repository.setToolGrant(project.project_id, connectorId, toolName, decision);
    await this.projection?.materialize(cwd, project.project_id);
    await this.reload();
  }

  async probe(connectorId: string, cwd: string): Promise<McpProbeResult> {
    const existing = this.probeInflight.get(connectorId);
    if (existing) return existing;
    const pending = this.probeOnce(connectorId, cwd);
    this.probeInflight.set(connectorId, pending);
    try { return await pending; }
    finally { if (this.probeInflight.get(connectorId) === pending) this.probeInflight.delete(connectorId); }
  }

  private async probeOnce(connectorId: string, cwd: string): Promise<McpProbeResult> {
    await this.project(cwd);
    const connector = await this.requireConnector(connectorId);
    const definition = connector.transport === "stdio"
      ? { command: connector.command, required_env: requiredEnvironment(connector) }
      : connector.transport === "socket"
        ? { command: connector.socket_path ? "node" : undefined }
        : { url: connector.endpoint_url, required_env: requiredEnvironment(connector) };
    const result = await probeMcpHealth(definition, process.env, { allowPrivate: connector.runtime_config.allow_private });
    const checkedAt = Date.now();
    if (result.health === "error") { const safeError = redactMcpError(result.error); return { connector_id: connectorId, runtime_state: "error", auth_state: this.authState(connector), error_code: classifyProbeError(safeError), error: safeError, tools: [], checked_at: checkedAt }; }
    try {
      if (connector.endpoint_url && await egressAuditEnabled()) await recordEgress({ connector_type: "mcp", connector_id: connectorId, target_domain: connector.endpoint_url, approved: true, note: "mcp_probe" });
      const tools = await connectAndListMcpTools(connector, cwd);
      await this.repository.replaceToolCache({ connector_id: connectorId, config_revision: connector.revision, fingerprint: mcpConnectorFingerprint(connector), tools, fetched_at: checkedAt, expires_at: checkedAt + 5 * 60_000 });
      return { connector_id: connectorId, runtime_state: "ready", auth_state: this.authState(connector), error_code: null, error: null, tools, checked_at: checkedAt };
    } catch (error) {
      const message = redactMcpError(error instanceof Error ? error.message : String(error)) ?? "MCP probe failed";
      const auth = /401|403|unauthori[sz]ed|oauth|authentication/i.test(message) ? "needs-auth" : this.authState(connector);
      return { connector_id: connectorId, runtime_state: "error", auth_state: auth, error_code: classifyProbeError(message), error: message, tools: [], checked_at: checkedAt };
    }
  }

  async importPreview(cwd: string): Promise<{ source: string | null; entries: Array<Record<string, unknown>> }> {
    await this.project(cwd);
    const { definitions, source } = await this.legacyDefinitions(cwd);
    const existing = new Set((await this.repository.list()).map((item) => item.name));
    return {
      source,
      entries: Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)).map(([name, raw]) => {
        const definition = object(raw);
        const sensitive = Boolean(definition.env || definition.headers || definition.bearerToken || definition.oauth || definition.auth);
        return { name, transport: definition.url ? "streamable_http" : definition.socket ? "socket" : definition.command ? "stdio" : "unknown", conflict: existing.has(name), contains_sensitive_fields: sensitive, importable: !sensitive && Boolean(definition.url || definition.socket || definition.command) };
      }),
    };
  }

  async importCommit(names: string[], cwd: string): Promise<{ imported: McpConnector[]; failed: Array<{ name: string; error: string }> }> {
    const { definitions } = await this.legacyDefinitions(cwd);
    const imported: McpConnector[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const name of [...new Set(names)]) {
      try {
        const definition = object(definitions[name]);
        if (!definition || (!definition.command && !definition.url && !definition.socket)) throw new Error("definition not found or unsupported");
        if (definition.env || definition.headers || definition.bearerToken || definition.oauth || definition.auth) throw new Error("sensitive fields require manual credential migration");
        const transport = definition.command ? "stdio" : definition.socket ? "socket" : "streamable_http";
        imported.push(await this.create({
          name,
          display_name: String(definition.name ?? name),
          description: String(definition.description ?? ""),
          transport,
          endpoint_url: transport === "streamable_http" ? String(definition.url) : null,
          command: transport === "stdio" ? String(definition.command) : null,
          args: Array.isArray(definition.args) ? definition.args.map(String) : [],
          socket_path: transport === "socket" ? String(definition.socket) : null,
          runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "auto", allow_private: false },
          credential_ref: null,
          enable_for_project: true,
        }, cwd, "imported"));
      } catch (error) { failed.push({ name, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { imported, failed };
  }

  private async validate(input: McpConnectorCreate, cwd: string): Promise<void> {
    if (input.transport === "streamable_http" || input.transport === "sse") {
      try { await validateConnectorOutboundUrl(input.endpoint_url!, { allowPrivate: input.runtime_config.allow_private }); }
      catch (error) { throw new McpServiceError("network_blocked", error instanceof Error ? error.message : String(error)); }
    }
    if (input.transport === "stdio") {
      if (input.command!.startsWith("-")) throw new McpServiceError("invalid_config", "command may not start with '-'");
      const configuredCwd = input.runtime_config.cwd;
      if (configuredCwd) {
        if (isAbsolute(configuredCwd)) throw new McpServiceError("workspace_escape", "Local MCP cwd must be relative to the workspace");
        const root = resolve(cwd);
        const target = resolve(root, configuredCwd);
        const pathFromRoot = relative(root, target);
        if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) throw new McpServiceError("workspace_escape", "Local MCP cwd must remain inside the workspace");
      }
    }
    for (const [name, binding] of Object.entries(input.runtime_config.headers)) {
      if (/^(authorization|proxy-authorization|x-api-key)$/i.test(name) && binding.kind === "literal") {
        throw new McpServiceError("secret_literal_forbidden", `${name} must use an environment or credential reference`);
      }
    }
  }

  private async publicConnector(connector: StoredMcpConnector, binding: StoredMcpBinding | null): Promise<McpConnector> {
    const cache = await this.repository.toolCache(connector.connector_id);
    const enabled = binding?.enabled === true;
    return {
      ...connector,
      runtime_config: {
        ...connector.runtime_config,
        environment: redactLiteralBindings(connector.runtime_config.environment),
        headers: redactLiteralBindings(connector.runtime_config.headers),
      },
      binding,
      config_state: "valid",
      auth_state: this.authState(connector),
      runtime_state: enabled ? cache ? "ready" : "unknown" : "disabled",
      tool_count: cache?.tools.length ?? 0,
      error: null,
    };
  }

  private authState(connector: StoredMcpConnector): "not-required" | "configured" | "needs-auth" {
    const auth = connector.runtime_config.auth;
    if (connector.transport === "stdio" || connector.transport === "socket" || auth === "none") return "not-required";
    if (connector.credential_ref) return "configured";
    return auth === "oauth" || auth === "bearer" ? "needs-auth" : "not-required";
  }

  private async project(cwd: string) {
    try { return this.workspaces.rememberWorkspace(await validateWorkspaceCwd(cwd), { touch: false }); }
    catch (error) { throw new McpServiceError("workspace_forbidden", error instanceof Error ? error.message : String(error), 403); }
  }

  private async requireConnector(connectorId: string): Promise<StoredMcpConnector> {
    const connector = await this.repository.get(connectorId);
    if (!connector) throw new McpServiceError("not_found", "MCP connector not found", 404);
    return connector;
  }

  private async legacyDefinitions(cwd?: string | null) {
    const config = await this.settings.read();
    return resolveMcpConfig({ ...(cwd ? { workspaceRoot: cwd } : {}), explicitPath: typeof config.mcp_config_path === "string" ? config.mcp_config_path : undefined });
  }

  private async reload(): Promise<Array<{ cwd: string; oldId: string; newId: string }>> {
    return this.sessions ? this.sessions.reloadConfiguration() : [];
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredEnvironment(connector: StoredMcpConnector): string[] {
  return Object.values(connector.runtime_config.environment).filter((item) => item.kind === "environment").map((item) => item.name);
}

function redactLiteralBindings<T extends { kind: string; value?: string }>(bindings: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, binding.kind === "literal" ? { ...binding, value: "" } : binding]));
}

function classifyProbeError(error: string | null): string {
  if (!error) return "unknown";
  if (error.includes("command not found")) return "command_not_found";
  if (/private|reserved|only http/i.test(error)) return "network_blocked";
  if (error.includes("missing env")) return "invalid_config";
  return "unknown";
}

export function redactMcpError(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s"')]+/gi, (raw) => { try { return new URL(raw).origin; } catch { return "[redacted-url]"; } });
}

function sqliteConflict(error: unknown): McpServiceError {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|constraint/i.test(message) ? new McpServiceError("name_conflict", "A connector with this name already exists", 409) : new McpServiceError("storage_error", message, 500);
}

export function mcpConnectorFingerprint(connector: StoredMcpConnector): string {
  return createHash("sha256").update(JSON.stringify({ transport: connector.transport, endpoint_url: connector.endpoint_url, command: connector.command, args: connector.args, socket_path: connector.socket_path, runtime_config: connector.runtime_config, revision: connector.revision })).digest("hex");
}
