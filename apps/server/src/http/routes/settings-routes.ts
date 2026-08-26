import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { configPath } from "../../storage/persistence.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { runtimeExtensionStatus } from "../../runtime/pi/pi-runtime-launch.js";
import { validateOutboundHttpUrl } from "../../security/outbound-security.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { SettingsStore, type SettingsData as Settings } from "../../storage/settings-store.js";
import { loadPiAiCatalog } from "../../config/model-catalog-fallback.js";
import { hasEnvApiKey, loadPiAiProviderCatalog } from "../../config/pi-ai-provider-catalog.js";
import { catalog as skillCatalog } from "../../catalog/skill-catalog.js";
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
import type { RuntimeSkillPolicy } from "../../runtime/pi/pi-process.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";
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
const FALLBACK_MODEL_HINTS: Record<string, { contextWindow: number; thinkingLevels: string[] }> = {
  "deepseek/deepseek-v4-pro": { contextWindow: 1_000_000, thinkingLevels: ["off", "high", "max"] },
  "deepseek/deepseek-v4-flash": { contextWindow: 1_000_000, thinkingLevels: ["off", "high", "max"] },
};
async function respondWithRuntimeReload<T extends Record<string, unknown>>(nodeSessionService: NodeSessionService, reply: FastifyReply, payload: T): Promise<(T & { session_replacements: Array<{ cwd: string; oldId: string; newId: string }> }) | FastifyReply> {
  try { return { ...payload, session_replacements: await nodeSessionService.reloadConfiguration() }; }
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
function fallbackModel(provider: string, model: string, label: string, custom: boolean, reasoning: boolean, contextWindow = 128000, thinkingLevels?: string[]): Record<string, unknown> { return { id: `${provider}/${model}`, provider, model, label, custom, reasoning, thinking_levels: reasoning ? (thinkingLevels?.length ? thinkingLevels : FALLBACK_DEFAULT_THINKING_LEVELS) : ["off"], context_window: contextWindow, capability_source: "pi-science fallback" }; }

/** Custom-provider fallback models only. Builtin providers come exclusively
 *  from the pi-ai runtime catalog (Pi Orbit's companion); the static builtin
 *  list was removed so new providers like OpenCode Go appear automatically. */
function customModels(config: Settings): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const provider of config.custom_providers ?? []) for (const model of provider.models) {
    const hint = provider.model_hints?.[model];
    const reasoning = typeof hint?.reasoning === "boolean" ? hint.reasoning : typeof provider.reasoning === "boolean" ? provider.reasoning : /thinking|reasoning|gpt-5|qwen3|deepseek-r1|deepseek-v4/i.test(model);
    const contextWindow = Number(hint?.context_window ?? provider.context_window ?? 128000);
    result.push(fallbackModel(`custom-${provider.id}`, model, `${provider.name} · ${model}`, true, reasoning, contextWindow > 0 ? contextWindow : 128000, hint?.thinking_levels));
  }
  return result;
}

/** Boolean credential presence (stored Pi-Science key or environment key) for
 *  every builtin pi-ai provider. Environment detection delegates to pi-ai's
 *  own env map (shared OPENCODE_API_KEY etc.) and never exposes key values. */
