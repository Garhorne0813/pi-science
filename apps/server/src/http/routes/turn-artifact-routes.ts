import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { turnArtifactRepository, type TurnArtifactRecord } from "../../runtime/artifacts/turn-artifact-repository.js";

function queryCwd(request: { query: unknown }): string {
  const query = request.query as { cwd?: unknown };
  return typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
}

export function registerTurnArtifactRoutes(app: FastifyInstance): void {
  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/artifacts", async (request, reply) => {
    try {
      const cwd = await validateWorkspaceCwd(queryCwd(request));
      const turns: TurnArtifactRecord[] = await turnArtifactRepository.forSession(cwd, request.params.session_id);
      return { turns };
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
  });
}
