/** Model metadata projection shared by the Settings HTTP adapters. */
import { nativeProviderViews } from "./provider-config-view.js";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";
import { agentModelCatalog } from "../runtime/agent/worker/agent-models.js";
import type { RuntimeCatalog, RuntimeCatalogProvider, RuntimeCatalogModel, RuntimeCatalogService } from "../runtime/agent/runtime-catalog.js";
import type { RuntimeResult } from "../runtime/agent/agent-runtime-types.js";

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
export function normalizeThinkingLevels(value: unknown): string[] | null {
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
 *  otherwise the closest level at-or-above (then at-or-below), then the first
 *  supported level, then `"off"` as the final safe fallback. */
export function clampThinking(requested: string, levels: string[]): string {
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
export async function readModelSnapshot(nodeSessionService: NodeSessionService, cwdValue: string, runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">): Promise<ModelSnapshot> {
  const [catalog, models] = await Promise.all([
    readRuntimeCatalog(runtimeCatalog),
    cwdValue ? nodeSessionService.availableModels(cwdValue) : agentModelCatalog().then((models) => ({ success: true, data: { models } })),
  ]);
  return { catalog, models };
}

export async function modelCatalog(nodeSessionService: NodeSessionService, cwdValue: string, runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">, snapshot?: ModelSnapshot): Promise<{ available: Array<Record<string, unknown>>; source: "pi" | "fallback" }> {
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
export async function providerInventory(nodeSessionService: NodeSessionService, cwdValue: string, runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">, snapshot?: ModelSnapshot): Promise<ProviderInventoryEntry[]> {
  const read = snapshot ?? await readModelSnapshot(nodeSessionService, cwdValue, runtimeCatalog);
  const data = read.models.success ? read.models.data as { models?: Array<{ provider: string; id: string }> } : undefined;
  const available = new Set((data?.models ?? []).map((model) => `${model.provider}/${model.id}`));
  return (await nativeProviderViews()).map((provider) => ({ id: provider.id, name: provider.name,
    models: provider.models.filter((model) => available.has(model.id)).map((model) => model.model_id),
    auth: { kind: provider.auth.kind, api_key_supported: provider.auth.api_key_supported, oauth_supported: false, login_supported: false },
    credential_status: provider.credential.configured ? "configured" : "needs_key", enabled: provider.enabled,
    has_key: provider.credential.configured, custom: provider.source === "user" }));
}