async function providerCredentialMap(config: Settings, modelResources?: ModelResourceService): Promise<Record<string, boolean>> {
  const providers = await loadPiAiProviderCatalog();
  const result: Record<string, boolean> = {};
  const resourceState = modelResources?.repository.readSync();
  for (const provider of providers) {
    const ref = resourceState?.credential_refs[provider.id];
    const managed = ref && modelResources ? Boolean((await modelResources.credentials.getForRuntime(ref))?.secret) : false;
    const stored = typeof config.api_keys?.[provider.id] === "string" && config.api_keys[provider.id] !== "";
    result[provider.id] = managed || stored || await hasEnvApiKey(provider.id);
  }
  return result;
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

/** Set-equality for thinking level lists (order-independent), used to decide
 *  whether a persisted model hint already matches the runtime's actual set. */
function sameLevelList(a: unknown, b: unknown): boolean {
  const left = new Set(Array.isArray(a) ? a.map(String) : []);
  const right = new Set(Array.isArray(b) ? b.map(String) : []);
  return left.size === right.size && [...left].every((level) => right.has(level));
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
  const levelMap = item.thinkingLevelMap && typeof item.thinkingLevelMap === "object" ? item.thinkingLevelMap as Record<string, unknown> : {};
  const hasExplicitLevels = Object.keys(levelMap).length > 0;
  // A runtime entry WITHOUT capability metadata (no reasoning flag, no
  // thinkingLevelMap) must not invent levels or erase the authoritative
  // pi-ai/custom-hint values: leave both fields undefined for the merge to
  // keep the previous entry's values. Only an explicit map produces levels,
  // with xhigh/max included exclusively when explicitly present and non-null.
  const thinkingLevels = reasoning === true
    ? hasExplicitLevels
      ? THINKING_LEVELS.filter((level) => levelMap[level] !== null && (level !== "xhigh" && level !== "max" || Object.hasOwn(levelMap, level)))
      : undefined
    : reasoning === false ? ["off"] : undefined;
  const name = typeof item.name === "string" && item.name ? item.name : model;
  const contextWindow = Number(item.contextWindow ?? 0);
  return { id: `${provider}/${model}`, provider, model, label: `${provider} · ${name}`, custom: provider.startsWith("custom-"), reasoning, thinking_levels: thinkingLevels, context_window: contextWindow > 0 ? contextWindow : null, capability_source: "Pi runtime" };
}
function mergeModelCatalog(primary: Array<Record<string, unknown>>, overlay: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map(primary.map((item) => [String(item.id), item]));
  for (const item of overlay) {
    const previous = byId.get(String(item.id));
    byId.set(String(item.id), {
      ...previous,
      ...item,
      // An overlay entry that omits capability metadata (undefined reasoning
      // / thinking_levels) must never erase the authoritative pi-ai or
      // custom-hint values; an explicit value wins.
      reasoning: item.reasoning ?? previous?.reasoning ?? false,
      // Runtime model listings may omit capability metadata. Never let an
      // incomplete runtime entry erase pi-ai's authoritative value.
      context_window: item.context_window ?? previous?.context_window ?? null,
      thinking_levels: Array.isArray(item.thinking_levels)
        ? item.thinking_levels
        : previous?.thinking_levels ?? item.thinking_levels,
    });
  }
  return [...byId.values()];
}
async function modelCatalog(nodeSessionService: NodeSessionService, config: Settings, cwdValue: string, modelResources?: ModelResourceService): Promise<{ available: Array<Record<string, unknown>>; source: "pi" | "fallback" }> {
  const credential = await providerCredentialMap(config, modelResources);
  if (cwdValue) {
    const result = await nodeSessionService.availableModels(cwdValue);
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    if (result.success && Array.isArray(data.models)) {
      // Pi Orbit is the runtime truth: its listing is authoritative, an empty
      // array stays empty (no pi-ai fallback models are mixed in). Enrich
      // matching runtime entries with pi-ai capability metadata only for
      // credentialed providers; never add models Orbit did not list.
      const runtimeModels = data.models.map(normalizePiModel).filter((item): item is Record<string, unknown> => Boolean(item));
      const runtimeById = new Map(runtimeModels.map((item) => [String(item.id), item]));
      // Gap-fill capability metadata the runtime omitted: pi-ai entries for
      // credentialed builtin providers, and custom config hints. Explicit
      // runtime fields always win; Orbit stays the runtime truth.
      const generated = await loadPiAiCatalog();
      const piEntries = generated
        .filter((item) => credential[String(item.provider)] === true)
        .map(normalizePiModel)
        .filter((item): item is Record<string, unknown> => Boolean(item));
      for (const source of [...piEntries, ...customModels(config)]) {
        const existing = runtimeById.get(String(source.id));
        if (!existing) continue;
        if (existing.reasoning === undefined) existing.reasoning = source.reasoning ?? false;
        if (!Array.isArray(existing.thinking_levels) || existing.thinking_levels.length === 0) existing.thinking_levels = source.thinking_levels;
        if (!existing.context_window) existing.context_window = source.context_window;
      }
      // Custom providers remain available even when Orbit does not list them.
      const customOnly = customModels(config).filter((item) => !runtimeById.has(String(item.id)));
      return { available: [...runtimeById.values(), ...customOnly], source: "pi" };
    }
  }
  // No live Orbit listing: fall back to the pi-ai catalog filtered to
  // credentialed providers, then custom providers. Custom stays available
  // even when the builtin catalog is empty (older installs).
  const generated = await loadPiAiCatalog();
  const piModels = generated
    .filter((item) => credential[String(item.provider)] === true)
    .map(normalizePiModel)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  // Preserve the curated DeepSeek V4 hints (context window + level set) for
  // fallback entries; richer pi-ai metadata already present wins.
  for (const item of piModels) {
    const hint = FALLBACK_MODEL_HINTS[`${String(item.provider)}/${String(item.model)}`];
    if (!hint) continue;
    item.context_window = hint.contextWindow;
    if (!Array.isArray(item.thinking_levels) || item.thinking_levels.length === 0) item.thinking_levels = [...hint.thinkingLevels];
  }
  const custom = customModels(config);
  if (piModels.length > 0) return { available: mergeModelCatalog(piModels, custom), source: "pi" };
  return { available: custom, source: "fallback" };
}

type ProviderInventoryEntry = {
  id: string;
  name: string;
  models: string[];
  auth: { kind: "api_key" | "oauth" | "api_key_or_oauth"; api_key_supported: boolean; oauth_supported: boolean; login_supported: false };
  credential_status: "configured" | "connected" | "needs_key" | "needs_login";
  enabled: boolean;
  has_key: boolean;
};

/** Builtin provider inventory: full pi-ai catalog, Orbit models when a live
 *  runtime lists them (per-provider), pi-ai model ids otherwise. Credential
 *  status distinguishes API-key providers (stored/env key) from OAuth-only
 *  subscription providers (needs_login until the runtime has them). */
async function providerInventory(nodeSessionService: NodeSessionService, config: Settings, cwdValue: string, modelResources?: ModelResourceService): Promise<ProviderInventoryEntry[]> {
  const providers = await loadPiAiProviderCatalog();
  if (providers.length === 0) return [];
  let orbitModels: Record<string, string[]> | null = null;
  if (cwdValue) {
    const result = await nodeSessionService.availableModels(cwdValue);
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    if (result.success && Array.isArray(data.models)) {
      orbitModels = {};
      for (const raw of data.models) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        const provider = typeof entry.provider === "string" ? entry.provider : "";
        const model = typeof entry.id === "string" ? entry.id : "";
        if (provider && model) (orbitModels[provider] ??= []).push(model);
      }
    }
  }
  const entries: ProviderInventoryEntry[] = [];
  for (const provider of providers) {
    const ref = modelResources?.repository.readSync().credential_refs[provider.id];
    const managed = ref && modelResources ? Boolean((await modelResources.credentials.getForRuntime(ref))?.secret) : false;
    const stored = typeof config.api_keys?.[provider.id] === "string" && config.api_keys[provider.id] !== "";
    const env = await hasEnvApiKey(provider.id);
    const hasKey = provider.apiKeySupported && (managed || stored || env);
    let credential_status: ProviderInventoryEntry["credential_status"];
    if (hasKey) credential_status = "configured";
    else if (!provider.apiKeySupported && provider.oauthSupported) credential_status = orbitModels && orbitModels[provider.id] ? "connected" : "needs_login";
    else credential_status = "needs_key";
    entries.push({
      id: provider.id,
      name: provider.name,
      models: orbitModels?.[provider.id] ?? provider.modelIds,
      auth: {
        kind: provider.apiKeySupported && provider.oauthSupported ? "api_key_or_oauth" : provider.oauthSupported ? "oauth" : "api_key",
        api_key_supported: provider.apiKeySupported,
        oauth_supported: provider.oauthSupported,
        login_supported: false,
      },
      credential_status,
      enabled: hasKey || credential_status === "connected",
      has_key: hasKey,
    });
  }
  return entries;
}
function publicCustom(item: NonNullable<Settings["custom_providers"]>[number] & { has_key?: boolean }): Record<string, unknown> { return { id: item.id, name: item.name, base_url: item.base_url, api: item.api, models: item.models, has_key: Boolean(item.api_key) || item.has_key === true, reasoning: item.reasoning, context_window: item.context_window, model_hints: item.model_hints }; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "custom-api"; }
function query(request: { query: unknown }, name: string, fallback = "."): string { const value = (request.query as Record<string, unknown>)[name]; return typeof value === "string" && value ? value : fallback; }
function compactionThreshold(config: Settings, available: Array<Record<string, unknown>>, configured: string): number { if (typeof config.compaction_threshold_percent === "number") return config.compaction_threshold_percent; const contextWindow = Number(available.find((item) => item.id === configured)?.context_window ?? config.model_context_window ?? 0); return contextWindow > 16384 ? Math.min(95, Math.max(50, Math.round((1 - 16384 / contextWindow) * 100))) : 85; }
async function readBoundedJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> { if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("Model discovery response is too large"); if (!response.body) return {}; const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) throw new Error("Model discovery response is too large"); chunks.push(next.value); } } finally { reader.releaseLock(); } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } const text = new TextDecoder().decode(bytes); try { return JSON.parse(text) as Record<string, unknown>; } catch { return text ? { message: text } : {}; } }

