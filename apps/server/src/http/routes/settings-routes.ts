import { nativeProviderViews } from "../../model-config/provider-config-view.js";
import { registerModelSelectionRoutes } from "./model-selection-routes.js";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { defaultProgressAppearance, progressAppearanceInputSchema, progressAppearanceSchema } from "@pi-science/contracts";
import { canonicalRuntimeModelRef } from "../../runtime/agent/model-ref.js";
import { configPath } from "../../storage/persistence.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { agentModelCatalog } from "../../runtime/agent/worker/agent-models.js";
import { resolveCompaction } from "../../runtime/agent/agent-runtime-settings.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { SettingsStore, type SettingsData as Settings } from "../../storage/settings-store.js";
import { catalog as skillCatalog } from "../../catalog/skill-catalog.js";
import type { RuntimeCatalog, RuntimeCatalogProvider, RuntimeCatalogModel } from "../../runtime/agent/runtime-catalog.js";
import {
  createProjectSkill,
  deleteProjectSkill,
  importGithubSkills,
  importSkillBundle,
  MAX_UPLOAD_BYTES,
  previewGithubSkills,
  previewSkillUpload,
  updateProjectSkill,
} from "../../catalog/project-skill-service.js";
import { knownWorkspacePaths } from "./catalog-routes.js";
import type { RuntimeResult, RuntimeSkillPolicy } from "../../runtime/agent/agent-runtime-types.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";
import type { RuntimeCatalogService } from "../../runtime/agent/runtime-catalog.js";
import { resolveMcpConfig } from "../../catalog/mcp-config.js";
import type { McpConnectorService } from "../../mcp/connector-service.js";
const BUILTIN_SUBAGENTS = [
  ["context-builder", "Builds grounded context for a later agent."],
  ["delegate", "Handles a focused delegated task."],
  ["oracle", "Provides a second opinion on difficult decisions."],
  ["planner", "Turns context into an implementation plan."],
  ["researcher", "Investigates a focused research question."],
  ["reviewer", "Reviews work for correctness and quality."],
  ["scout", "Explores the workspace and gathers context."],
  ["worker", "Implements an approved task."],
] as const;
const SUBAGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

type DiscoveredSubagent = { name: string; description: string; source: "builtin" | "project" };

function unquoteFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseProjectSubagent(content: string): { name: string; description: string; packageName?: string } | null {
  const block = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
  if (!block) return null;
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) fields.set(match[1] ?? "", unquoteFrontmatterValue(match[2] ?? ""));
  }
  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  if (!name || !description || !SUBAGENT_NAME_PATTERN.test(name)) return null;
  const rawPackage = fields.get("package")?.trim();
  const packageName = rawPackage
    ? rawPackage.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "").replace(/-+/g, "-").replace(/\.+/g, ".").replace(/(?:^[-.]+|[-.]+$)/g, "")
    : undefined;
  if (rawPackage && (!packageName || !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(packageName))) return null;
  return { name, description, ...(packageName ? { packageName } : {}) };
}
async function respondWithRuntimeReload<T extends Record<string, unknown>>(nodeSessionService: NodeSessionService, reply: FastifyReply, payload: T): Promise<(T & { session_replacements: Array<{ cwd: string; oldId: string; newId: string }> }) | FastifyReply> {
  try {
    const replacements = await nodeSessionService.reloadConfiguration();
    return { ...payload, session_replacements: replacements };
  }
  catch (error) {
    reply.code(502).send({ ok: false, error: `Settings were saved, but Pi runtime reload failed: ${String(error)}` });
    return reply;
  }
}
function storedSkillPolicy(config: Settings): RuntimeSkillPolicy {
  const policy = config.skill_policy;
  if (!policy) return { mode: "inherit" };
  if (policy.mode === "inherit" || policy.mode === "none") return { mode: policy.mode };
  return { mode: policy.mode, skills: [...new Set(policy.skills.map(String).filter(Boolean))].sort() };
}
function skillEnabled(policy: RuntimeSkillPolicy, name: string): boolean {
  if (policy.mode === "inherit") return true;
  if (policy.mode === "none") return false;
  return policy.mode === "allowlist" ? policy.skills.includes(name) : !policy.skills.includes(name);
}
function toggledSkillPolicy(policy: RuntimeSkillPolicy, name: string, enabled: boolean): RuntimeSkillPolicy {
  if (policy.mode === "inherit") return enabled ? policy : { mode: "denylist", skills: [name] };
  if (policy.mode === "none") return enabled ? { mode: "allowlist", skills: [name] } : policy;
  const skills = new Set(policy.skills);
  if (policy.mode === "allowlist") enabled ? skills.add(name) : skills.delete(name);
  else enabled ? skills.delete(name) : skills.add(name);
  const values = [...skills].sort();
  if (policy.mode === "denylist" && values.length === 0) return { mode: "inherit" };
  return { mode: policy.mode, skills: values };
}
function reconcileSkillPolicy(policy: RuntimeSkillPolicy, names: Set<string>): RuntimeSkillPolicy {
  if (policy.mode === "inherit" || policy.mode === "none") return policy;
  const skills = policy.skills.filter((name) => names.has(name));
  if (policy.mode === "denylist" && skills.length === 0) return { mode: "inherit" };
  return { mode: policy.mode, skills };
}
function runtimeSkillFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "runtime_error";
  const status = code === "runtime_busy" ? 409 : code === "runtime_skill_control_unavailable" ? 501 : code === "unknown_runtime_skills" ? 400 : 502;
  return reply.code(status).send({ ok: false, code, error: error instanceof Error ? error.message : String(error) });
}
async function unifiedSkillCatalog() {
  const catalogs = await Promise.all([process.cwd(), ...await knownWorkspacePaths()].map((cwd) => skillCatalog(cwd)));
  const byName = new Map<string, Awaited<ReturnType<typeof skillCatalog>>[number]>();
  for (const catalog of catalogs) for (const skill of catalog) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function catalogModels(catalog: RuntimeCatalog): Array<Record<string, unknown>> {
  return catalog.providers.flatMap((provider) => provider.models.map((model) => runtimeModel(provider, model)));
}

function runtimeModel(provider: RuntimeCatalogProvider, model: RuntimeCatalogModel): Record<string, unknown> {
  const thinkingLevels = normalizeThinkingLevels(model.thinkingLevels);
  return {
    id: `${provider.id}/${model.id}`,
    provider: provider.id,
    model: model.id,
    label: `${provider.name} · ${model.name}`,
    custom: provider.id.startsWith("user-"),
    reasoning: model.reasoning,
    thinking_levels: model.reasoning ? thinkingLevels ?? [...FALLBACK_DEFAULT_THINKING_LEVELS] : ["off"],
    context_window: model.contextWindow || null,
    max_output_tokens: model.maxTokens || null,
    input_formats: model.input,
    vision: model.input.includes("image"),
    capability_source: "agent-core-catalog",
  };
}

async function readRuntimeCatalog(source?: Pick<RuntimeCatalogService, "getCatalog">): Promise<RuntimeCatalog> {
  if (!source) return { schemaVersion: 1, providers: [] };
  try { return await source.getCatalog(); }
  catch (error) {
    if (process.env.NODE_ENV !== "test") throw error;
    return { schemaVersion: 1, providers: [] };
  }
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
/** Fallback capability guess for models without explicit hints: never invent
 *  xhigh/max — the live runtime's `get_available_thinking_levels` overrides
 *  the configured model once a session is active. */
const FALLBACK_DEFAULT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

/** Validate a runtime/catalog level list: every entry must be a canonical
 *  thinking level, duplicates collapse, and the result is returned in
 *  canonical order (a strict subset is still ordered). Null when the value
 *  is not a usable level list. */
function normalizeThinkingLevels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const entry of value) {
    const level = String(entry ?? "");
    if (!THINKING_LEVEL_SET.has(level)) return null;
    seen.add(level);
  }
  if (seen.size === 0) return null;
  return THINKING_LEVELS.filter((level) => seen.has(level));
}


