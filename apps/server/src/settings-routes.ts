import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { configPath } from "./persistence.js";
import type { NodeSessionService } from "./node-session-service.js";
import { runtimeExtensionStatus } from "./pi-runtime-launch.js";
import { validateOutboundHttpUrl } from "./outbound-security.js";
import { validateWorkspaceCwd } from "./workspace-security.js";
import { SettingsStore, type SettingsData as Settings } from "./settings-store.js";
import { loadPiAiCatalog } from "./model-catalog-fallback.js";

const PROVIDER_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY", xai: "XAI_API_KEY", zai: "ZAI_API_KEY", fireworks: "FIREWORKS_API_KEY", together: "TOGETHER_API_KEY" };
const PROVIDERS = [
  ["anthropic", "Anthropic", ["claude-opus-4-5", "claude-sonnet-4-20250514"]], ["openai", "OpenAI", ["gpt-5.1", "gpt-5.1-codex", "gpt-4o"]], ["google", "Gemini", ["gemini-2.5-pro", "gemini-2.5-flash"]], ["deepseek", "DeepSeek", ["deepseek-v4-pro", "deepseek-v4-flash"]], ["groq", "Groq", ["llama-3.3-70b-versatile"]], ["openrouter", "OpenRouter", ["openai/gpt-5.1", "anthropic/claude-sonnet-5"]], ["mistral", "Mistral", ["devstral-latest"]], ["xai", "xAI", ["grok-4.3"]], ["zai", "Z.AI", ["glm-4.7"]],
] as const;
async function respondWithRuntimeReload<T extends Record<string, unknown>>(nodeSessionService: NodeSessionService, reply: FastifyReply, payload: T): Promise<(T & { session_replacements: Array<{ cwd: string; oldId: string; newId: string }> }) | FastifyReply> {
  try { return { ...payload, session_replacements: await nodeSessionService.reloadConfiguration() }; }
  catch (error) { return reply.code(502).send({ ok: false, error: `Settings were saved, but Pi runtime reload failed: ${String(error)}` }); }
}
function active(config: Settings): Record<string, boolean> { return Object.fromEntries(Object.keys(PROVIDER_ENV).map((id) => [id, Boolean(config.api_keys?.[id] || process.env[PROVIDER_ENV[id]!] || (id === "openai" && process.env.OPENAI_API_KEY))])); }
function fallbackModel(provider: string, model: string, label: string, custom: boolean, reasoning: boolean, contextWindow = 128000, thinkingLevels?: string[]): Record<string, unknown> { return { id: `${provider}/${model}`, provider, model, label, custom, reasoning, thinking_levels: reasoning ? (thinkingLevels?.length ? thinkingLevels : ["off", "minimal", "low", "medium", "high", "xhigh"]) : ["off"], context_window: contextWindow, capability_source: "pi-science fallback" }; }
function models(config: Settings): Array<Record<string, unknown>> { const result: Array<Record<string, unknown>> = []; for (const [id, name, entries] of PROVIDERS) if (active(config)[id]) for (const model of entries) { const reasoning = /gpt-5|thinking|reasoning|claude-(opus|sonnet)-4|gemini-2.5|deepseek-v4/.test(model); result.push(fallbackModel(id, model, `${name} · ${model}`, false, reasoning)); } for (const provider of config.custom_providers ?? []) for (const model of provider.models) { const hint = provider.model_hints?.[model]; const reasoning = typeof hint?.reasoning === "boolean" ? hint.reasoning : typeof provider.reasoning === "boolean" ? provider.reasoning : /thinking|reasoning|gpt-5|qwen3|deepseek-r1|deepseek-v4/i.test(model); const contextWindow = Number(hint?.context_window ?? provider.context_window ?? 128000); result.push(fallbackModel(`custom-${provider.id}`, model, `${provider.name} · ${model}`, true, reasoning, contextWindow > 0 ? contextWindow : 128000, hint?.thinking_levels)); } return result; }
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
async function readBoundedJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> { if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("Model discovery response is too large"); if (!response.body) return {}; const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) throw new Error("Model discovery response is too large"); chunks.push(next.value); } } finally { reader.releaseLock(); } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; }

