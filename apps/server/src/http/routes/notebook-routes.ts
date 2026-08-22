import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { NotebookService } from "../../runtime/notebooks/notebook-service.js";

async function cwdFromQuery(query: { cwd?: unknown }, fallback = "."): Promise<string> {
  const value = query.cwd ?? fallback;
  return validateWorkspaceCwd(String(value));
}

export function registerNotebookRoutes(app: FastifyInstance, notebooks: NotebookService): void {
  app.get("/api/notebooks", async (request, reply) => {
    try {
      const cwd = await cwdFromQuery(request.query as { cwd?: unknown });
      return await notebooks.list(cwd);
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notebooks/jupyter/env-status", async (request, reply) => {
    try {
      const cwd = await cwdFromQuery(request.query as { cwd?: unknown });
      return await notebooks.envStatus(cwd);
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notebooks/jupyter/status", async (request, reply) => {
    try {
      const query = request.query as { cwd?: unknown };
      const cwd = query.cwd === undefined ? undefined : await cwdFromQuery(query, ".");
      const payload = notebooks.status(cwd);
      if (cwd !== undefined) payload.env_ready = (await notebooks.envStatus(cwd)).ready;
      return payload;
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notebooks/jupyter/setup", async (request, reply) => {
    let cwd: string;
    try { cwd = await cwdFromQuery(request.query as { cwd?: unknown }); }
    catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const write = (event: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await notebooks.setup(cwd, write);
    } catch (error) {
      write({ status: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
    return reply;
  });

  app.post("/api/notebooks/jupyter/start", async (request, reply) => {
    try {
      const cwd = await cwdFromQuery(request.query as { cwd?: unknown });
      return await notebooks.start(cwd);
    } catch (error) {
      return reply.code(error instanceof Error && /already running/i.test(error.message) ? 409 : 400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/notebooks/jupyter/stop", async (request, reply) => {
    try {
      const query = request.query as { cwd?: unknown };
      const cwd = query.cwd === undefined ? undefined : await cwdFromQuery(query, ".");
      return notebooks.stop(cwd);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}