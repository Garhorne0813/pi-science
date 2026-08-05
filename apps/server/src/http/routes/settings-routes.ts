import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { configPath } from "../../storage/persistence.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { runtimeExtensionStatus } from "../../runtime/pi/pi-runtime-launch.js";
import { validateOutboundHttpUrl } from "../../security/outbound-security.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { SettingsStore, type SettingsData as Settings } from "../../storage/settings-store.js";
import { loadPiAiCatalog } from "../../config/model-catalog-fallback.js";

const PROVIDER_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY", xai: "XAI_API_KEY", zai: "ZAI_API_KEY", fireworks: "FIREWORKS_API_KEY", together: "TOGETHER_API_KEY" };
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
const PROVIDERS = [
  ["anthropic", "Anthropic", ["claude-opus-4-5", "claude-sonnet-4-20250514"]], ["openai", "OpenAI", ["gpt-5.1", "gpt-5.1-codex", "gpt-4o"]], ["google", "Gemini", ["gemini-2.5-pro", "gemini-2.5-flash"]], ["deepseek", "DeepSeek", ["deepseek-v4-pro", "deepseek-v4-flash"]], ["groq", "Groq", ["llama-3.3-70b-versatile"]], ["openrouter", "OpenRouter", ["openai/gpt-5.1", "anthropic/claude-sonnet-5"]], ["mistral", "Mistral", ["devstral-latest"]], ["xai", "xAI", ["grok-4.3"]], ["zai", "Z.AI", ["glm-4.7"]],
] as const;
const FALLBACK_MODEL_HINTS: Record<string, { contextWindow: number; thinkingLevels: string[] }> = {
  "deepseek/deepseek-v4-pro": { contextWindow: 1_000_000, thinkingLevels: ["off", "high", "max"] },
  "deepseek/deepseek-v4-flash": { contextWindow: 1_000_000, thinkingLevels: ["off", "high", "max"] },
};
async function respondWithRuntimeReload<T extends Record<string, unknown>>(nodeSessionService: NodeSessionService, reply: FastifyReply, payload: T): Promise<(T & { session_replacements: Array<{ cwd: string; oldId: string; newId: string }> }) | FastifyReply> {
  try { return { ...payload, session_replacements: await nodeSessionService.reloadConfiguration() }; }
  catch (error) { return reply.code(502).send({ ok: false, error: `Settings were saved, but Pi runtime reload failed: ${String(error)}` }); }
}
function active(config: Settings): Record<string, boolean> { return Object.fromEntries(Object.keys(PROVIDER_ENV).map((id) => [id, Boolean(config.api_keys?.[id] || process.env[PROVIDER_ENV[id]!] || (id === "openai" && process.env.OPENAI_API_KEY))])); }
function fallbackModel(provider: string, model: string, label: string, custom: boolean, reasoning: boolean, contextWindow = 128000, thinkingLevels?: string[]): Record<string, unknown> { return { id: `${provider}/${model}`, provider, model, label, custom, reasoning, thinking_levels: reasoning ? (thinkingLevels?.length ? thinkingLevels : ["off", "minimal", "low", "medium", "high", "xhigh"]) : ["off"], context_window: contextWindow, capability_source: "pi-science fallback" }; }
function models(config: Settings): Array<Record<string, unknown>> { const result: Array<Record<string, unknown>> = []; for (const [id, name, entries] of PROVIDERS) if (active(config)[id]) for (const model of entries) { const reasoning = /gpt-5|thinking|reasoning|claude-(opus|sonnet)-4|gemini-2.5|deepseek-v4/.test(model); const hint = FALLBACK_MODEL_HINTS[`${id}/${model}`]; result.push(fallbackModel(id, model, `${name} · ${model}`, false, reasoning, hint?.contextWindow, hint?.thinkingLevels)); } for (const provider of config.custom_providers ?? []) for (const model of provider.models) { const hint = provider.model_hints?.[model]; const reasoning = typeof hint?.reasoning === "boolean" ? hint.reasoning : typeof provider.reasoning === "boolean" ? provider.reasoning : /thinking|reasoning|gpt-5|qwen3|deepseek-r1|deepseek-v4/i.test(model); const contextWindow = Number(hint?.context_window ?? provider.context_window ?? 128000); result.push(fallbackModel(`custom-${provider.id}`, model, `${provider.name} · ${model}`, true, reasoning, contextWindow > 0 ? contextWindow : 128000, hint?.thinking_levels)); } return result; }
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
function normalizePiModel(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const provider = typeof item.provider === "string" ? item.provider : "";
  const model = typeof item.id === "string" ? item.id : "";
  if (!provider || !model) return null;
  const reasoning = item.reasoning === true;
  const levelMap = item.thinkingLevelMap && typeof item.thinkingLevelMap === "object" ? item.thinkingLevelMap as Record<string, unknown> : {};
  const thinkingLevels = reasoning
    ? THINKING_LEVELS.filter((level) => levelMap[level] !== null && (level !== "xhigh" && level !== "max" || Object.hasOwn(levelMap, level)))
    : ["off"];
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
      // Runtime model listings may omit capability metadata. Never let an
      // incomplete runtime entry erase pi-ai's authoritative value.
      context_window: item.context_window ?? previous?.context_window ?? null,
      thinking_levels: Array.isArray(item.thinking_levels) && item.thinking_levels.length > 1
        ? item.thinking_levels
        : previous?.thinking_levels ?? item.thinking_levels,
    });
  }
  return [...byId.values()];
}
async function modelCatalog(nodeSessionService: NodeSessionService, config: Settings, cwdValue: string): Promise<{ available: Array<Record<string, unknown>>; source: "pi" | "fallback" }> {
  if (cwdValue) {
    const result = await nodeSessionService.availableModels(cwdValue);
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    if (result.success && Array.isArray(data.models)) {
      const runtimeModels = data.models.map(normalizePiModel).filter((item): item is Record<string, unknown> => Boolean(item));
      // The running Pi process may expose model IDs without capability
      // metadata. Fill those fields from pi-ai, while letting runtime data
      // override matching entries.
      const generated = await loadPiAiCatalog();
      const enabled = active(config);
      const piModels = generated
        .filter((item) => enabled[String(item.provider)])
        .map(normalizePiModel)
        .filter((item): item is Record<string, unknown> => Boolean(item));
      const customModels = models(config).filter((item) => item.custom === true);
      return { available: mergeModelCatalog([...piModels, ...customModels], runtimeModels), source: "pi" };
    }
  }
  const generated = await loadPiAiCatalog();
  if (generated.length > 0) {
    const enabled = active(config);
    const catalog = generated
      .filter((item) => enabled[String(item.provider)] || String(item.provider).startsWith("custom-"))
      .map(normalizePiModel)
      .filter((item): item is Record<string, unknown> => Boolean(item));
    const customModels = models(config).filter((item) => item.custom === true);
    if (catalog.length > 0) return { available: mergeModelCatalog(catalog, customModels), source: "pi" };
  }
  return { available: models(config), source: "fallback" };
}
function publicCustom(item: NonNullable<Settings["custom_providers"]>[number]): Record<string, unknown> { return { id: item.id, name: item.name, base_url: item.base_url, api: item.api, models: item.models, has_key: Boolean(item.api_key), reasoning: item.reasoning, context_window: item.context_window, model_hints: item.model_hints }; }
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