type ModelHint = { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string };
type ProviderDiscovery = { safeUrl: URL; models: string[]; modelHints: Record<string, ModelHint> };

const CONTEXT_KEYS = new Set(["max_model_len", "context_window", "context_length", "contextwindow", "max_context_length", "max_position_embeddings"]);
const THINKING_LEVELS_SET = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function authHeaders(apiKey: string, api: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (api === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function positiveContext(value: unknown): number | undefined {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isInteger(parsed) && parsed >= 4096 ? parsed : undefined;
}

function contextFromText(value: string): number | undefined {
  const matches = [
    /(?:context(?:\s+window|\s+length)?|maximum\s+context|max(?:imum)?\s+(?:model\s+)?length)[^\d]{0,48}([\d,]{4,})/i,
    /([\d,]{4,})[^\d]{0,24}(?:token(?:s)?[^.]{0,24})?(?:context(?:\s+window|\s+length)?|maximum)/i,
  ];
  for (const pattern of matches) {
    const found = value.match(pattern);
    const parsed = positiveContext(found?.[1]);
    if (parsed) return parsed;
  }
  return undefined;
}

function capabilitiesFromPayload(value: unknown): Omit<ModelHint, "source"> {
  let contextWindow: number | undefined;
  let reasoning: boolean | undefined;
  let thinkingLevels: string[] | undefined;
  const visit = (current: unknown, depth: number) => {
    if (depth > 6 || current === null || current === undefined) return;
    if (typeof current === "string") {
      contextWindow ??= contextFromText(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current.slice(0, 100)) visit(entry, depth + 1);
      return;
    }
    if (typeof current !== "object") return;
    for (const [rawKey, entry] of Object.entries(current as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (CONTEXT_KEYS.has(key)) contextWindow ??= positiveContext(entry);
      if ((key === "reasoning" || key === "supports_reasoning") && typeof entry === "boolean") reasoning ??= entry;
      if ((key === "reasoning_content" || key === "reasoning_details") && entry != null) reasoning ??= true;
      if (key === "thinking_levels" && Array.isArray(entry)) thinkingLevels ??= entry.map(String).filter((level) => THINKING_LEVELS_SET.has(level));
      if (key === "thinkinglevelmap" && entry && typeof entry === "object") thinkingLevels ??= Object.entries(entry as Record<string, unknown>).filter(([, mapped]) => mapped !== null).map(([level]) => level).filter((level) => THINKING_LEVELS_SET.has(level));
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return {
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    ...(thinkingLevels?.length ? { thinking_levels: [...new Set(thinkingLevels)] } : {}),
  };
}

function mergeHint(base: ModelHint, incoming: ModelHint): ModelHint {
  return {
    ...base,
    ...(base.context_window ? {} : incoming.context_window ? { context_window: incoming.context_window } : {}),
    ...(typeof base.reasoning === "boolean" ? {} : typeof incoming.reasoning === "boolean" ? { reasoning: incoming.reasoning } : {}),
    ...(base.thinking_levels?.length ? {} : incoming.thinking_levels?.length ? { thinking_levels: incoming.thinking_levels } : {}),
    source: base.source && base.source !== "fallback" ? base.source : incoming.source ?? base.source,
  };
}

function usefulHint(hint: ModelHint | undefined): boolean {
  return Boolean(hint?.context_window || typeof hint?.reasoning === "boolean" || hint?.thinking_levels?.length);
}

function completeHint(hint: ModelHint | undefined): boolean {
  return Boolean(hint?.context_window && typeof hint?.reasoning === "boolean");
}

async function fetchCapability(url: string, init: RequestInit, source: string): Promise<ModelHint> {
  try {
    const response = await fetch(url, { ...init, redirect: "error" });
    const payload = await readBoundedJson(response, 2 * 1024 * 1024);
    const hint = capabilitiesFromPayload(payload);
    return usefulHint(hint) ? { ...hint, source } : { source: "fallback" };
  } catch {
    return { source: "fallback" };
  }
}

async function probeModelProtocol(baseUrl: string, model: string, apiKey: string, api: string, signal: AbortSignal): Promise<ModelHint> {
  const headers = { ...authHeaders(apiKey, api), "content-type": "application/json" };
  if (api === "anthropic-messages") {
    return fetchCapability(`${baseUrl}/messages`, { method: "POST", headers, signal, body: JSON.stringify({ model, max_tokens: 1_000_000_000, messages: [{ role: "user", content: "ping" }] }) }, "anthropic-probe");
  }
  if (api === "openai-responses") {
    return fetchCapability(`${baseUrl}/responses`, { method: "POST", headers, signal, body: JSON.stringify({ model, input: "ping", max_output_tokens: 1_000_000_000 }) }, "openai-responses-probe");
  }
  return fetchCapability(`${baseUrl}/chat/completions`, { method: "POST", headers, signal, body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1_000_000_000, stream: false }) }, "openai-chat-probe");
}

async function forEachConcurrent<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await task(item);
    }
  }));
}