/** Clamp a requested thinking level to the model's supported list, mirroring
 *  the frontend `clampThinkingLevel`: keep the request when supported,
 *  otherwise the closest level at-or-below (then at-or-above), then the first
 *  supported level, then `"off"` as the final safe fallback. */
function clampThinking(requested: string, levels: string[]): string {
  if (levels.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested as (typeof THINKING_LEVELS)[number]);
  const start = requestedIndex === -1 ? 0 : requestedIndex;
  return THINKING_LEVELS.slice(start).find((level) => levels.includes(level))
    || [...THINKING_LEVELS].slice(0, start).reverse().find((level) => levels.includes(level))
    || levels[0]
    || "off";
}

function normalizePiModel(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const provider = typeof item.provider === "string" ? item.provider : "";
  const model = typeof item.id === "string" ? item.id : "";
  if (!provider || !model) return null;
  const explicitReasoning = typeof item.reasoning === "boolean";
  const reasoning = explicitReasoning ? item.reasoning === true : undefined;
  const listedLevels = normalizeThinkingLevels(item.thinkingLevels ?? item.thinking_levels);
  const levelMap = item.thinkingLevelMap && typeof item.thinkingLevelMap === "object" ? item.thinkingLevelMap as Record<string, unknown> : {};
  const hasExplicitLevels = Object.keys(levelMap).length > 0;
  // A runtime entry WITHOUT capability metadata (no reasoning flag, no
  // thinkingLevels/thinkingLevelMap) must not invent levels or erase the
  // authoritative pi-ai/custom-hint values: leave both fields undefined for
  // the merge to keep the previous entry's values. Prefer the runtime's normalized
  // list; retain thinkingLevelMap support for older runtime projections.
  const thinkingLevels = reasoning === true
    ? listedLevels ?? (hasExplicitLevels
      ? THINKING_LEVELS.filter((level) => levelMap[level] !== null && (level !== "xhigh" && level !== "max" || Object.hasOwn(levelMap, level)))
      : undefined)
    : reasoning === false ? ["off"] : undefined;
  const name = typeof item.name === "string" && item.name ? item.name : model;
  const contextWindow = Number(item.contextWindow ?? 0);
  const maxTokens = Number(item.maxTokens ?? item.max_output_tokens ?? 0);
  const inputFormats = Array.isArray(item.input) ? item.input.filter((format): format is string => typeof format === "string") : undefined;
  return { id: `${provider}/${model}`, provider, model, label: `${provider} · ${name}`, custom: provider.startsWith("custom-"), reasoning, thinking_levels: thinkingLevels, context_window: contextWindow > 0 ? contextWindow : null,
    max_output_tokens: maxTokens > 0 ? maxTokens : undefined, input_formats: inputFormats, vision: inputFormats ? inputFormats.includes("image") : undefined, capability_source: "Pi runtime" };
}
type ModelSnapshot = { catalog: RuntimeCatalog; models: RuntimeResult };
async function readModelSnapshot(nodeSessionService: NodeSessionService, cwdValue: string, runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">): Promise<ModelSnapshot> {
  const [catalog, models] = await Promise.all([
    readRuntimeCatalog(runtimeCatalog),
    cwdValue ? nodeSessionService.availableModels(cwdValue) : agentModelCatalog().then((models) => ({ success: true, data: { models } })),
  ]);
  return { catalog, models };
}

