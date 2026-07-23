import { createSessionRequestSchema } from "@pi-science/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { nodeSessionService } from "./node-session-service.js";
import { sessionRepository } from "./session-repository.js";
import { validateWorkspaceCwd } from "./workspace-security.js";

function cwd(request: { query: unknown }): string {
  const value = (request.query as { cwd?: unknown }).cwd;
  return typeof value === "string" && value ? value : ".";
}

function status(code: unknown): number {
  switch (String(code ?? "")) {
    case "workspace_invalid": return 403;
    case "not_found":
    case "session_mismatch": return 404;
    case "busy":
    case "cancelled": return 409;
    case "invalid_request": return 400;
    case "spawn_failed":
    case "process_closed":
    case "process_exit": return 503;
    case "timeout": return 504;
    default: return 502;
  }
}

function sendFailure(reply: FastifyReply, result: Record<string, unknown>) {
  return reply.code(status(result.code)).send({ ok: false, ...result });
}

export function registerNodeSessionRoutes(app: FastifyInstance): void {
  app.post("/api/sessions", async (request, reply) => {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid session request", code: "invalid_request" });
    const result = await nodeSessionService.create(parsed.data);
    if ("error" in result) return reply.code(status(result.code)).send({ ok: false, ...result });
    return result;
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/prompt", async (request, reply) => {
    const body = request.body as { message?: unknown };
    if (typeof body?.message !== "string" || !body.message) return reply.code(400).send({ ok: false, code: "invalid_request", error: "message is required" });
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "prompt", { message: body.message });
    return result.success ? { ok: true, id: request.params.session_id } : sendFailure(reply, result);
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/resume", async (request, reply) => {
    const result = await nodeSessionService.resume(request.params.session_id, cwd(request));
    return result.success ? { ok: true, id: request.params.session_id, cwd: cwd(request) } : sendFailure(reply, result as Record<string, unknown>);
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/fork", async (request, reply) => {
    const body = (request.body ?? {}) as { entry_id?: unknown };
    const result = await nodeSessionService.fork(request.params.session_id, cwd(request), typeof body.entry_id === "string" ? body.entry_id : undefined);
    return result.success && result.sessionId
      ? { ok: true, id: result.sessionId, cwd: cwd(request) }
      : sendFailure(reply, result);
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/abort", async (request, reply) => {
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "abort");
    return result.success ? { ok: true } : sendFailure(reply, result);
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/state", async (request, reply) => {
    const result = await nodeSessionService.state(request.params.session_id, cwd(request));
    return "error" in result ? sendFailure(reply, result) : { ok: true, ...result };
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/model", async (request, reply) => {
    const body = request.body as { model?: unknown; thinking?: unknown };
    if (typeof body?.model !== "string" || !body.model.includes("/")) return reply.code(400).send({ ok: false, code: "invalid_request", error: "Model must use provider/model notation" });
    const result = await nodeSessionService.configure(request.params.session_id, cwd(request), body.model, typeof body.thinking === "string" ? body.thinking : undefined);
    if (!result.success) return sendFailure(reply, result);
    return {
      ok: true,
      id: String(result.sessionId ?? request.params.session_id),
      model: result.model ?? body.model,
      thinking: result.thinking ?? body.thinking ?? null,
      restarted: result.restarted === true,
      replaced_blank: result.replacedBlank === true,
    };
  });

  app.post<{ Params: { session_id: string } }>("/api/sessions/:session_id/compact", async (request, reply) => {
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "compact");
    return result.success ? { ok: true } : sendFailure(reply, result);
  });

  app.post<{ Params: { session_id: string; request_id: string } }>("/api/sessions/:session_id/interactions/:request_id", async (request, reply) => {
    const body = (request.body ?? {}) as { cancelled?: unknown; confirmed?: unknown; value?: unknown };
    const payload: Record<string, unknown> = { id: request.params.request_id };
    if (body.cancelled === true) payload.cancelled = true;
    else if (typeof body.confirmed === "boolean") payload.confirmed = body.confirmed;
    else if (body.value !== undefined) payload.value = body.value;
    else payload.cancelled = true;
    const result = await nodeSessionService.notify(request.params.session_id, cwd(request), "extension_ui_response", payload);
    return result.success ? { ok: true } : sendFailure(reply, result);
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/commands", async (request, reply) => {
    const result = await nodeSessionService.command(request.params.session_id, cwd(request), "get_commands");
    if (!result.success) return sendFailure(reply, result);
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    return { commands: Array.isArray(data.commands) ? data.commands : [] };
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/export", async (request, reply) => {
    const query = request.query as { format?: unknown };
    const format = typeof query.format === "string" ? query.format : "html";
    if (format !== "html" && format !== "jsonl") return reply.code(400).send({ ok: false, error: "format must be html or jsonl" });
    let root: string;
    try { root = await validateWorkspaceCwd(cwd(request)); }
    catch (error) { return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) }); }
    const messages = await sessionRepository.messages(root, request.params.session_id);
    if (!messages.length) return reply.code(404).send({ ok: false, code: "not_found", error: "session not found in this workspace" });
    const filename = `session-${request.params.session_id.slice(0, 8)}`;
    reply.header("content-disposition", `attachment; filename=\"${filename}.${format}\"`);
    if (format === "jsonl") return reply.type("application/x-ndjson").send(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    const rows = messages.map((message) => `<section><h2>${escapeHtml(message.role)}</h2><pre>${escapeHtml(messageText(message.content))}</pre></section>`).join("\n");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html><html><head><meta charset=\"utf-8\"><title>${escapeHtml(filename)}</title></head><body><h1>${escapeHtml(filename)}</h1>${rows}</body></html>`);
  });

  app.delete<{ Params: { session_id: string } }>("/api/sessions/:session_id", async (request, reply) => {
    const result = await nodeSessionService.delete(request.params.session_id, cwd(request));
    return result.success ? { ok: true } : sendFailure(reply, result as Record<string, unknown>);
  });
}

function messageText(content: Array<Record<string, unknown>>): string {
  return content.map((part) => String(part.text ?? part.content ?? part.output ?? "")).filter(Boolean).join("\n");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
