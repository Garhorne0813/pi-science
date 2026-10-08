import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { modelSelectionSchema, thinkingLevelSchema, type ModelSelection } from "@pi-science/contracts";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import type { SettingsStore } from "../../storage/settings-store.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { normalizeThinkingLevels, CANONICAL_THINKING_LEVELS } from "../../model-resources/capability-resolver.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { sessionRuntimeStatus } from "./node-session-routes.js";

type SelectionCatalog = (cwd: string) => Promise<Array<Record<string, unknown>>>;

/** Selection ownership is independent of provider/capability projections. */
export function registerModelSelectionRoutes(app: FastifyInstance, sessions: NodeSessionService, settings: SettingsStore, resources: ModelResourceService | undefined, catalog: SelectionCatalog) {
  const canonical = async (model: string | null) => {
    await resources?.ensureMigrated();
    return model ? (await resources?.repository.read())?.aliases[model] ?? model : null;
  };
  const readDefault = async (): Promise<ModelSelection> => {
    const config = await settings.read();
    return { model: await canonical(typeof config.model === "string" && config.model ? config.model : null), thinking: thinkingLevelSchema.safeParse(config.thinking).data ?? "off" };
  };
  const workspace = async (request: FastifyRequest, required: boolean) => {
    const cwd = (request.query as { cwd?: unknown }).cwd;
    if (required && (typeof cwd !== "string" || !cwd)) throw Object.assign(new Error("cwd is required for session selection"), { status: 400 });
    return typeof cwd === "string" && cwd ? validateWorkspaceCwd(cwd) : "";
  };
  const fail = (reply: FastifyReply, error: unknown) => reply.code((error as { status?: number })?.status ?? 403).send({ ok: false, code: "workspace_invalid", error: String(error) });

  app.get("/api/model-selection/default", async () => ({ scope: "default", selection: await readDefault() }));
  app.get("/api/model-selection/catalog", async (request, reply) => {
    let cwd: string;
    try { cwd = await workspace(request, false); } catch (error) { return fail(reply, error); }
    return { available_models: await catalog(cwd) };
  });
  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/model-selection", async (request, reply) => {
    let cwd: string;
    try { cwd = await workspace(request, true); } catch (error) { return fail(reply, error); }
    const state = await sessions.state(request.params.session_id, cwd);
    if ("error" in state) return reply.code(sessionRuntimeStatus(state.code)).send({ ok: false, ...state });
    return { scope: "session", session_id: request.params.session_id, selection: { model: state.model ?? null, thinking: thinkingLevelSchema.safeParse(state.thinking).data ?? "off" } };
  });

  const write = async (request: FastifyRequest, reply: FastifyReply, sessionId?: string, legacy = false) => {
    const body = request.body as Record<string, unknown> | undefined;
    const input = legacy ? { model: body?.model || null, thinking: body?.thinking ?? "high" } : body;
    const parsed = modelSelectionSchema.safeParse(input);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_request", error: "Invalid model selection", details: parsed.error.flatten() });
    let cwd: string;
    try { cwd = await workspace(request, Boolean(sessionId)); } catch (error) { return fail(reply, error); }
    const model = await canonical(parsed.data.model);
    if (sessionId && !model) return reply.code(422).send({ ok: false, code: "invalid_model", error: "A session requires a model" });
    const selected = model ? (await catalog(cwd)).find((item) => item.id === model) : undefined;
    if (model && !selected) return reply.code(422).send({ ok: false, code: "invalid_model", error: "Model is unavailable in agent-core" });
    let levels = normalizeThinkingLevels(selected?.thinking_levels) ?? ["off"];
    if (cwd && model) {
      const actual = await sessions.availableThinkingLevels(cwd, model).catch(() => null);
      const data = actual?.data as { model?: string; levels?: unknown } | undefined;
      if (actual?.success && data?.model === model) levels = normalizeThinkingLevels(data.levels) ?? levels;
    }
    let thinking = model ? parsed.data.thinking : "off";
    if (!levels.includes(thinking)) {
      if (!legacy) return reply.code(422).send({ ok: false, code: "invalid_thinking", error: "Thinking level is not supported by this model", supported_levels: levels });
      const index = CANONICAL_THINKING_LEVELS.indexOf(thinking);
      thinking = (CANONICAL_THINKING_LEVELS.slice(index).find((level) => levels.includes(level)) ?? [...CANONICAL_THINKING_LEVELS.slice(0, index)].reverse().find((level) => levels.includes(level)) ?? "off");
    }
    const selection: ModelSelection = { model, thinking };
    if (sessionId) {
      const configured = await sessions.configure(sessionId, cwd, model!, thinking);
      if (!configured.success) return reply.code(sessionRuntimeStatus(configured.code)).send({ ok: false, ...configured });
      return legacy ? { ok: true, ...selection } : { scope: "session", session_id: sessionId, selection };
    }
    await settings.update((config) => {
      config.model = model ?? "";
      config.thinking = thinking;
      // Cached capabilities are a projection, never part of ModelSelection.
      delete config.model_context_window;
      delete config.model_max_output_tokens;
      if (config.model_context_window_override?.model !== model) delete config.model_context_window_override;
      if (Number(selected?.context_window) > 0) config.model_context_window = Number(selected?.context_window);
      if (Number(selected?.max_output_tokens) > 0) config.model_max_output_tokens = Number(selected?.max_output_tokens);
    }, { skipUnchanged: true });
    return legacy ? { ok: true, ...selection, model: model ?? "" } : { scope: "default", selection };
  };
  app.put("/api/model-selection/default", (request, reply) => write(request, reply));
  app.put<{ Params: { session_id: string } }>("/api/sessions/:session_id/model-selection", (request, reply) => write(request, reply, request.params.session_id));
  // Compatibility adapter: a session_id changes only that session; otherwise
  // the old route means default selection. Neither write reloads all workers.
  app.put("/api/settings/model", (request, reply) => {
    reply.header("Deprecation", "true");
    const id = (request.body as { session_id?: unknown } | undefined)?.session_id;
    if (id !== undefined && (typeof id !== "string" || !id)) return reply.code(400).send({ ok: false, code: "invalid_request", error: "session_id must be a nonempty string" });
    return write(request, reply, id as string | undefined, true);
  });
}