type ModelHint = { context_window?: number; reasoning?: boolean; thinking_levels?: string[]; source?: string };
function hintFromModel(value: unknown, piModels: Array<Record<string, unknown>>): ModelHint {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const id = String(item.id ?? item.name ?? "");
  const pi = piModels.find((candidate) => String(candidate.id ?? "") === id);
  const context = Number(item.max_model_len ?? item.context_window ?? item.context_length ?? item.contextWindow ?? (pi?.contextWindow ?? 0));
  const levelMap = item.thinkingLevelMap && typeof item.thinkingLevelMap === "object"
    ? Object.keys(item.thinkingLevelMap as Record<string, unknown>)
    : Array.isArray(item.thinking_levels) ? item.thinking_levels.map(String) : undefined;
  const reasoning = typeof item.reasoning === "boolean" ? item.reasoning : typeof pi?.reasoning === "boolean" ? pi.reasoning : undefined;
  return {
    ...(context > 0 ? { context_window: context } : {}),
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    ...(levelMap?.length ? { thinking_levels: levelMap } : {}),
    source: item.max_model_len || item.context_window || item.context_length ? "models" : pi ? "pi-ai" : "fallback",
  };
}

async function discoverModelHints(baseUrl: string, apiKey: string, api: string, allowPrivate: boolean): Promise<Record<string, ModelHint>> {
  const safeUrl = await validateOutboundHttpUrl(baseUrl, { allowPrivate });
  const headers: Record<string, string> = { accept: "application/json" };
  if (api === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  // Capability discovery must not block saving a provider when a local
  // endpoint is offline. The normal explicit discovery endpoint remains more
  // patient; this background save probe is intentionally short.
  const response = await fetch(`${safeUrl.toString().replace(/\/$/, "")}/models`, { headers, redirect: "error", signal: AbortSignal.timeout(750) });
  if (!response.ok) throw new Error(`Model discovery returned ${response.status}`);
  const payload = await readBoundedJson(response, 2 * 1024 * 1024);
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const piModels = await loadPiAiCatalog();
  const hints: Record<string, ModelHint> = {};
  for (const row of rows) {
    const id = typeof row === "string" ? row : row && typeof row === "object" ? String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).name ?? "") : "";
    if (id) hints[id] = hintFromModel(typeof row === "string" ? { id: row } : row, piModels);
  }
  return hints;
}

