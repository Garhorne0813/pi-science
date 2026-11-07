import { ApplicationError } from "../../modules/application-error.js";
import { applicationErrorStatus } from "../application-error.js";
import { legacyArchives, exportLegacyArchive } from "../../project-review/legacy-archives.js";

import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { MemoryService } from "../../memory/service.js";
import type { MemoryBackground } from "../../memory/background.js";
export function registerProjectRoutes(
  app: FastifyInstance,
  memory: MemoryService,
  background: MemoryBackground,
): void {
  app.post("/api/project-knowledge/science-review", async (req, reply) => {
    const body = (req.body ?? {}) as {
      cwd?: unknown;
      session_id?: unknown;
      trigger?: unknown;
      turn_id?: unknown;
    };
    if (typeof body.cwd !== "string" || typeof body.session_id !== "string" || !body.session_id)
      return reply.code(400).send({ error: "cwd and session_id are required" });
    if (body.trigger === "auto" && (typeof body.turn_id !== "string" || !body.turn_id))
      return reply.code(400).send({ error: "turn_id is required for automatic review" });
    try {
      const bound = await memory.context(body.cwd, "user", body.session_id);
      return await background.enqueue(bound.context, bound.cwd, "extraction", {
        sessionId: body.session_id,
        automatic: body.trigger === "auto",
        scienceReview: true,
        ...(typeof body.turn_id === "string" ? { turnId: body.turn_id } : {}),
      });
    } catch (error) {
      if (error instanceof ApplicationError)
        return reply.code(applicationErrorStatus(error)).send({ error: error.message });
      const status = (error as { statusCode?: number }).statusCode;
      if (status) return reply.code(status).send({ error: (error as Error).message });
      throw error;
    }
  });
  app.get("/api/project/archives", async (req) => {
    const cwd = await projectWorkspace((req.query as { cwd?: string }).cwd ?? ".");
    return { archives: await legacyArchives(cwd) };
  });
  app.post<{ Params: { id: string } }>("/api/project/archives/:id/export", async (req, reply) => {
    const cwd = await projectWorkspace((req.query as { cwd?: string }).cwd ?? ".");
    const archive = await exportLegacyArchive(cwd, req.params.id);
    return archive ? { archive } : reply.code(404).send({ error: "Archive not found" });
  });
}

async function projectWorkspace(value: string) {
  try {
    return await validateWorkspaceCwd(value);
  } catch (error) {
    throw Object.assign(new Error(String(error)), { statusCode: 403 });
  }
}