export function registerSettingsRoutes(app: FastifyInstance, nodeSessionService: NodeSessionService, settingsStore: SettingsStore): void {
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
  app.get("/api/settings/providers", async () => { const config = await load(); return { providers: PROVIDERS.map(([id, name, modelList]) => ({ id, name, models: modelList, has_key: active(config)[id] })) }; });
  app.get("/api/settings/config", async (request) => { const config = await load(); const catalog = await modelCatalog(nodeSessionService, config, query(request, "cwd", "")); const available = catalog.available; const configured = typeof config.model === "string" && available.some((item) => item.id === config.model) ? config.model : ""; return { api_keys: active(config), model: configured, thinking: configured ? String(config.thinking ?? "high") : "off", model_context_window: config.model_context_window ?? null, compaction_enabled: config.compaction_enabled !== false, compaction_threshold_percent: compactionThreshold(config, available, configured), allow_private_providers: config.allow_private_providers !== false, providers: PROVIDERS.map(([id, name, modelList]) => ({ id, name, models: catalog.source === "pi" && active(config)[id] ? available.filter((item) => item.provider === id).map((item) => String(item.model)) : modelList, has_key: active(config)[id] })), custom_providers: (config.custom_providers ?? []).map(publicCustom), available_models: available, model_catalog_source: catalog.source }; });
  app.put("/api/settings/private-providers", async (request, reply) => { const body = (request.body ?? {}) as { enabled?: unknown }; const enabled = body.enabled !== false; await mutate((config) => { config.allow_private_providers = enabled; }); return respondWithReload(nodeSessionService, reply, { ok: true, allow_private_providers: enabled }); });
  app.put("/api/settings/api-key", async (request, reply) => { const body = (request.body ?? {}) as { provider?: unknown; api_key?: unknown }; const provider = String(body.provider ?? ""); if (!PROVIDER_ENV[provider]) return reply.code(400).send({ error: `Unknown provider: ${provider}` }); await mutate((config) => { config.api_keys = { ...(config.api_keys ?? {}), [provider]: String(body.api_key ?? "") }; }); return respondWithReload(nodeSessionService, reply, { ok: true, provider }); });
  app.delete<{ Params: { provider: string } }>("/api/settings/api-key/:provider", async (request, reply) => { await mutate((config) => { if (config.api_keys) delete config.api_keys[request.params.provider]; if (String(config.model ?? "").startsWith(`${request.params.provider}/`)) config.model = ""; }); return respondWithReload(nodeSessionService, reply, { ok: true, provider: request.params.provider }); });
  app.put("/api/settings/model", async (request, reply) => { const body = (request.body ?? {}) as { model?: unknown; thinking?: unknown }; const model = String(body.model ?? ""); const thinking = String(body.thinking ?? "high"); const current = await load(); const catalog = await modelCatalog(nodeSessionService, current, query(request, "cwd", "")); const selected = catalog.available.find((item) => item.id === model); if (model && !selected) return reply.code(400).send({ error: "Model is not available from a configured provider" }); await mutate((config) => { config.model = model; config.thinking = thinking; const contextWindow = Number(selected?.context_window ?? 0); if (contextWindow > 0) config.model_context_window = contextWindow; }); return respondWithReload(nodeSessionService, reply, { ok: true, model, thinking }); });
  app.put("/api/settings/compaction", async (request, reply) => { const body = (request.body ?? {}) as { enabled?: unknown; threshold_percent?: unknown }; const threshold = body.threshold_percent === undefined ? undefined : Number(body.threshold_percent); if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 50 || threshold > 95)) return reply.code(400).send({ error: "Compaction threshold must be between 50 and 95 percent" }); const stored = await mutate((config) => { config.compaction_enabled = body.enabled !== false; if (threshold !== undefined) config.compaction_threshold_percent = threshold; return config.compaction_threshold_percent; }); return respondWithReload(nodeSessionService, reply, { ok: true, compaction_enabled: body.enabled !== false, compaction_threshold_percent: threshold ?? stored }); });
  app.get("/api/settings/custom-providers", async () => ({ providers: (await load()).custom_providers?.map(publicCustom) ?? [] }));
  app.post("/api/settings/custom-providers/discover", async (request, reply) => { const body = (request.body ?? {}) as Record<string, unknown>; const baseUrl = String(body.base_url ?? "").replace(/\/$/, ""); const api = String(body.api ?? "openai-completions"); let discovered: ProviderDiscovery; try { const config = await load(); discovered = await discoverProvider(baseUrl, String(body.api_key ?? ""), api, config.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0", 10_000); } catch (error) { const message = error instanceof Error ? error.message : String(error); const status = /private|reserved|invalid|absolute/i.test(message) ? 400 : 502; return reply.code(status).send({ error: `Model discovery failed: ${message}` }); } if (!discovered.models.length) return reply.code(422).send({ error: "No models were returned by this provider" }); const id = slug(String(body.name ?? discovered.safeUrl.hostname)); return { provider: { id, name: String(body.name ?? "Custom API"), base_url: baseUrl, api, models: discovered.models, model_hints: discovered.modelHints } }; });
  app.put<{ Params: { provider_id: string } }>("/api/settings/custom-providers/:provider_id", async (request, reply) => { const body = (request.body ?? {}) as Record<string, unknown>; const baseUrl = String(body.base_url ?? "").replace(/\/$/, ""); if (!/^https?:\/\//.test(baseUrl)) return reply.code(400).send({ error: "base_url must be an absolute http(s) URL" }); const modelList = Array.isArray(body.models) ? [...new Set(body.models.map(String).map((item) => item.trim()).filter(Boolean))] : []; if (!modelList.length) return reply.code(400).send({ error: "At least one model is required" }); const contextWindow = Number(body.context_window ?? 128000); if (!Number.isInteger(contextWindow) || contextWindow < 4096) return reply.code(400).send({ error: "context_window must be at least 4096 tokens" }); const requestedId = request.params.provider_id; const id = slug(requestedId); const result = await mutate((config) => { const old = config.custom_providers?.find((item) => item.id === id); if (old && requestedId !== old.id) return { conflict: true as const }; const requestedKey = String(body.api_key ?? ""); const next = { id, name: String(body.name ?? "Custom API"), base_url: baseUrl, api: String(body.api ?? "openai-completions"), models: modelList, api_key: requestedKey || old?.api_key || "", reasoning: typeof body.reasoning === "boolean" ? body.reasoning : old?.reasoning, context_window: contextWindow, model_hints: body.model_hints && typeof body.model_hints === "object" ? body.model_hints as NonNullable<Settings["custom_providers"]>[number]["model_hints"] : old?.model_hints }; config.custom_providers = [...(config.custom_providers ?? []).filter((item) => item.id !== id), next]; return { conflict: false as const, provider: next }; }); if (result.conflict) return reply.code(409).send({ error: `Provider ID '${requestedId}' conflicts with existing provider '${id}'` }); return respondWithReload(reply, { ok: true, provider: publicCustom(result.provider) }); });
  app.delete<{ Params: { provider_id: string } }>("/api/settings/custom-providers/:provider_id", async (request, reply) => { const id = slug(request.params.provider_id); await mutate((config) => { config.custom_providers = (config.custom_providers ?? []).filter((item) => item.id !== id); if (String(config.model ?? "").startsWith(`custom-${id}/`)) config.model = ""; }); return respondWithReload(reply, { ok: true, id }); });
  app.get("/api/settings/web-access", async () => { const config = await load(); const web = config.web_access ?? {}; const stored = typeof web.api_keys === "object" && web.api_keys ? web.api_keys as Record<string, string> : {}; return { provider: typeof web.provider === "string" ? web.provider : "auto", workflow: typeof web.workflow === "string" ? web.workflow : "none", providers: Object.entries({ openai: "OPENAI_API_KEY", exa: "EXA_API_KEY", brave: "BRAVE_API_KEY", parallel: "PARALLEL_API_KEY", tavily: "TAVILY_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY" }).map(([id, env]) => ({ id, has_key: Boolean(stored[id] || process.env[env]), key_source: stored[id] ? "web-access" : process.env[env] ? "environment" : null, env })) }; });
  app.put("/api/settings/web-access", async (request, reply) => { const body = (request.body ?? {}) as { provider?: unknown; workflow?: unknown; api_keys?: unknown; remove_keys?: unknown }; const supported = ["openai", "exa", "brave", "parallel", "tavily", "perplexity", "gemini"]; if (body.api_keys && typeof body.api_keys === "object") for (const key of Object.keys(body.api_keys as Record<string, unknown>)) if (!supported.includes(key)) return reply.code(400).send({ error: `Unknown web search provider: ${key}` }); await mutate((config) => { const web = config.web_access ?? {}; web.provider = String(body.provider ?? "auto"); web.workflow = String(body.workflow ?? "none"); const stored = typeof web.api_keys === "object" && web.api_keys ? web.api_keys as Record<string, string> : {}; if (body.api_keys && typeof body.api_keys === "object") for (const [key, value] of Object.entries(body.api_keys as Record<string, unknown>)) if (String(value).trim()) stored[key] = String(value).trim(); if (Array.isArray(body.remove_keys)) for (const key of body.remove_keys.map(String)) delete stored[key]; web.api_keys = stored; config.web_access = web; }); const response = await app.inject({ method: "GET", url: "/api/settings/web-access" }); return respondWithReload(reply, { ok: true, ...(response.json() as Record<string, unknown>) }); });
  app.get("/api/settings/mcp", async () => { const config = await load(); const source = typeof config.mcp_config_path === "string" ? config.mcp_config_path : configPath("mcp.json"); let definitions: Record<string, unknown> = {}; try { const payload = JSON.parse(await readFile(source, "utf8")) as { mcpServers?: unknown }; definitions = payload.mcpServers && typeof payload.mcpServers === "object" ? payload.mcpServers as Record<string, unknown> : {}; } catch { /* empty catalog */ } const configured = Object.keys(definitions); const enabled = Array.isArray(config.mcp_servers) ? config.mcp_servers.filter((id) => configured.includes(id)) : configured; return { servers: enabled, configured, config_path: source }; });
  app.put<{ Params: { server_id: string } }>("/api/settings/mcp/:server_id", async (request, reply) => { const on = String((request.query as { enabled?: string }).enabled ?? "true") !== "false"; await mutate((config) => { const enabled = new Set(Array.isArray(config.mcp_servers) ? config.mcp_servers : []); if (on) enabled.add(request.params.server_id); else enabled.delete(request.params.server_id); config.mcp_servers = [...enabled].sort(); }); return respondWithReload(reply, { ok: true, server: request.params.server_id, enabled: on }); });
  app.get("/api/settings/skills", async () => { const config = await load(); return { skills: [], configured: Boolean(config.skills_configured) }; });
  app.delete("/api/settings/skills", async (_request, reply) => { await mutate((config) => { delete config.skills_configured; delete config.skill_paths; }); return respondWithReload(reply, { ok: true, message: "Skills reset to auto-discover mode" }); });
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