async function modelCatalog(nodeSessionService: NodeSessionService, config: Settings, cwdValue: string, runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">, snapshot?: ModelSnapshot): Promise<{ available: Array<Record<string, unknown>>; source: "pi" | "fallback" }> {
  const read = snapshot ?? await readModelSnapshot(nodeSessionService, cwdValue, runtimeCatalog);
  const data = read.models.data && typeof read.models.data === "object" ? read.models.data as Record<string, unknown> : {};
  if (!cwdValue) {
    return { available: (Array.isArray(data.models) ? data.models : []).map(normalizePiModel).filter((item): item is Record<string, unknown> => Boolean(item)), source: "pi" };
  }
  if (read.models.success && Array.isArray(data.models)) {
    const available = data.models.map(normalizePiModel).filter((item): item is Record<string, unknown> => Boolean(item));
    const metadata = new Map(catalogModels(read.catalog).map((item) => [item.id, item]));
    for (const model of available) {
      const known = metadata.get(model.id);
      if (!known) continue;
      if (model.reasoning === undefined) model.reasoning = known.reasoning;
      if (!Array.isArray(model.thinking_levels) || !model.thinking_levels.length) model.thinking_levels = known.thinking_levels;
      if (!model.context_window) model.context_window = known.context_window;
      if (!model.max_output_tokens) model.max_output_tokens = known.max_output_tokens;
      if (!Array.isArray(model.input_formats) || !model.input_formats.length) model.input_formats = known.input_formats;
      if (model.vision === undefined && Array.isArray(model.input_formats)) model.vision = model.input_formats.includes("image");
    }
    return { available, source: "pi" };
  }
  return { available: [], source: "fallback" };
}

type ProviderInventoryEntry = {
  id: string;
  name: string;
  models: string[];
  auth: { kind: "api_key" | "oauth" | "api_key_or_oauth" | "none"; api_key_supported: boolean; oauth_supported: boolean; login_supported: false };
  credential_status: "configured" | "connected" | "needs_key" | "needs_login" | "invalid";
  enabled: boolean;
  has_key: boolean;
  custom?: boolean;
};

/** Builtin provider inventory from the Agent Core catalog. Workspace model
 *  availability still comes from the live session's `/api/models` command. */
