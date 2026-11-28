import {
  clampThinking,
  modelCatalog,
  normalizeThinkingLevels,
  providerInventory,
  readModelSnapshot,
} from "../../model-config/settings-model-projection.js";
import { approvalPreferencesSchema } from "@pi-science/contracts";
import { approvalPreferences } from "../../runtime/sandbox/approval-preferences.js";
import { approvalMetrics } from "../../runtime/sandbox/approval-metrics.js";
import {
  webSettingsPatchSchema,
  updateWebSettings,
  publicWebSettings,
  webSettingsFromConfig,
} from "../../web/settings.js";
import { registerNetworkGrantRoutes } from "./network-grant-routes.js";
import { discoverAgentDefinitions } from "../../runtime/agent/agent-definitions.js";
import { registerModelSelectionRoutes } from "./model-selection-routes.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  defaultProgressAppearance,
  progressAppearanceInputSchema,
  progressAppearanceSchema,
} from "@pi-science/contracts";
import { canonicalRuntimeModelRef } from "../../runtime/agent/model-ref.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { resolveCompaction } from "../../runtime/agent/agent-runtime-settings.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { SettingsStore, type SettingsData as Settings } from "../../storage/settings-store.js";
import type { RuntimeCatalogService } from "../../runtime/agent/runtime-catalog.js";
import { storedSkillPolicy } from "../../catalog/skill-policy.js";
import { registerSettingsSkillRoutes } from "./settings-skill-routes.js";
import { citationAutoVerifyEnabled } from "../../runtime/citations/citation-auto-verify.js";
import { respondWithRuntimeReload, query } from "./settings-response.js";