export function registerSettingsRoutes(app: FastifyInstance, nodeSessionService: NodeSessionService, settingsStore: SettingsStore): void {
  const load = () => settingsStore.read();
  const mutate = <T>(operation: (config: Settings) => T | Promise<T>) => settingsStore.update(operation);
  // Probe custom providers on save. Failure is deliberately best-effort: a
  // provider may be temporarily offline, while explicit user settings must
  // still be persisted.
  app.addHook("preValidation", async (request) => {
    if (request.method !== "PUT" || !request.url.startsWith("/api/settings/custom-providers/") || request.url.endsWith("/discover")) return;
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : null;
    if (!body?.base_url) return;
    try {
      const config = await load();
      const hints = await discoverModelHints(String(body.base_url), String(body.api_key ?? ""), String(body.api ?? "openai-completions"), config.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0");
      body.model_hints = { ...(body.model_hints && typeof body.model_hints === "object" ? body.model_hints : {}), ...hints };
    } catch {
      // Keep the save path available for providers without a reachable
      // /models endpoint; the route's existing defaults remain usable.
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
  app.post("/api/settings/custom-providers/discover", async (request, reply) => { const body = (request.body ?? {}) as Record<string, unknown>; const baseUrl = String(body.base_url ?? "").replace(/\/$/, ""); let safeUrl: URL; try { const config = await load(); safeUrl = await validateOutboundHttpUrl(baseUrl, { allowPrivate: config.allow_private_providers !== false && process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS !== "0" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } const headers: Record<string, string> = { accept: "application/json" }; if (body.api_key) headers.authorization = `Bearer ${String(body.api_key)}`; let response: Response; try { response = await fetch(`${safeUrl.toString().replace(/\/$/, "")}/models`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) }); } catch (error) { return reply.code(502).send({ error: `Model discovery failed: ${String(error)}` }); } let payload: Record<string, unknown>; try { payload = await readBoundedJson(response, 2 * 1024 * 1024); } catch (error) { return reply.code(502).send({ error: String(error) }); } if (!response.ok) return reply.code(502).send({ error: String(payload.error ?? payload.message ?? `Model discovery returned ${response.status}`) }); const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []; const discovered = rows.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name ?? "") : "").filter(Boolean); if (!discovered.length) return reply.code(422).send({ error: "No models were returned by this provider" }); const id = slug(String(body.name ?? safeUrl.hostname)); return { provider: { id, name: String(body.name ?? "Custom API"), base_url: baseUrl, api: String(body.api ?? "openai-completions"), models: [...new Set(discovered)] } }; });
  app.put<{ Params: { provider_id: string } }>("/api/settings/custom-providers/:provider_id", async (request, reply) => { const body = (request.body ?? {}) as Record<string, unknown>; const baseUrl = String(body.base_url ?? "").replace(/\/$/, ""); if (!/^https?:\/\//.test(baseUrl)) return reply.code(400).send({ error: "base_url must be an absolute http(s) URL" }); const modelList = Array.isArray(body.models) ? [...new Set(body.models.map(String).map((item) => item.trim()).filter(Boolean))] : []; if (!modelList.length) return reply.code(400).send({ error: "At least one model is required" }); const contextWindow = Number(body.context_window ?? 128000); if (!Number.isInteger(contextWindow) || contextWindow < 4096) return reply.code(400).send({ error: "context_window must be at least 4096 tokens" }); const requestedId = request.params.provider_id; const id = slug(requestedId); const result = await mutate((config) => { const old = config.custom_providers?.find((item) => item.id === id); if (old && requestedId !== old.id) return { conflict: true as const }; const requestedKey = String(body.api_key ?? ""); const next = { id, name: String(body.name ?? "Custom API"), base_url: baseUrl, api: String(body.api ?? "openai-completions"), models: modelList, api_key: requestedKey || old?.api_key || "", reasoning: typeof body.reasoning === "boolean" ? body.reasoning : old?.reasoning, context_window: contextWindow, model_hints: body.model_hints && typeof body.model_hints === "object" ? body.model_hints as NonNullable<Settings["custom_providers"]>[number]["model_hints"] : old?.model_hints }; config.custom_providers = [...(config.custom_providers ?? []).filter((item) => item.id !== id), next]; return { conflict: false as const, provider: next }; }); if (result.conflict) return reply.code(409).send({ error: `Provider ID '${requestedId}' conflicts with existing provider '${id}'` }); return respondWithReload(reply, { ok: true, provider: publicCustom(result.provider) }); });
  app.delete<{ Params: { provider_id: string } }>("/api/settings/custom-providers/:provider_id", async (request, reply) => { const id = slug(request.params.provider_id); await mutate((config) => { config.custom_providers = (config.custom_providers ?? []).filter((item) => item.id !== id); if (String(config.model ?? "").startsWith(`custom-${id}/`)) config.model = ""; }); return respondWithReload(reply, { ok: true, id }); });
  app.get("/api/settings/web-access", async () => { const config = await load(); const web = config.web_access ?? {}; const stored = typeof web.api_keys === "object" && web.api_keys ? web.api_keys as Record<string, string> : {}; return { provider: typeof web.provider === "string" ? web.provider : "auto", workflow: typeof web.workflow === "string" ? web.workflow : "none", providers: Object.entries({ openai: "OPENAI_API_KEY", exa: "EXA_API_KEY", brave: "BRAVE_API_KEY", parallel: "PARALLEL_API_KEY", tavily: "TAVILY_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY" }).map(([id, env]) => ({ id, has_key: Boolean(stored[id] || process.env[env]), key_source: stored[id] ? "web-access" : process.env[env] ? "environment" : null, env })) }; });
  app.put("/api/settings/web-access", async (request, reply) => { const body = (request.body ?? {}) as { provider?: unknown; workflow?: unknown; api_keys?: unknown; remove_keys?: unknown }; const supported = ["openai", "exa", "brave", "parallel", "tavily", "perplexity", "gemini"]; if (body.api_keys && typeof body.api_keys === "object") for (const key of Object.keys(body.api_keys as Record<string, unknown>)) if (!supported.includes(key)) return reply.code(400).send({ error: `Unknown web search provider: ${key}` }); await mutate((config) => { const web = config.web_access ?? {}; web.provider = String(body.provider ?? "auto"); web.workflow = String(body.workflow ?? "none"); const stored = typeof web.api_keys === "object" && web.api_keys ? web.api_keys as Record<string, string> : {}; if (body.api_keys && typeof body.api_keys === "object") for (const [key, value] of Object.entries(body.api_keys as Record<string, unknown>)) if (String(value).trim()) stored[key] = String(value).trim(); if (Array.isArray(body.remove_keys)) for (const key of body.remove_keys.map(String)) delete stored[key]; web.api_keys = stored; config.web_access = web; }); const response = await app.inject({ method: "GET", url: "/api/settings/web-access" }); return respondWithReload(reply, { ok: true, ...(response.json() as Record<string, unknown>) }); });
  app.get("/api/settings/mcp", async () => { const config = await load(); const source = typeof config.mcp_config_path === "string" ? config.mcp_config_path : configPath("mcp.json"); let definitions: Record<string, unknown> = {}; try { const payload = JSON.parse(await readFile(source, "utf8")) as { mcpServers?: unknown }; definitions = payload.mcpServers && typeof payload.mcpServers === "object" ? payload.mcpServers as Record<string, unknown> : {}; } catch { /* empty catalog */ } const configured = Object.keys(definitions); const enabled = Array.isArray(config.mcp_servers) ? config.mcp_servers.filter((id) => configured.includes(id)) : configured; return { servers: enabled, configured, config_path: source }; });
  app.put<{ Params: { server_id: string } }>("/api/settings/mcp/:server_id", async (request, reply) => { const on = String((request.query as { enabled?: string }).enabled ?? "true") !== "false"; await mutate((config) => { const enabled = new Set(Array.isArray(config.mcp_servers) ? config.mcp_servers : []); if (on) enabled.add(request.params.server_id); else enabled.delete(request.params.server_id); config.mcp_servers = [...enabled].sort(); }); return respondWithReload(reply, { ok: true, server: request.params.server_id, enabled: on }); });
  app.get("/api/settings/skills", async () => { const config = await load(); return { skills: [], configured: Boolean(config.skills_configured) }; });
  app.delete("/api/settings/skills", async (_request, reply) => { await mutate((config) => { delete config.skills_configured; delete config.skill_paths; }); return respondWithReload(reply, { ok: true, message: "Skills reset to auto-discover mode" }); });
  app.get("/api/settings/extensions", async () => ({ extensions: runtimeExtensionStatus() }));
  app.get("/api/settings/subagents", async (request, reply) => { let cwd: string; try { cwd = await validateWorkspaceCwd(query(request, "cwd")); } catch (error) { return reply.code(403).send({ error: String(error) }); } const { readdir } = await import("node:fs/promises"); const { join, relative } = await import("node:path"); const directory = join(cwd, ".pi", "agents"); const agents: unknown[] = []; try { for (const name of await readdir(directory)) if (name.endsWith(".md")) agents.push({ name: name.slice(0, -3), path: relative(cwd, join(directory, name)).replaceAll("\\", "/") }); } catch { /* no agents */ } return { agents }; });
}

export { endpointId } from "./model-endpoint.js";
