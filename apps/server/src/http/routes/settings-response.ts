import type { FastifyReply } from "fastify";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";

export async function respondWithRuntimeReload<T extends Record<string, unknown>>(nodeSessionService: NodeSessionService, reply: FastifyReply, payload: T): Promise<(T & { session_replacements: Array<{ cwd: string; oldId: string; newId: string }> }) | FastifyReply> {
  try {
    const replacements = await nodeSessionService.reloadConfiguration();
    return { ...payload, session_replacements: replacements };
  }
  catch (error) {
    reply.code(502).send({ ok: false, error: `Settings were saved, but Pi runtime reload failed: ${String(error)}` });
    return reply;
  }
}

export function query(request: { query: unknown }, name: string, fallback = "."): string { const value = (request.query as Record<string, unknown>)[name]; return typeof value === "string" && value ? value : fallback; }