function compactionThreshold(
  config: Settings,
  available: Array<Record<string, unknown>>,
  configured: string,
): number {
  const override = config.model_context_window_override;
  const contextWindow =
    override?.model === configured
      ? override.context_window
      : Number(available.find((item) => item.id === configured)?.context_window ?? 0);
  return resolveCompaction(contextWindow || 16384, config).thresholdPercent;
}
export function registerSettingsRoutes(
  app: FastifyInstance,
  nodeSessionService: NodeSessionService,
  settingsStore: SettingsStore,
  runtimeCatalog?: Pick<RuntimeCatalogService, "getCatalog">,
): void {
  registerNetworkGrantRoutes(app);
  app.get("/api/settings/approval", async () => approvalPreferences(await settingsStore.read()));
  app.put("/api/settings/approval", async (request, reply) => {
    const parsed = approvalPreferencesSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        code: "invalid_approval_preferences",
        error: "New session default must be ask or auto",
      });
    await settingsStore.update((config) => {
      config.approval_preferences = parsed.data;
    });
    return parsed.data;
  });
  app.get("/api/settings/approval-metrics", async () => approvalMetrics.snapshot());
  const load = () => settingsStore.read();
  const mutate = <T>(operation: (config: Settings) => T | Promise<T>) =>
    settingsStore.update(operation, { skipUnchanged: true });
  function respondWithReload<T extends Record<string, unknown>>(
    reply: FastifyReply,
    payload: T,
  ): ReturnType<typeof respondWithRuntimeReload<T>>;
  function respondWithReload<T extends Record<string, unknown>>(
    service: NodeSessionService,
    reply: FastifyReply,
    payload: T,
  ): ReturnType<typeof respondWithRuntimeReload<T>>;
  function respondWithReload<T extends Record<string, unknown>>(
    first: NodeSessionService | FastifyReply,
    second: FastifyReply | T,
    third?: T,
  ) {
    return third
      ? respondWithRuntimeReload(first as NodeSessionService, second as FastifyReply, third)
      : respondWithRuntimeReload(nodeSessionService, first as FastifyReply, second as T);
  }
  app.get("/api/settings/providers", async () => {
    return { providers: await providerInventory(nodeSessionService, "", runtimeCatalog) };
  });
  app.get("/api/settings/config", async (request) => {
    const config = await load();
    const cwdValue = query(request, "cwd", "");
    // Request-scoped snapshot: inventory and capabilities observe the same
    // model read, without caching credentials across configuration writes.
    const snapshot = await readModelSnapshot(nodeSessionService, cwdValue, runtimeCatalog);
    const catalog = await modelCatalog(nodeSessionService, cwdValue, runtimeCatalog, snapshot);
    const available = catalog.available;
    const modelRef =
      typeof config.model === "string" && config.model
        ? canonicalRuntimeModelRef(config.model)
        : null;
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
          if (selected) {
            selected.thinking_levels = levels;
            selected.reasoning = levels.length > 1 || levels[0] !== "off";
          }
          const effective = clampThinking(thinking, levels);
          thinking = effective;
        }
      }
    }
    const selected = available.find((item) => item.id === configured);
    if (selected?.context_window) config.model_context_window = Number(selected.context_window);
    const progressAppearance = progressAppearanceSchema.safeParse(config.progress_appearance ?? {});
    const effectiveProgressAppearance = progressAppearance.success
      ? progressAppearance.data
      : defaultProgressAppearance;
    const providers = await providerInventory(
      nodeSessionService,
      cwdValue,
      runtimeCatalog,
      snapshot,
    );
    const apiKeys = Object.fromEntries(
      providers.map((provider) => [provider.id, provider.has_key]),
    );
    return {
      api_keys: apiKeys,
      model: configured,
      unavailable_model: unavailableModel,
      thinking,
      model_context_window: config.model_context_window ?? null,
      model_context_window_override: config.model_context_window_override ?? null,
      model_max_output_tokens: Number(selected?.max_output_tokens ?? 0) || null,
      progress_appearance: effectiveProgressAppearance,
      compaction_enabled: config.compaction_enabled !== false,
      compaction_threshold_percent: compactionThreshold(config, available, configured),
      citation_auto_verify: await citationAutoVerifyEnabled(),
      citation_inline_style:
        config.citation_inline_style === "identifier" ? "identifier" : "number",
      allow_private_providers: config.allow_private_providers !== false,
      providers,
      available_models: available,
      model_catalog_source: catalog.source,
    };
  });
  app.get("/api/settings/web-access", async () => ({
    web_access: publicWebSettings(await webSettingsFromConfig(await load())),
  }));
  app.put("/api/settings/web-access", async (request, reply) => {
    const patch = webSettingsPatchSchema.safeParse(request.body);
    if (!patch.success) return reply.code(400).send({ error: "Invalid web access settings" });
    const settings = await mutate(async (config) =>
      publicWebSettings(await updateWebSettings(config, patch.data)),
    );
    return respondWithRuntimeReload(nodeSessionService, reply, { ok: true, web_access: settings });
  });
  // UI-only state: a dedicated cheap read (no provider inventory or model
  // catalog work) and a write that never reloads runtimes or replaces
  // sessions — progress appearance must not touch conversation state.
  app.get("/api/settings/progress", async () => {
    const config = await load();
    const progressAppearance = progressAppearanceSchema.safeParse(config.progress_appearance ?? {});
    return {
      progress_appearance: progressAppearance.success
        ? progressAppearance.data
        : defaultProgressAppearance,
    };
  });
  app.put("/api/settings/progress", async (request, reply) => {
    const parsed = progressAppearanceInputSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid progress appearance settings", details: parsed.error.flatten() });
    await mutate((config) => {
      config.progress_appearance = parsed.data;
    });
    return reply.send({ ok: true, progress_appearance: parsed.data });
  });
  // Reads the value back from the stored config instead of echoing the body,
  // so a caller can tell a saved switch from a requested one.
  app.put("/api/settings/citation-auto-verify", async (request, reply) => {
    const body = (request.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean")
      return reply.code(400).send({ error: "enabled must be a boolean" });
    const stored = await mutate((config) => {
      config.citation_auto_verify = body.enabled as boolean;
      return config.citation_auto_verify;
    });
    return { ok: true, citation_auto_verify: stored === true };
  });
  // Same read-back rule as the switch above: the answer reports what the stored
  // config now holds, so a caller can tell a saved style from a requested one.
  app.put("/api/settings/citation-inline-style", async (request, reply) => {
    const body = (request.body ?? {}) as { style?: unknown };
    if (body.style !== "number" && body.style !== "identifier")
      return reply.code(400).send({ error: "style must be number or identifier" });
    const stored = await mutate((config) => {
      config.citation_inline_style = body.style as "number" | "identifier";
      return config.citation_inline_style;
    });
    return { ok: true, citation_inline_style: stored === "identifier" ? "identifier" : "number" };
  });
  app.put("/api/settings/private-providers", async (request, reply) => {
    const body = (request.body ?? {}) as { enabled?: unknown };
    const enabled = body.enabled !== false;
    await mutate((config) => {
      config.allow_private_providers = enabled;
    });
    return respondWithReload(nodeSessionService, reply, {
      ok: true,
      allow_private_providers: enabled,
    });
  });
  registerModelSelectionRoutes(
    app,
    nodeSessionService,
    settingsStore,
    async (cwd) => (await modelCatalog(nodeSessionService, cwd, runtimeCatalog)).available,
  );
  app.put("/api/settings/compaction", async (request, reply) => {
    const body = (request.body ?? {}) as { enabled?: unknown; threshold_percent?: unknown };
    const threshold =
      body.threshold_percent === undefined ? undefined : Number(body.threshold_percent);
    if (
      threshold !== undefined &&
      (!Number.isFinite(threshold) || threshold < 50 || threshold > 95)
    )
      return reply
        .code(400)
        .send({ error: "Compaction threshold must be between 50 and 95 percent" });
    const stored = await mutate((config) => {
      config.compaction_enabled = body.enabled !== false;
      if (threshold !== undefined) config.compaction_threshold_percent = threshold;
      return config.compaction_threshold_percent;
    });
    return respondWithReload(nodeSessionService, reply, {
      ok: true,
      compaction_enabled: body.enabled !== false,
      compaction_threshold_percent: threshold ?? stored,
    });
  });

  registerSettingsSkillRoutes(app, nodeSessionService, settingsStore);
  app.get("/api/settings/subagents/discovery", async (request, reply) => {
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(query(request, "cwd"));
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
    return {
      agents: (await discoverAgentDefinitions(cwd, storedSkillPolicy(await load()))).map(
        ({ name, description, source }) => ({ name, description, source }),
      ),
    };
  });
  app.get("/api/settings/subagents", async (request, reply) => {
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(query(request, "cwd"));
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
    return {
      agents: (await discoverAgentDefinitions(cwd, storedSkillPolicy(await load())))
        .filter((agent) => agent.path?.startsWith(".pi/"))
        .map(({ name, path }) => ({ name, path })),
    };
  });
}

export { endpointId } from "../../config/model-endpoint.js";