async function providerInventory(nodeSessionService: NodeSessionService, config: Settings, cwdValue: string, modelResources?: ModelResourceService, runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">, snapshot?: ModelSnapshot): Promise<ProviderInventoryEntry[]> {
  const read = snapshot ?? await readModelSnapshot(nodeSessionService, cwdValue, runtimeCatalog);
  const data = read.models.success ? read.models.data as { models?: Array<{ provider: string; id: string }> } : undefined;
  const available = new Set((data?.models ?? []).map((model) => `${model.provider}/${model.id}`));
  return (await nativeProviderViews()).map((provider) => ({ id: provider.id, name: provider.name,
    models: provider.models.filter((model) => available.has(model.id)).map((model) => model.model_id),
    auth: { kind: provider.auth.kind, api_key_supported: provider.auth.api_key_supported, oauth_supported: false, login_supported: false },
    credential_status: provider.credential.configured ? "configured" : "needs_key", enabled: provider.enabled,
    has_key: provider.credential.configured, custom: provider.source === "user" }));
}
function query(request: { query: unknown }, name: string, fallback = "."): string { const value = (request.query as Record<string, unknown>)[name]; return typeof value === "string" && value ? value : fallback; }
function compactionThreshold(config: Settings, available: Array<Record<string, unknown>>, configured: string): number {
  const override = config.model_context_window_override;
  const contextWindow = override?.model === configured ? override.context_window
    : Number(available.find((item) => item.id === configured)?.context_window ?? 0);
  return resolveCompaction(contextWindow || 16384, config).thresholdPercent;
}
export function registerSettingsRoutes(app: FastifyInstance, nodeSessionService: NodeSessionService, settingsStore: SettingsStore, modelResources?: ModelResourceService, runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">, mcp?: McpConnectorService): void {
  const load = () => settingsStore.read();
  const mutate = <T>(operation: (config: Settings) => T | Promise<T>) => settingsStore.update(operation, { skipUnchanged: true });
  function respondWithReload<T extends Record<string, unknown>>(reply: FastifyReply, payload: T): ReturnType<typeof respondWithRuntimeReload<T>>;
  function respondWithReload<T extends Record<string, unknown>>(service: NodeSessionService, reply: FastifyReply, payload: T): ReturnType<typeof respondWithRuntimeReload<T>>;
  function respondWithReload<T extends Record<string, unknown>>(first: NodeSessionService | FastifyReply, second: FastifyReply | T, third?: T) {
    return third
      ? respondWithRuntimeReload(first as NodeSessionService, second as FastifyReply, third)
      : respondWithRuntimeReload(nodeSessionService, first as FastifyReply, second as T);
  }
  app.get("/api/settings/providers", async () => { const config = await load(); return { providers: await providerInventory(nodeSessionService, config, "", modelResources, runtimeCatalog) }; });
  app.get("/api/settings/config", async (request) => {
    const config = await load();
    const cwdValue = query(request, "cwd", "");
    // Request-scoped snapshot: inventory and capabilities observe the same
    // model read, without caching credentials across configuration writes.
    const snapshot = await readModelSnapshot(nodeSessionService, cwdValue, runtimeCatalog);
    const catalog = await modelCatalog(nodeSessionService, config, cwdValue, runtimeCatalog, snapshot);
    const catalogById = new Map(catalog.available.map((model) => [model.id, model]));
    let available = catalog.available;
    const modelRef = typeof config.model === "string" && config.model ? canonicalRuntimeModelRef(config.model) : null;
    const configured = modelRef && available.some((item) => item.id === modelRef) ? modelRef : "";
    const unavailableModel = modelRef && !configured ? modelRef : null;
    let thinking = configured ? String(config.thinking ?? "high") : "off";
    if (configured && cwdValue) {
      const actual = await nodeSessionService.availableThinkingLevels(cwdValue, configured);
      if (actual.success && actual.data && typeof actual.data === "object") {
        const data = actual.data as Record<string, unknown>;
        const levels = normalizeThinkingLevels(data.levels);
        // Only apply runtime levels when the runtime verified it is running
        // the configured model; a different model's levels must never leak in.
        if (levels && data.model === configured) {
          const selected = available.find((item) => item.id === configured);
          if (selected) { selected.thinking_levels = levels; selected.reasoning = levels.length > 1 || levels[0] !== "off"; }
          const effective = clampThinking(thinking, levels);
          thinking = effective;
        }
      }
    }
    const selected = available.find((item) => item.id === configured);
    if (selected?.context_window) config.model_context_window = Number(selected.context_window);
    const progressAppearance = progressAppearanceSchema.safeParse(config.progress_appearance ?? {});
    const effectiveProgressAppearance = progressAppearance.success ? progressAppearance.data : defaultProgressAppearance;
    const providers = await providerInventory(nodeSessionService, config, cwdValue, modelResources, runtimeCatalog, snapshot);
    const apiKeys = Object.fromEntries(providers.map((provider) => [provider.id, provider.has_key]));
    return { api_keys: apiKeys, model: configured, unavailable_model: unavailableModel, thinking, model_context_window: config.model_context_window ?? null, model_context_window_override: config.model_context_window_override ?? null, model_max_output_tokens: Number(selected?.max_output_tokens ?? 0) || null, progress_appearance: effectiveProgressAppearance, compaction_enabled: config.compaction_enabled !== false, compaction_threshold_percent: compactionThreshold(config, available, configured), allow_private_providers: config.allow_private_providers !== false, providers, custom_providers: [], available_models: available, model_catalog_source: catalog.source };
  });
  // UI-only state: a dedicated cheap read (no provider inventory or model
  // catalog work) and a write that never reloads runtimes or replaces
  // sessions — progress appearance must not touch conversation state.
  app.get("/api/settings/progress", async () => {
    const config = await load();
    const progressAppearance = progressAppearanceSchema.safeParse(config.progress_appearance ?? {});
    return { progress_appearance: progressAppearance.success ? progressAppearance.data : defaultProgressAppearance };
  });
  app.put("/api/settings/progress", async (request, reply) => {
    const parsed = progressAppearanceInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid progress appearance settings", details: parsed.error.flatten() });
    await mutate((config) => { config.progress_appearance = parsed.data; });
    return reply.send({ ok: true, progress_appearance: parsed.data });
  });
  app.put("/api/settings/private-providers", async (request, reply) => { const body = (request.body ?? {}) as { enabled?: unknown }; const enabled = body.enabled !== false; await mutate((config) => { config.allow_private_providers = enabled; }); return respondWithReload(nodeSessionService, reply, { ok: true, allow_private_providers: enabled }); });
  registerModelSelectionRoutes(app, nodeSessionService, settingsStore, modelResources, async (cwd) => (await modelCatalog(nodeSessionService, await load(), cwd, runtimeCatalog)).available);
  app.put("/api/settings/compaction", async (request, reply) => { const body = (request.body ?? {}) as { enabled?: unknown; threshold_percent?: unknown }; const threshold = body.threshold_percent === undefined ? undefined : Number(body.threshold_percent); if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 50 || threshold > 95)) return reply.code(400).send({ error: "Compaction threshold must be between 50 and 95 percent" }); const stored = await mutate((config) => { config.compaction_enabled = body.enabled !== false; if (threshold !== undefined) config.compaction_threshold_percent = threshold; return config.compaction_threshold_percent; }); return respondWithReload(nodeSessionService, reply, { ok: true, compaction_enabled: body.enabled !== false, compaction_threshold_percent: threshold ?? stored }); });

  app.get("/api/settings/mcp", async () => { if (mcp) { const result = await mcp.list(); return { servers: result.connectors.filter((item) => item.settings.enabled).map((item) => item.connector_id), configured: result.connectors.map((item) => item.connector_id), config_path: null, deprecated: true }; } const config = await load(); const { definitions, source } = await resolveMcpConfig({ explicitPath: typeof config.mcp_config_path === "string" ? config.mcp_config_path : undefined }); const configured = Object.keys(definitions); const enabled = Array.isArray(config.mcp_servers) ? config.mcp_servers.filter((id) => configured.includes(id)) : configured; return { servers: enabled, configured, config_path: source }; });
  app.put<{ Params: { server_id: string } }>("/api/settings/mcp/:server_id", async (request, reply) => { const on = String((request.query as { enabled?: string }).enabled ?? "true") !== "false"; if (mcp) { const item = (await mcp.list()).connectors.find((connector) => connector.connector_id === request.params.server_id || connector.name === request.params.server_id); if (!item) return reply.code(404).send({ error: "MCP connector not found" }); await mcp.setSettings(item.connector_id, { enabled: on, include_tools: item.settings.include_tools, exclude_tools: item.settings.exclude_tools, approval_mode: item.settings.approval_mode, revision: item.settings.revision }); return { ok: true, server: item.connector_id, enabled: on, deprecated: true }; } await mutate(async (config) => { const { definitions } = await resolveMcpConfig({ explicitPath: typeof config.mcp_config_path === "string" ? config.mcp_config_path : undefined }); const enabled = new Set(Array.isArray(config.mcp_servers) ? config.mcp_servers : Object.keys(definitions)); if (on) enabled.add(request.params.server_id); else enabled.delete(request.params.server_id); config.mcp_servers = [...enabled].sort(); }); return respondWithReload(reply, { ok: true, server: request.params.server_id, enabled: on }); });
  app.get("/api/settings/skills", async (request, reply) => {
    const cwdValue = query(request, "cwd", "");
    const policy = storedSkillPolicy(await load());
    let discovered;
    if (cwdValue) {
      try { discovered = await skillCatalog(await validateWorkspaceCwd(cwdValue)); }
      catch (error) { return reply.code(403).send({ error: String(error) }); }
    } else {
      discovered = await unifiedSkillCatalog();
    }
    const skills = discovered.map((skill) => ({ ...skill, enabled: skillEnabled(policy, skill.name) }));
    return { skills, policy, configured: policy.mode !== "inherit" };
  });
  app.put("/api/settings/skills/toggle", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; enabled?: unknown };
    const name = String(body.name ?? "").trim();
    const discovered = await unifiedSkillCatalog();
    if (!name || !discovered.some((skill) => skill.name === name)) return reply.code(400).send({ ok: false, code: "unknown_runtime_skills", error: `Unknown runtime skill: ${name || "(empty)"}` });
    const current = reconcileSkillPolicy(storedSkillPolicy(await load()), new Set(discovered.map((skill) => skill.name)));
    const policy = toggledSkillPolicy(current, name, body.enabled === true);
    try {
      await nodeSessionService.refreshAllRuntimeSkills();
      await nodeSessionService.setGlobalSkillPolicy(policy);
    }
    catch (error) { return runtimeSkillFailure(reply, error); }
    await mutate((config) => {
      config.skill_policy = policy;
      delete config.skill_policies;
      delete config.skills_configured;
      delete config.skill_paths;
    });
    return { ok: true, policy, configured: policy.mode !== "inherit" };
  });
  app.post("/api/settings/skills/refresh", async (_request, reply) => {
    const discovered = await unifiedSkillCatalog();
    const policy = reconcileSkillPolicy(storedSkillPolicy(await load()), new Set(discovered.map((skill) => skill.name)));
    try {
      await nodeSessionService.refreshAllRuntimeSkills();
      await nodeSessionService.setGlobalSkillPolicy(policy);
    }
    catch (error) { return runtimeSkillFailure(reply, error); }
    await mutate((config) => {
      if (policy.mode === "inherit") {
        delete config.skill_policy;
      } else config.skill_policy = policy;
      delete config.skill_policies;
    });
    return { ok: true, policy, configured: policy.mode !== "inherit" };
  });
  app.delete("/api/settings/skills", async (_request, reply) => {
    const policy: RuntimeSkillPolicy = { mode: "inherit" };
    try {
      await nodeSessionService.refreshAllRuntimeSkills();
      await nodeSessionService.setGlobalSkillPolicy(policy);
    }
    catch (error) { return runtimeSkillFailure(reply, error); }
    await mutate((config) => {
      delete config.skill_policy;
      delete config.skill_policies;
      delete config.skills_configured;
      delete config.skill_paths;
    });
    return { ok: true, policy, configured: false, message: "Skills reset to auto-discover mode" };
  });
  app.post("/api/settings/skills", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = {
      name: String(body.name ?? ""),
      description: String(body.description ?? ""),
      body: typeof body.body === "string" ? body.body : "",
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.license === "string" ? { license: body.license } : {}),
      ...(typeof body.category === "string" ? { category: body.category } : {}),
      ...(Array.isArray(body.requirements) ? { requirements: body.requirements as Array<{ name: string; kind?: string; optional?: boolean; version?: string | null }> } : {}),
    };
    try {
      const skill = await createProjectSkill(cwd, input.name, input);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, skill };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) return reply.code(409).send({ ok: false, error: message });
      if (/not found/i.test(message)) return reply.code(404).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.put<{ Params: { skill_id: string } }>("/api/settings/skills/:skill_id", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = {
      name: request.params.skill_id,
      description: String(body.description ?? ""),
      body: typeof body.body === "string" ? body.body : "",
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.license === "string" ? { license: body.license } : {}),
      ...(typeof body.category === "string" ? { category: body.category } : {}),
      ...(Array.isArray(body.requirements) ? { requirements: body.requirements as Array<{ name: string; kind?: string; optional?: boolean; version?: string | null }> } : {}),
    };
    try {
      const skill = await updateProjectSkill(cwd, request.params.skill_id, input);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, skill };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) return reply.code(404).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.delete<{ Params: { skill_id: string } }>("/api/settings/skills/:skill_id", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    try {
      const result = await deleteProjectSkill(cwd, request.params.skill_id);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) return reply.code(404).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.post("/api/settings/skills/upload/preview", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as { filename?: unknown; content_base64?: unknown };
    const filename = String(body.filename ?? "");
    const content = Buffer.from(String(body.content_base64 ?? ""), "base64");
    if (!filename || content.length === 0) return reply.code(400).send({ ok: false, error: "filename and content_base64 are required" });
    if (content.length > MAX_UPLOAD_BYTES) return reply.code(413).send({ ok: false, error: "Skill upload exceeds the size limit" });
    try {
      const candidates = await previewSkillUpload(filename, content);
      return { ok: true, candidates };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/settings/skills/upload/import", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as { filename?: unknown; content_base64?: unknown; root_path?: unknown };
    const filename = String(body.filename ?? "");
    const content = Buffer.from(String(body.content_base64 ?? ""), "base64");
    const rootPath = String(body.root_path ?? ".");
    if (!filename || content.length === 0) return reply.code(400).send({ ok: false, error: "filename and content_base64 are required" });
    if (content.length > MAX_UPLOAD_BYTES) return reply.code(413).send({ ok: false, error: "Skill upload exceeds the size limit" });
    try {
      const skill = await importSkillBundle(cwd, filename, content, rootPath);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, skill };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) return reply.code(409).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.post("/api/settings/skills/import-github/preview", async (request, reply) => {
    const body = (request.body ?? {}) as { repo?: unknown };
    const repo = String(body.repo ?? "");
    if (!repo) return reply.code(400).send({ ok: false, error: "GitHub repository is required" });
    try {
      const candidates = await previewGithubSkills(repo);
      return { ok: true, candidates };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/settings/skills/import-github/import", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as { repo?: unknown; selected?: unknown };
    const repo = String(body.repo ?? "");
    const selected = Array.isArray(body.selected) ? body.selected.map(String).filter(Boolean) : [];
    if (!repo || selected.length === 0) return reply.code(400).send({ ok: false, error: "repo and selected skills are required" });
    try {
      const result = await importGithubSkills(cwd, repo, selected);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/settings/subagents/discovery", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const agents = new Map<string, DiscoveredSubagent>(
      BUILTIN_SUBAGENTS.map(([name, description]) => [name, { name, description, source: "builtin" }]),
    );
    const directory = join(cwd, ".pi", "agents");
    const visit = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const filePath = join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) continue;
        const parsed = parseProjectSubagent(await readFile(filePath, "utf8").catch(() => ""));
        if (!parsed) continue;
        const name = parsed.packageName ? `${parsed.packageName}.${parsed.name}` : parsed.name;
        if (!SUBAGENT_NAME_PATTERN.test(name)) continue;
        agents.set(name, { name, description: parsed.description, source: "project" });
      }
    };
    try {
      await visit(directory);
    } catch { /* no project agents */ }
    return { agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  });
  app.get("/api/settings/subagents", async (request, reply) => { let cwd: string; try { cwd = await validateWorkspaceCwd(query(request, "cwd")); } catch (error) { return reply.code(403).send({ error: String(error) }); } const { readdir } = await import("node:fs/promises"); const { join, relative } = await import("node:path"); const directory = join(cwd, ".pi", "agents"); const agents: unknown[] = []; try { for (const name of await readdir(directory)) if (name.endsWith(".md")) agents.push({ name: name.slice(0, -3), path: relative(cwd, join(directory, name)).replaceAll("\\", "/") }); } catch { /* no agents */ } return { agents }; });
}

export { endpointId } from "../../config/model-endpoint.js";
