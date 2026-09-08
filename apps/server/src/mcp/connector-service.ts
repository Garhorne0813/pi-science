import { bindingError } from "./bindings.js";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import {
  mcpCredentialUpdateSchema,
  mcpConnectorCreateSchema,
  mcpConnectorUpdateSchema,
  mcpConnectorSettingsUpdateSchema,
  type McpConnector,
  type McpCredentialStatus,
  type McpCredentialUpdate,
  type McpConnectorCreate,
  type McpConnectorUpdate,
  type McpProbeResult,
  type McpRuntimeConfig,
  type McpConnectorSettingsUpdate,
  type McpToolSummary,
} from "@pi-science/contracts";
import { CredentialStore } from "../model-resources/credential-store.js";
import { resolveMcpConfig } from "../catalog/mcp-config.js";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";
import { validateConnectorOutboundUrl } from "../security/outbound-security.js";
import { probeMcpHealth } from "../security/mcp-health.js";
import { validateWorkspaceCwd } from "../security/workspace-security.js";
import type { McpRepository, McpToolDecision, StoredMcpConnector, StoredMcpMigrationConflict, StoredMcpSettings } from "../storage/sqlite/repositories/mcp-repository.js";
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
    private readonly credentials: CredentialStore = new CredentialStore(),
  ) {}

  async ensureBuiltins(): Promise<void> {
    for (const builtin of builtinMcpConnectors()) {
      const connector = await this.repository.upsertBuiltin(builtin.connector_id, builtin.definition, builtin.enabled_by_default);
      const cache = await this.repository.toolCache(connector.connector_id);
      const fingerprint = mcpConnectorFingerprint(connector);
      const cachedTools = cache ? JSON.stringify(cache.tools) : null;
      const builtinTools = JSON.stringify(builtin.tools);
      if (!cache || cache.config_revision !== connector.revision || cache.fingerprint !== fingerprint || cachedTools !== builtinTools || cache.expires_at !== Number.MAX_SAFE_INTEGER) {
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
    }
    await this.materializeKnownWorkspaces();
  }

  async list(cwd?: string | null): Promise<{ connectors: McpConnector[]; migration_conflicts: StoredMcpMigrationConflict[]; legacy_config_path: string | null; legacy_count: number }> {
    const connectors = await this.repository.list();
    const result = await Promise.all(connectors.map((item) => this.publicConnector(item)));
    const migrationConflicts = await this.repository.migrationConflicts();
    const legacy = await this.legacyDefinitions(cwd);
    const canonicalNames = new Set(connectors.map((item) => item.name.toLowerCase()));
    const legacyCount = Object.entries(legacy.definitions).filter(([name, raw]) => {
      if (canonicalNames.has(name.toLowerCase())) return false;
      const definition = object(raw);
      const sensitive = Boolean(definition.env || definition.headers || definition.bearerToken || definition.oauth || definition.auth);
      return !sensitive && Boolean(definition.url || definition.socket || definition.command);
    }).length;
    return { connectors: result, migration_conflicts: migrationConflicts, legacy_config_path: legacy.source, legacy_count: legacyCount };
  }

  async get(connectorId: string): Promise<McpConnector> {
    return this.publicConnector(await this.requireConnector(connectorId));
  }

  async credential(connectorId: string): Promise<McpCredentialStatus> {
    return this.credentialStatus(await this.requireConnector(connectorId));
  }

  async setCredential(connectorId: string, raw: unknown): Promise<McpCredentialStatus> {
    const input = mcpCredentialUpdateSchema.parse(raw) as McpCredentialUpdate;
    const connector = await this.requireConnector(connectorId);
    if (suggestedCredential(connector).capability === "unsupported") throw new McpServiceError("credential_unsupported", "This connector does not support an API credential", 400);
    if (input.revision !== connector.revision) throw new McpServiceError("revision_conflict", "Connector was changed by another request", 409);
    const credentialId = connector.credential_ref ?? `mcp_${connector.connector_id}`;
    const existing = await this.credentials.getForRuntime(credentialId);
    if (existing && (existing.metadata.owner_kind !== "mcp" || existing.metadata.owner_id !== connectorId)) throw new McpServiceError("credential_in_use", "Credential belongs to another resource", 409);
    if (input.backend === "managed" && !input.secret && !existing?.secret) throw new McpServiceError("credential_required", "API key or token is required");
    await this.credentials.put({
      id: credentialId, kind: "api_key", backend: input.backend, label: `${connector.display_name} MCP credential`,
      ...(input.secret ? { secret: input.secret } : {}),
      ...(input.environment_variable ? { environment_variable: input.environment_variable } : {}),
      owner_kind: "mcp", owner_id: connectorId,
    });
    const runtime = clearCredentialBindings(connector.runtime_config, connector.credential_ref);
    const binding = { kind: "credential" as const, credential_ref: credentialId, ...(input.delivery === "bearer" ? { prefix: "Bearer " } : {}) };
    if (input.delivery === "environment") runtime.environment[input.target_name] = binding;
    else runtime.headers[input.delivery === "bearer" ? "Authorization" : input.target_name] = binding;
    runtime.auth = input.delivery === "bearer" ? "bearer" : "auto";
    const updated = await this.repository.updateCredential(connectorId, connector.revision, runtime, credentialId);
    if (!updated) throw new McpServiceError("revision_conflict", "Connector was changed by another request", 409);
    await this.materializeKnownWorkspaces(); await this.reload();
    return this.credentialStatus(updated);
  }

  async removeCredential(connectorId: string): Promise<McpCredentialStatus> {
    const connector = await this.requireConnector(connectorId);
    const credentialRef = connector.credential_ref;
    const runtime = clearCredentialBindings(connector.runtime_config, credentialRef);
    runtime.auth = "auto";
    const updated = await this.repository.updateCredential(connectorId, connector.revision, runtime, null);
    if (!updated) throw new McpServiceError("revision_conflict", "Connector was changed by another request", 409);
    if (credentialRef) {
      const metadata = await this.credentials.metadata(credentialRef);
      if (metadata?.owner_kind === "mcp" && metadata.owner_id === connectorId) await this.credentials.remove(credentialRef);
    }
    await this.materializeKnownWorkspaces(); await this.reload();
    return this.credentialStatus(updated);
  }

  async create(raw: unknown, source: "custom" | "imported" = "custom"): Promise<McpConnector> {
    const input = mcpConnectorCreateSchema.parse(raw);
    await this.validate(input);
    if (await this.repository.getByName(input.name)) throw new McpServiceError("name_conflict", `Connector '${input.name}' already exists`, 409);
    let connector: StoredMcpConnector;
    try { connector = await this.repository.create(input, source); }
    catch (error) { throw sqliteConflict(error); }
    if (input.enabled) { await this.materializeKnownWorkspaces(); await this.reload(); }
    return this.publicConnector(connector);
  }

  async update(connectorId: string, raw: unknown): Promise<McpConnector> {
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
      enabled: current.enabled,
    });
    await this.validate(merged, connectorId);
    const duplicate = await this.repository.getByName(merged.name);
    if (duplicate && duplicate.connector_id !== connectorId) throw new McpServiceError("name_conflict", `Connector '${merged.name}' already exists`, 409);
    const { enabled: _enabled, ...updateInput } = merged;
    const updated = await this.repository.update(connectorId, patch.revision, updateInput);
    if (!updated) throw new McpServiceError("revision_conflict", "Connector was changed by another request", 409);
    await this.materializeKnownWorkspaces();
    await this.reload();
    return this.publicConnector(updated);
  }

  async remove(connectorId: string): Promise<void> {
    const connector = await this.requireConnector(connectorId);
    if (connector.source === "builtin") throw new McpServiceError("read_only", "Builtin connectors cannot be removed", 403);
    await this.repository.delete(connectorId);
    if (connector.credential_ref) {
      const metadata = await this.credentials.metadata(connector.credential_ref);
      if (metadata?.owner_kind === "mcp" && metadata.owner_id === connectorId) await this.credentials.remove(connector.credential_ref);
    }
    await this.materializeKnownWorkspaces();
    await this.reload();
  }

  async setSettings(connectorId: string, raw: unknown): Promise<McpConnector> {
    const input = mcpConnectorSettingsUpdateSchema.parse(raw) as McpConnectorSettingsUpdate;
    const connector = await this.requireConnector(connectorId);
    if (input.enabled) await this.validate(connector, connectorId);
    const settings = await this.repository.updateSettings(connectorId, input);
    if (!settings) throw new McpServiceError("revision_conflict", "Connector settings were changed by another request", 409);
    await this.materializeKnownWorkspaces();
    const reload = await this.reload();
    const view = await this.publicConnector({ ...connector, enabled: settings.enabled, include_tools: settings.include_tools, exclude_tools: settings.exclude_tools, approval_mode: settings.approval_mode, settings_revision: settings.revision, updated_at: settings.updated_at });
    return Object.assign(view, reload.length ? { reload_replacements: reload } : {});
  }

  async tools(connectorId: string, cwd?: string | null): Promise<{ tools: McpToolSummary[]; cached_at: number | null; scope: "global" | "project" }> {
    const connector = await this.requireConnector(connectorId);
    const project = cwd ? await this.project(cwd) : null;
    const cache = await this.repository.toolCache(connectorId);
    const globalGrants = await this.repository.globalToolGrants(connectorId);
    const projectGrants = project ? await this.repository.projectToolGrants(project.project_id, connectorId) : new Map<string, McpToolDecision>();
    return {
      tools: (cache?.tools ?? []).map((tool) => ({ ...tool, ...effectiveToolDecision(connector, tool.name, globalGrants, projectGrants) })),
      cached_at: cache?.fetched_at ?? null,
      scope: project ? "project" : "global",
    };
  }

  async setToolGrant(connectorId: string, toolName: string, decision: McpToolDecision, cwd?: string | null): Promise<void> {
    await this.requireConnector(connectorId);
    if (cwd) {
      const project = await this.project(cwd);
      await this.repository.setProjectToolGrant(project.project_id, connectorId, toolName, decision);
      await this.projection?.materialize(project.canonical_path, project.project_id);
    } else {
      await this.repository.setGlobalToolGrant(connectorId, toolName, decision);
      await this.materializeKnownWorkspaces();
    }
    await this.reload();
  }

  async clearToolGrant(connectorId: string, toolName: string, cwd?: string | null): Promise<void> {
    await this.requireConnector(connectorId);
    if (cwd) {
      const project = await this.project(cwd);
      await this.repository.clearProjectToolGrant(project.project_id, connectorId, toolName);
      await this.projection?.materialize(project.canonical_path, project.project_id);
    } else {
      await this.repository.clearGlobalToolGrant(connectorId, toolName);
      await this.materializeKnownWorkspaces();
    }
    await this.reload();
  }

  async probe(connectorId: string): Promise<McpProbeResult> {
    const existing = this.probeInflight.get(connectorId);
    if (existing) return existing;
    const pending = this.probeOnce(connectorId);
    this.probeInflight.set(connectorId, pending);
    try { return await pending; }
    finally { if (this.probeInflight.get(connectorId) === pending) this.probeInflight.delete(connectorId); }
  }

  private async probeOnce(connectorId: string): Promise<McpProbeResult> {
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
      const tools = await connectAndListMcpTools(connector, process.cwd());
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
          enabled: true,
        }, "imported"));
      } catch (error) { failed.push({ name, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { imported, failed };
  }

  private async validate(input: McpConnectorCreate, connectorId?: string): Promise<void> {
    const invalid = bindingError(input.runtime_config, input.credential_ref);
    if (invalid) throw new McpServiceError("unsupported_binding", invalid);
    if (input.credential_ref) {
      if (!connectorId) throw new McpServiceError("unsupported_binding", "Configure credentials from the connector authentication settings after creating the connector");
      const credential = await this.credentials.metadata(input.credential_ref);
      if (!credential || credential.owner_kind !== "mcp" || credential.owner_id !== connectorId) throw new McpServiceError("invalid_credential", "Connector credential is missing or belongs to another resource");
    }
    if (input.transport === "streamable_http" || input.transport === "sse") {
      try { await validateConnectorOutboundUrl(input.endpoint_url!, { allowPrivate: input.runtime_config.allow_private }); }
      catch (error) { throw new McpServiceError("network_blocked", error instanceof Error ? error.message : String(error)); }
    }
    if (input.transport === "stdio") {
      if (input.command!.startsWith("-")) throw new McpServiceError("invalid_config", "command may not start with '-'");
      const configuredCwd = input.runtime_config.cwd;
      if (configuredCwd) {
        if (isAbsolute(configuredCwd)) throw new McpServiceError("workspace_escape", "Local MCP cwd must be relative to the workspace");
        const normalized = normalize(configuredCwd);
        if (normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new McpServiceError("workspace_escape", "Local MCP cwd must remain inside the workspace");
      }
    }

  }

  private async publicConnector(connector: StoredMcpConnector): Promise<McpConnector> {
    const cache = await this.repository.toolCache(connector.connector_id);
    const settings: StoredMcpSettings = { connector_id: connector.connector_id, enabled: connector.enabled, include_tools: connector.include_tools, exclude_tools: connector.exclude_tools, approval_mode: connector.approval_mode, revision: connector.settings_revision, created_at: connector.created_at, updated_at: connector.updated_at };
    const { enabled: _enabled, include_tools: _includeTools, exclude_tools: _excludeTools, approval_mode: _approvalMode, settings_revision: _settingsRevision, ...definition } = connector;
    return {
      ...definition,
      runtime_config: {
        ...connector.runtime_config,
        environment: redactLiteralBindings(connector.runtime_config.environment),
        headers: redactLiteralBindings(connector.runtime_config.headers),
      },
      settings,
      config_state: bindingError(connector.runtime_config, connector.credential_ref) ? "invalid" : "valid",
      auth_state: this.authState(connector),
      runtime_state: bindingError(connector.runtime_config, connector.credential_ref) ? "error" : connector.enabled ? cache ? "ready" : "unknown" : "disabled",
      tool_count: cache?.tools.length ?? 0,
      error: bindingError(connector.runtime_config, connector.credential_ref),
    };
  }

  private authState(connector: StoredMcpConnector): "not-required" | "configured" | "needs-auth" {
    // Local transports do not authenticate the MCP connection. Any credential
    // binding on these connectors belongs to an upstream API used by the child.
    if (connector.transport === "stdio" || connector.transport === "socket") return "not-required";
    if (bindingError(connector.runtime_config, connector.credential_ref)) return "needs-auth";
    if (connector.credential_ref) return this.credentials.readSync(connector.credential_ref)?.secret ? "configured" : "needs-auth";
    const auth = connector.runtime_config.auth;
    if (auth === "none") return "not-required";
    const authorization = Object.entries(connector.runtime_config.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
    if (authorization?.kind === "environment" && process.env[authorization.name]) return "configured";
    return auth === "oauth" || auth === "bearer" ? "needs-auth" : "not-required";
  }

  private async credentialStatus(connector: StoredMcpConnector): Promise<McpCredentialStatus> {
    const suggestion = suggestedCredential(connector);
    const reference = connector.credential_ref;
    const value = reference ? await this.credentials.getForRuntime(reference) : null;
    const environment = Object.entries(connector.runtime_config.environment).find(([, binding]) => binding.kind === "credential" && binding.credential_ref === reference);
    const header = Object.entries(connector.runtime_config.headers).find(([, binding]) => binding.kind === "credential" && binding.credential_ref === reference);
    const delivery = environment ? "environment" : header?.[0].toLowerCase() === "authorization" && header[1].kind === "credential" && header[1].prefix === "Bearer " ? "bearer" : header ? "header" : null;
    return {
      capability: suggestion.capability,
      credential_ref: reference, configured: Boolean(value?.secret),
      backend: value?.metadata.backend === "managed" || value?.metadata.backend === "environment" ? value.metadata.backend : null,
      delivery, target_name: environment?.[0] ?? header?.[0] ?? null,
      environment_variable: value?.metadata.environment_variable ?? null,
      suggested_delivery: suggestion.delivery, suggested_target_name: suggestion.target,
    };
  }

  private async project(cwd: string) {
    try { return this.workspaces.rememberWorkspace(await validateWorkspaceCwd(cwd), { touch: false }); }
    catch (error) { throw new McpServiceError("workspace_forbidden", error instanceof Error ? error.message : String(error), 403); }
  }

  async materializeWorkspace(cwd: string): Promise<void> {
    const project = await this.project(cwd);
    await this.projection?.materialize(project.canonical_path, project.project_id);
  }

  private async materializeKnownWorkspaces(): Promise<void> {
    const locations = await this.workspaces.listKnown({ includeMissing: false });
    await Promise.all(locations.map((item) => this.projection?.materialize(item.canonical_path, item.project_id)));
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

function clearCredentialBindings(config: McpRuntimeConfig, credentialRef?: string | null): McpRuntimeConfig {
  const keep = (binding: McpRuntimeConfig["environment"][string]) => binding.kind !== "credential" || binding.credential_ref !== credentialRef;
  return {
    ...config,
    environment: Object.fromEntries(Object.entries(config.environment).filter(([, binding]) => keep(binding))),
    headers: Object.fromEntries(Object.entries(config.headers).filter(([, binding]) => keep(binding))),
  };
}

function suggestedCredential(connector: StoredMcpConnector): { capability: "unsupported" | "optional" | "required"; delivery: "environment" | "header" | "bearer" | null; target: string | null } {
  const builtinTargets: Record<string, string> = {
    mcp_builtin_paper_search: "NCBI_API_KEY",
    mcp_builtin_literature_graph: "OPENALEX_API_KEY",
    mcp_builtin_omics_archives: "NCBI_API_KEY",
    mcp_builtin_nucleotide_archives: "NCBI_API_KEY",
    mcp_builtin_drug_regulatory: "OPENFDA_API_KEY",
  };
  if (connector.source === "builtin") {
    const target = builtinTargets[connector.connector_id];
    return target
      ? { capability: "optional", delivery: "environment", target }
      : { capability: "unsupported", delivery: null, target: null };
  }
  if (connector.transport === "stdio" || connector.transport === "socket") return { capability: "optional", delivery: "environment", target: "API_KEY" };
  const required = connector.runtime_config.auth === "bearer" || connector.runtime_config.auth === "oauth";
  return { capability: required ? "required" : "optional", delivery: "bearer", target: "Authorization" };
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

function effectiveToolDecision(
  connector: StoredMcpConnector,
  toolName: string,
  globalGrants: Map<string, McpToolDecision>,
  projectGrants: Map<string, McpToolDecision>,
): { decision: McpToolDecision; decision_scope: "project" | "global" | "default" } {
  const global = globalGrants.get(toolName);
  const project = projectGrants.get(toolName);
  // A global deny is a hard safety boundary. Project settings may make a
  // global default more restrictive or more permissive, but cannot lift it.
  if (global === "deny") return { decision: "deny", decision_scope: "global" };
  if (project) return { decision: project, decision_scope: "project" };
  if (global) return { decision: global, decision_scope: "global" };
  return { decision: connector.approval_mode === "allow_all" ? "allow" : "ask", decision_scope: "default" };
}