async function discoverProvider(baseUrl: string, apiKey: string, api: string, allowPrivate: boolean, timeoutMs: number): Promise<ProviderDiscovery> {
  const safeUrl = await validateOutboundHttpUrl(baseUrl, { allowPrivate });
  const normalizedBase = safeUrl.toString().replace(/\/$/, "");
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${normalizedBase}/models`, { headers: authHeaders(apiKey, api), redirect: "error", signal });
  const payload = await readBoundedJson(response, 2 * 1024 * 1024);
  if (!response.ok) throw new Error(String(payload.error ?? payload.message ?? `Model discovery returned ${response.status}`));
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const rowById = new Map<string, unknown>();
  for (const row of rows) {
    const id = typeof row === "string" ? row : row && typeof row === "object" ? String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).name ?? "") : "";
    if (id && !rowById.has(id)) rowById.set(id, row);
  }
  const models = [...rowById.keys()];
  const piModels = await loadPiAiCatalog();
  const modelHints: Record<string, ModelHint> = {};
  await forEachConcurrent(models, 4, async (model) => {
    const inlineHint = capabilitiesFromPayload(rowById.get(model));
    let hint: ModelHint = usefulHint(inlineHint) ? { ...inlineHint, source: "models" } : { source: "fallback" };
    if (!hint.context_window || typeof hint.reasoning !== "boolean") {
      const detail = await fetchCapability(`${normalizedBase}/models/${encodeURIComponent(model)}`, { headers: authHeaders(apiKey, api), signal }, "model-detail");
      hint = mergeHint(hint, detail);
    }
    if (!hint.context_window || typeof hint.reasoning !== "boolean") hint = mergeHint(hint, await probeModelProtocol(normalizedBase, model, apiKey, api, signal));
    const pi = piModels.find((candidate) => String(candidate.id ?? "") === model);
    if (pi) hint = mergeHint(hint, { ...capabilitiesFromPayload(pi), source: "pi-ai" });
    if (usefulHint(hint)) modelHints[model] = hint;
  });
  return { safeUrl, models, modelHints };
}

export function registerSettingsRoutes(app: FastifyInstance, nodeSessionService: NodeSessionService, settingsStore: SettingsStore, modelResources?: ModelResourceService): void {
  const load = () => settingsStore.read();
  const mutate = <T>(operation: (config: Settings) => T | Promise<T>) => settingsStore.update(operation);
  // Direct API clients may save without calling the discovery endpoint first.
  // Only fill missing per-model hints here; the normal UI carries the richer
  // discovery result into this request and avoids a second network round trip.
  app.addHook("preValidation", async (request) => {
    if (request.method !== "PUT" || !request.url.startsWith("/api/settings/custom-providers/") || request.url.endsWith("/discover")) return;
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : null;
    if (!body?.base_url) return;
    const requestedModels = Array.isArray(body.models) ? body.models.map(String) : [];
    const existingHints = body.model_hints && typeof body.model_hints === "object" ? body.model_hints as Record<string, ModelHint> : {};
    if (requestedModels.length > 0 && requestedModels.every((model) => completeHint(existingHints[model]))) return;
    try {
      const config = await load();
      const discovered = await discoverProvider(String(body.base_url), String(body.api_key ?? ""), String(body.api ?? "openai-completions"), config.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0", 2_000);
      const mergedHints = { ...discovered.modelHints };
      for (const [model, hint] of Object.entries(existingHints)) mergedHints[model] = mergeHint(hint, mergedHints[model] ?? {});
      body.model_hints = mergedHints;
    } catch {
      // Saving explicit user configuration remains available while an endpoint
      // is temporarily offline; provider-level manual defaults still apply.
    }
  });
  function respondWithReload<T extends Record<string, unknown>>(reply: FastifyReply, payload: T): ReturnType<typeof respondWithRuntimeReload<T>>;
  function respondWithReload<T extends Record<string, unknown>>(service: NodeSessionService, reply: FastifyReply, payload: T): ReturnType<typeof respondWithRuntimeReload<T>>;
  function respondWithReload<T extends Record<string, unknown>>(first: NodeSessionService | FastifyReply, second: FastifyReply | T, third?: T) {
    return third
      ? respondWithRuntimeReload(first as NodeSessionService, second as FastifyReply, third)
      : respondWithRuntimeReload(nodeSessionService, first as FastifyReply, second as T);
  }
  app.get("/api/settings/providers", async () => { const config = await load(); return { providers: await providerInventory(nodeSessionService, config, "", modelResources) }; });
  app.get("/api/settings/config", async (request) => {
    const config = await load();
    const cwdValue = query(request, "cwd", "");
    const catalog = await modelCatalog(nodeSessionService, config, cwdValue, modelResources);
    let available = catalog.available;
    const canonicalState = modelResources?.repository.readSync();
    const hasCanonicalResources = Boolean(canonicalState && (canonicalState.migration || canonicalState.providers.length > 0 || canonicalState.models.length > 0));
    if (modelResources && hasCanonicalResources) {
      const resourceModels = await modelResources.listModels();
      const projected = resourceModels
        .filter((item) => item.provider_id.startsWith("user-") && item.available)
        .map((item) => ({
          id: item.id,
          provider: item.provider_id,
          model: item.model_id,
          label: item.display_name,
          custom: true,
          reasoning: item.capabilities.reasoning,
          thinking_levels: item.capabilities.thinking_levels,
          context_window: item.capabilities.context_window,
          capability_source: item.capability_source,
          available: item.available,
          availability_reason: item.availability_reason,
        }));
      available = mergeModelCatalog(available, projected);
    }
    const configured = typeof config.model === "string" && available.some((item) => item.id === config.model) ? config.model : "";
    let thinking = configured ? String(config.thinking ?? "high") : "off";
    let runtimeLevelsApplied = false;
    if (configured && cwdValue) {
      const actual = await nodeSessionService.availableThinkingLevels(cwdValue, configured);
      if (actual.success && actual.data && typeof actual.data === "object") {
        const data = actual.data as Record<string, unknown>;
        const levels = normalizeThinkingLevels(data.levels);
        // Only apply runtime levels when the runtime verified it is running
        // the configured model; a different model's levels must never leak in.
        if (levels && data.model === configured) {
          runtimeLevelsApplied = true;
          const selected = available.find((item) => item.id === configured);
          if (selected) { selected.thinking_levels = levels; selected.reasoning = levels.length > 1 || levels[0] !== "off"; }
          const effective = clampThinking(thinking, levels);
          // Self-heal: persist the corrected level so a later cold read (no
          // live runtime) keeps the same value. Never touch a config whose
          // model changed while this request was in flight; no runtime reload.
          if (effective !== thinking) { thinking = effective; await mutate((current) => { if (String(current.model ?? "") !== configured) return; current.thinking = effective; }); }
        }
      }
    }
    // Self-heal the runtime's authoritative model capabilities into the
    // persisted config: the live catalog's context window for the configured
    // model, and for custom providers the per-model hint. Only a runtime
    // entry may overwrite (capability_source "Pi runtime"); the model identity
    // is re-checked inside the write so a concurrent model change never leaks.
    const selected = available.find((item) => item.id === configured);
    if (configured && selected && selected.capability_source === "Pi runtime") {
      const runtimeContextWindow = Number(selected.context_window ?? 0);
      if (Number.isInteger(runtimeContextWindow) && runtimeContextWindow >= 4096) {
        const provider = String(selected.provider ?? "");
        const modelName = String(selected.model ?? "");
        if (modelResources && provider.startsWith("user-") && modelName) {
          await modelResources.applyRuntimeCapabilities(provider, modelName, {
            ...(Number.isInteger(runtimeContextWindow) && runtimeContextWindow >= 4096 ? { context_window: runtimeContextWindow } : {}),
            ...(runtimeLevelsApplied ? { reasoning: selected.reasoning === true, thinking_levels: Array.isArray(selected.thinking_levels) ? [...selected.thinking_levels] : [] } : {}),
          });
          config.model_context_window = runtimeContextWindow;
        } else {
          const providerId = provider.startsWith("custom-") ? provider.slice("custom-".length) : "";
          const entry = providerId && modelName ? (config.custom_providers ?? []).find((candidate) => candidate.id === providerId) : undefined;
          const storedHint = entry?.model_hints?.[modelName] as Record<string, unknown> | undefined;
          const hintNeedsWrite = Boolean(entry) && (
            storedHint?.context_window !== runtimeContextWindow
            || (runtimeLevelsApplied && (storedHint?.reasoning !== (selected.reasoning === true) || storedHint?.source !== "pi-runtime" || !sameLevelList(storedHint?.thinking_levels, selected.thinking_levels)))
          );
          if (Number(config.model_context_window ?? 0) !== runtimeContextWindow || hintNeedsWrite) {
            await mutate((current) => {
              if (String(current.model ?? "") !== configured) return;
              if (Number(current.model_context_window ?? 0) !== runtimeContextWindow) current.model_context_window = runtimeContextWindow;
              const currentEntry = providerId && modelName ? (current.custom_providers ?? []).find((candidate) => candidate.id === providerId) : undefined;
              if (currentEntry) {
                const hints: Record<string, unknown> = { ...(currentEntry.model_hints?.[modelName] ?? {}) };
                hints.context_window = runtimeContextWindow;
                if (runtimeLevelsApplied) {
                  hints.reasoning = selected.reasoning === true;
                  hints.thinking_levels = Array.isArray(selected.thinking_levels) ? [...selected.thinking_levels] : [];
                  hints.source = "pi-runtime";
                }
                currentEntry.model_hints = { ...(currentEntry.model_hints ?? {}), [modelName]: hints } as NonNullable<Settings["custom_providers"]>[number]["model_hints"];
              }
            });
            config.model_context_window = runtimeContextWindow;
          }
        }
      }
    }
    const providers = await providerInventory(nodeSessionService, config, cwdValue, modelResources);
    const apiKeys = Object.fromEntries(providers.map((provider) => [provider.id, provider.has_key]));
    // Without the pi-ai runtime there is no provider inventory to derive
    // key presence from; surface stored keys so persistence stays observable
    // (headless installs, CI smoke tests).
    if (providers.length === 0 && config.api_keys) {
      for (const [id, key] of Object.entries(config.api_keys)) if (typeof key === "string" && key) apiKeys[id] = true;
    }
    if (modelResources) {
      const resourceState = modelResources.repository.readSync();
      for (const [id, ref] of Object.entries(resourceState.credential_refs)) if (modelResources.credentials.readSync(ref)?.secret) apiKeys[id] = true;
    }
    return { api_keys: apiKeys, model: configured, thinking, model_context_window: config.model_context_window ?? null, compaction_enabled: config.compaction_enabled !== false, compaction_threshold_percent: compactionThreshold(config, available, configured), allow_private_providers: config.allow_private_providers !== false, providers, custom_providers: (config.custom_providers ?? []).map(publicCustom), available_models: available, model_catalog_source: catalog.source };
  });
  app.put("/api/settings/private-providers", async (request, reply) => { const body = (request.body ?? {}) as { enabled?: unknown }; const enabled = body.enabled !== false; await mutate((config) => { config.allow_private_providers = enabled; }); return respondWithReload(nodeSessionService, reply, { ok: true, allow_private_providers: enabled }); });
  app.put("/api/settings/api-key", async (request, reply) => { const body = (request.body ?? {}) as { provider?: unknown; api_key?: unknown }; const provider = String(body.provider ?? ""); const apiKey = String(body.api_key ?? ""); const catalog = await loadPiAiProviderCatalog(); // Without the pi-ai runtime installed there is no catalog to validate
    // against; accept the key (it stays inert until a runtime exists) so
    // smoke tests and headless installs can still persist settings.
    if (catalog.length > 0) { const entry = catalog.find((candidate) => candidate.id === provider); if (!entry) return reply.code(400).send({ error: `Unknown provider: ${provider}` }); if (!entry.apiKeySupported) return reply.code(400).send({ code: "provider_requires_login", error: `${provider} uses subscription login instead of an API key` }); }
    if (modelResources) {
      await modelResources.ensureMigrated();
      const credentialId = `cred_system_${provider.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
      await modelResources.credentials.putRaw(credentialId, { kind: "api_key", backend: "managed", label: `${provider} API key` }, apiKey);
      await modelResources.repository.update((state) => { state.credential_refs[provider] = credentialId; });
    } else await mutate((config) => { config.api_keys = { ...(config.api_keys ?? {}), [provider]: apiKey }; });
    return respondWithReload(nodeSessionService, reply, { ok: true, provider }); });
  app.delete<{ Params: { provider: string } }>("/api/settings/api-key/:provider", async (request, reply) => {
    if (modelResources) {
      await modelResources.ensureMigrated();
      const state = await modelResources.repository.read();
      const ref = state.credential_refs[request.params.provider];
      if (ref) await modelResources.credentials.remove(ref);
      await modelResources.repository.update((current) => { delete current.credential_refs[request.params.provider]; });
      await mutate((config) => { if (String(config.model ?? "").startsWith(`${request.params.provider}/`)) config.model = ""; });
    } else await mutate((config) => { if (config.api_keys) delete config.api_keys[request.params.provider]; if (String(config.model ?? "").startsWith(`${request.params.provider}/`)) config.model = ""; });
    return respondWithReload(nodeSessionService, reply, { ok: true, provider: request.params.provider }); });
  app.put("/api/settings/model", async (request, reply) => { const body = (request.body ?? {}) as { model?: unknown; thinking?: unknown }; const model = String(body.model ?? ""); const requestedThinking = String(body.thinking ?? "high"); const cwdValue = query(request, "cwd", ""); const current = await load(); const canonicalState = modelResources?.repository.readSync(); const useCanonicalResources = Boolean(modelResources && (canonicalState?.migration || canonicalState?.providers?.length || canonicalState?.models?.length));
    if (useCanonicalResources && modelResources) {
      const canonicalModel = canonicalState?.aliases[model] ?? model;
      const selected = (await modelResources.listModels({ available: true })).find((item) => item.id === canonicalModel);
      if (model && !selected) return reply.code(422).send({ code: "no_routable_endpoint", error: "Model is not available from a configured provider" });
      let levels = normalizeThinkingLevels(selected?.capabilities.thinking_levels);
      let runtimeLevelsVerified = false;
      if (cwdValue && canonicalModel) {
        const actual = await nodeSessionService.availableThinkingLevels(cwdValue, canonicalModel).catch(() => null);
        if (actual?.success && actual.data && typeof actual.data === "object") {
          const data = actual.data as Record<string, unknown>;
          const runtimeLevels = normalizeThinkingLevels(data.levels);
          if (runtimeLevels && data.model === canonicalModel) {
            levels = runtimeLevels;
            runtimeLevelsVerified = true;
          }
        }
      }
      const thinking = clampThinking(requestedThinking, levels ?? ["off"]);
      await mutate((config) => { config.model = canonicalModel; config.thinking = thinking; const contextWindow = Number(selected?.capabilities.context_window ?? 0); if (contextWindow > 0) config.model_context_window = contextWindow; });
      if (runtimeLevelsVerified && canonicalModel.startsWith("user-") && selected) {
        const separator = canonicalModel.indexOf("/");
        if (separator > 0) await modelResources.applyRuntimeCapabilities(canonicalModel.slice(0, separator), canonicalModel.slice(separator + 1), { reasoning: selected.capabilities.reasoning, thinking_levels: levels ?? selected.capabilities.thinking_levels });
      }
      const reloaded = await respondWithRuntimeReload(nodeSessionService, reply, { ok: true, model: canonicalModel, thinking });
      if ("send" in reloaded) return reloaded;
      if (cwdValue && canonicalModel) {
        const actual = await nodeSessionService.availableThinkingLevels(cwdValue, canonicalModel).catch(() => null);
        if (actual?.success && actual.data && typeof actual.data === "object") {
          const data = actual.data as Record<string, unknown>;
          const runtimeLevels = normalizeThinkingLevels(data.levels);
          if (runtimeLevels && data.model === canonicalModel) {
            if (canonicalModel.startsWith("user-") && selected) {
              const separator = canonicalModel.indexOf("/");
              if (separator > 0) await modelResources.applyRuntimeCapabilities(canonicalModel.slice(0, separator), canonicalModel.slice(separator + 1), { reasoning: selected.capabilities.reasoning, thinking_levels: runtimeLevels });
            }
            const effective = clampThinking(requestedThinking, runtimeLevels);
            if (effective !== thinking) {
              await mutate((config) => { if (String(config.model ?? "") === canonicalModel) config.thinking = effective; });
              reloaded.thinking = effective;
            }
          }
        }
      }
      return reloaded;
    }
    const catalog = await modelCatalog(nodeSessionService, current, cwdValue, modelResources); const selected = catalog.available.find((item) => item.id === model); if (model && !selected) return reply.code(400).send({ error: "Model is not available from a configured provider" }); // Never persist a thinking level the model does not support. Clamp to the
    // catalog levels for the selected model; when the levels are unknown,
    // fall back to "off" instead of inventing a level.
    const levels = normalizeThinkingLevels(selected?.thinking_levels);
    const thinking = clampThinking(requestedThinking, levels ?? ["off"]);
    await mutate((config) => { config.model = model; config.thinking = thinking; const contextWindow = Number(selected?.context_window ?? 0); if (contextWindow > 0) config.model_context_window = contextWindow; });
    // Reload the Pi runtime so the new model/thinking take effect, keeping the
    // existing 502 + session_replacements semantics.
    const reloaded = await respondWithRuntimeReload(nodeSessionService, reply, { ok: true, model, thinking });
    if ("send" in reloaded) return reloaded;
    // The runtime is the final authority for the active model: once it has
    // reloaded with the new model, correct the persisted level to the
    // runtime's actual supported set (identity must match). Never reload a
    // second time; the runtime already adopted the level it supports.
    if (cwdValue && model) {
      const actual = await nodeSessionService.availableThinkingLevels(cwdValue, model).catch(() => null);
      if (actual && actual.success && actual.data && typeof actual.data === "object") {
        const data = actual.data as Record<string, unknown>;
        const actualLevels = normalizeThinkingLevels(data.levels);
        if (actualLevels && data.model === model) {
          const effective = clampThinking(requestedThinking, actualLevels);
          if (effective !== thinking) {
            await mutate((config) => { if (String(config.model ?? "") !== model) return; config.thinking = effective; });
            reloaded.thinking = effective;
          }
        }
      }
    }
    return reloaded; });
  app.put("/api/settings/compaction", async (request, reply) => { const body = (request.body ?? {}) as { enabled?: unknown; threshold_percent?: unknown }; const threshold = body.threshold_percent === undefined ? undefined : Number(body.threshold_percent); if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 50 || threshold > 95)) return reply.code(400).send({ error: "Compaction threshold must be between 50 and 95 percent" }); const stored = await mutate((config) => { config.compaction_enabled = body.enabled !== false; if (threshold !== undefined) config.compaction_threshold_percent = threshold; return config.compaction_threshold_percent; }); return respondWithReload(nodeSessionService, reply, { ok: true, compaction_enabled: body.enabled !== false, compaction_threshold_percent: threshold ?? stored }); });
  app.get("/api/settings/custom-providers", async () => {
    const config = await load();
    const legacy = [...(config.custom_providers ?? [])];
    if (modelResources) {
      await modelResources.ensureMigrated();
      const state = await modelResources.repository.read();
      const existingIds = new Set(legacy.map((item) => item.id));
      for (const provider of state.providers.filter((item) => item.kind === "user")) {
        const legacyId = provider.id.startsWith("user-") ? provider.id.slice("user-".length) : provider.id;
        if (existingIds.has(legacyId)) continue;
        const binding = state.bindings.filter((item) => item.provider_id === provider.id && item.enabled).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
        const endpoint = binding ? state.endpoints.find((item) => item.id === binding.endpoint_id) : undefined;
        const models = state.models.filter((item) => item.provider_id === provider.id);
        const key = endpoint?.credential_ref ? await modelResources.credentials.getForRuntime(endpoint.credential_ref) : null;
        legacy.push({
          id: legacyId,
          name: provider.name,
          base_url: endpoint?.base_url ?? "",
          api: endpoint?.api ?? (endpoint?.protocol === "anthropic" ? "anthropic-messages" : endpoint?.protocol === "ollama" ? "ollama" : "openai-completions"),
          models: models.map((item) => item.model_id),
          has_key: Boolean(key?.secret),
          model_hints: Object.fromEntries(models.map((item) => [item.model_id, { ...item.capabilities, source: item.capability_source }])),
        } as NonNullable<Settings["custom_providers"]>[number] & { has_key?: boolean });
      }
    }
    return { providers: legacy.map(publicCustom) };
  });
  app.post("/api/settings/custom-providers/discover", async (request, reply) => { const body = (request.body ?? {}) as Record<string, unknown>; const baseUrl = String(body.base_url ?? "").replace(/\/$/, ""); const api = String(body.api ?? "openai-completions"); let discovered: ProviderDiscovery; try { const config = await load(); discovered = await discoverProvider(baseUrl, String(body.api_key ?? ""), api, config.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0", 10_000); } catch (error) { const message = error instanceof Error ? error.message : String(error); const secret = String(body.api_key ?? ""); const safeMessage = secret ? message.replaceAll(secret, "[redacted]") : message; const status = /private|reserved|invalid|absolute/i.test(message) ? 400 : 502; return reply.code(status).send({ error: `Model discovery failed: ${safeMessage}` }); } if (!discovered.models.length) return reply.code(422).send({ error: "No models were returned by this provider" }); const id = slug(String(body.name ?? discovered.safeUrl.hostname)); return { provider: { id, name: String(body.name ?? "Custom API"), base_url: baseUrl, api, models: discovered.models, model_hints: discovered.modelHints } }; });
  app.put<{ Params: { provider_id: string } }>("/api/settings/custom-providers/:provider_id", async (request, reply) => { const body = (request.body ?? {}) as Record<string, unknown>; const baseUrl = String(body.base_url ?? "").replace(/\/$/, ""); if (!/^https?:\/\//.test(baseUrl)) return reply.code(400).send({ error: "base_url must be an absolute http(s) URL" }); const modelList = Array.isArray(body.models) ? [...new Set(body.models.map(String).map((item) => item.trim()).filter(Boolean))] : []; if (!modelList.length) return reply.code(400).send({ error: "At least one model is required" }); const contextWindow = Number(body.context_window ?? 128000); if (!Number.isInteger(contextWindow) || contextWindow < 4096) return reply.code(400).send({ error: "context_window must be at least 4096 tokens" }); const requestedId = request.params.provider_id; const id = slug(requestedId); const currentConfig = await load(); const old = currentConfig.custom_providers?.find((item) => item.id === id); if (old && requestedId !== old.id) return reply.code(409).send({ error: `Provider ID '${requestedId}' conflicts with existing provider '${id}'` });
    if (modelResources) {
      const result = await modelResources.upsertLegacyProvider({ id, name: String(body.name ?? "Custom API"), base_url: baseUrl, api: String(body.api ?? "openai-completions"), models: modelList, ...(String(body.api_key ?? "") ? { api_key: String(body.api_key) } : {}), ...(typeof body.reasoning === "boolean" ? { reasoning: body.reasoning } : {}), context_window: contextWindow, ...(body.model_hints && typeof body.model_hints === "object" ? { model_hints: body.model_hints as Record<string, { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string }> } : {}) });
      const compatibility = { id, name: result.provider.name, base_url: result.endpoint.base_url, api: String(body.api ?? "openai-completions"), models: modelList, reasoning: typeof body.reasoning === "boolean" ? body.reasoning : undefined, context_window: contextWindow, model_hints: body.model_hints && typeof body.model_hints === "object" ? body.model_hints as NonNullable<Settings["custom_providers"]>[number]["model_hints"] : old?.model_hints };
      await mutate((config) => { config.custom_providers = [...(config.custom_providers ?? []).filter((item) => item.id !== id), compatibility]; });
      return respondWithReload(reply, { ok: true, provider: publicCustom(compatibility) });
    }
    const result = await mutate((config) => { const requestedKey = String(body.api_key ?? ""); const next = { id, name: String(body.name ?? "Custom API"), base_url: baseUrl, api: String(body.api ?? "openai-completions"), models: modelList, api_key: requestedKey || old?.api_key || "", reasoning: typeof body.reasoning === "boolean" ? body.reasoning : old?.reasoning, context_window: contextWindow, model_hints: body.model_hints && typeof body.model_hints === "object" ? body.model_hints as NonNullable<Settings["custom_providers"]>[number]["model_hints"] : old?.model_hints }; config.custom_providers = [...(config.custom_providers ?? []).filter((item) => item.id !== id), next]; return next; }); return respondWithReload(reply, { ok: true, provider: publicCustom(result) }); });
  app.delete<{ Params: { provider_id: string } }>("/api/settings/custom-providers/:provider_id", async (request, reply) => { const id = slug(request.params.provider_id); if (modelResources) { await modelResources.deleteProvider(`user-${id}`, true).catch((error) => { if (!(error instanceof Error) || !String(error.message).includes("was not found")) throw error; }); } await mutate((config) => { config.custom_providers = (config.custom_providers ?? []).filter((item) => item.id !== id); if (String(config.model ?? "").startsWith(`custom-${id}/`) || String(config.model ?? "").startsWith(`user-${id}/`)) config.model = ""; }); return respondWithReload(reply, { ok: true, id }); });
  app.get("/api/settings/web-access", async () => { const config = await load(); const web = config.web_access ?? {}; const stored = typeof web.api_keys === "object" && web.api_keys ? web.api_keys as Record<string, string> : {}; return { provider: typeof web.provider === "string" ? web.provider : "auto", workflow: typeof web.workflow === "string" ? web.workflow : "none", providers: Object.entries({ openai: "OPENAI_API_KEY", exa: "EXA_API_KEY", brave: "BRAVE_API_KEY", parallel: "PARALLEL_API_KEY", tavily: "TAVILY_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY" }).map(([id, env]) => ({ id, has_key: Boolean(stored[id] || process.env[env]), key_source: stored[id] ? "web-access" : process.env[env] ? "environment" : null, env })) }; });
  app.put("/api/settings/web-access", async (request, reply) => { const body = (request.body ?? {}) as { provider?: unknown; workflow?: unknown; api_keys?: unknown; remove_keys?: unknown }; const supported = ["openai", "exa", "brave", "parallel", "tavily", "perplexity", "gemini"]; if (body.api_keys && typeof body.api_keys === "object") for (const key of Object.keys(body.api_keys as Record<string, unknown>)) if (!supported.includes(key)) return reply.code(400).send({ error: `Unknown web search provider: ${key}` }); await mutate((config) => { const web = config.web_access ?? {}; web.provider = String(body.provider ?? "auto"); web.workflow = String(body.workflow ?? "none"); const stored = typeof web.api_keys === "object" && web.api_keys ? web.api_keys as Record<string, string> : {}; if (body.api_keys && typeof body.api_keys === "object") for (const [key, value] of Object.entries(body.api_keys as Record<string, unknown>)) if (String(value).trim()) stored[key] = String(value).trim(); if (Array.isArray(body.remove_keys)) for (const key of body.remove_keys.map(String)) delete stored[key]; web.api_keys = stored; config.web_access = web; }); const response = await app.inject({ method: "GET", url: "/api/settings/web-access" }); return respondWithReload(reply, { ok: true, ...(response.json() as Record<string, unknown>) }); });
  app.get("/api/settings/mcp", async () => { const config = await load(); const source = typeof config.mcp_config_path === "string" ? config.mcp_config_path : configPath("mcp.json"); let definitions: Record<string, unknown> = {}; try { const payload = JSON.parse(await readFile(source, "utf8")) as { mcpServers?: unknown }; definitions = payload.mcpServers && typeof payload.mcpServers === "object" ? payload.mcpServers as Record<string, unknown> : {}; } catch { /* empty catalog */ } const configured = Object.keys(definitions); const enabled = Array.isArray(config.mcp_servers) ? config.mcp_servers.filter((id) => configured.includes(id)) : configured; return { servers: enabled, configured, config_path: source }; });
  app.put<{ Params: { server_id: string } }>("/api/settings/mcp/:server_id", async (request, reply) => { const on = String((request.query as { enabled?: string }).enabled ?? "true") !== "false"; await mutate((config) => { const enabled = new Set(Array.isArray(config.mcp_servers) ? config.mcp_servers : []); if (on) enabled.add(request.params.server_id); else enabled.delete(request.params.server_id); config.mcp_servers = [...enabled].sort(); }); return respondWithReload(reply, { ok: true, server: request.params.server_id, enabled: on }); });
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
  app.get("/api/settings/extensions", async () => ({ extensions: runtimeExtensionStatus() }));
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
