import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { ResearchOrchestrator } from "../../research/orchestrator/coordinator.js";
import { subscribeResearchEvents } from "../../research/events.js";

function queryCwd(request: { query: unknown }): string {
  const cwd = (request.query as Record<string, unknown>)?.cwd;
  return typeof cwd === "string" ? cwd : "";
}

async function cwd(request: { query: unknown }, reply: any): Promise<string | null> {
  try { return await validateWorkspaceCwd(queryCwd(request)); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

function failure(reply: any, error: unknown) {
  const code = typeof error === "object" && error !== null && (error as Record<string, unknown>).code === "STALE_GRAPH" ? 409 : 400;
  return reply.code(code).send({ error: error instanceof Error ? error.message : String(error), ...(typeof error === "object" && error !== null ? error : {}) });
}

export function registerResearchRoutes(app: FastifyInstance, research: ResearchOrchestrator): void {
  app.get("/api/research", async (request, reply) => { const root = await cwd(request, reply); return root ? { research: await research.list(root) } : undefined; });
  app.post("/api/research", async (request, reply) => { const root = await cwd(request, reply); if (!root) return; try { return await research.create(root, request.body); } catch (error) { return failure(reply, error); } });
  app.get<{ Params: { research_id: string } }>("/api/research/:research_id", async (request, reply) => { const root = await cwd(request, reply); if (!root) return; const snapshot = await research.detail(root, request.params.research_id); return snapshot ?? reply.code(404).send({ error: "Research not found" }); });
  app.post<{ Params: { research_id: string; action: string } }>("/api/research/:research_id/:action", async (request, reply) => {
    const root = await cwd(request, reply); if (!root) return;
    try {
      if (request.params.action === "start") return await research.start(root, request.params.research_id);
      if (request.params.action === "pause") return await research.pause(root, request.params.research_id);
      if (request.params.action === "resume") return await research.resumeResearch(root, request.params.research_id);
      if (request.params.action === "cancel") return await research.cancel(root, request.params.research_id);
      return reply.code(404).send({ error: "Unknown research action" });
    } catch (error) { return failure(reply, error); }
  });
  app.put<{ Params: { research_id: string } }>("/api/research/:research_id/constraints", async (request, reply) => {
    const root = await cwd(request, reply); if (!root) return;
    try {
      const constraints = Array.isArray((request.body as Record<string, unknown>)?.constraints) ? (request.body as { constraints: unknown[] }).constraints.map(String) : [];
      return await research.updateConstraints(root, request.params.research_id, constraints);
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { research_id: string; node_id: string } }>("/api/research/:research_id/input/:node_id", async (request, reply) => {
    const root = await cwd(request, reply); if (!root) return;
    try { return await research.resolveInput(root, request.params.research_id, request.params.node_id, String((request.body as Record<string, unknown>)?.resolution ?? "")); }
    catch (error) { return failure(reply, error); }
  });
  app.get("/api/research-events", async (request, reply) => {
    const root = await cwd(request, reply); if (!root) return;
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const push = (text: string) => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(text); };
    push(": connected\n\n");
    const unsubscribe = subscribeResearchEvents(root, (event) => push(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => push(": ping\n\n"), 15_000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
    request.raw.once("close", cleanup); reply.raw.once("close", cleanup);
  });
}
