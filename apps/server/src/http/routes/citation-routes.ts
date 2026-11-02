import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { citationSourcesResponseSchema } from "@pi-science/contracts";
import { durableEventStore } from "../../runtime/events/event-store.js";
import { captureCitationSources } from "../../runtime/citations/source-capture.js";
import { verifyCitationSources } from "../../runtime/citations/source-verify.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

type SessionLookup = { findPath(cwd: string, sessionId: string): Promise<string | null> };

function queryValue(request: { query: unknown }, key: string): string {
  const query = request.query as Record<string, unknown>;
  return typeof query[key] === "string" ? query[key] as string : "";
}

export function registerCitationRoutes(app: FastifyInstance, sessionRepository: SessionLookup): void {
  app.get("/api/citations/sources", async (request, reply) => {
    const cwd = queryValue(request, "cwd");
    const sessionId = queryValue(request, "sessionId");
    try {
      await validateWorkspaceCwd(cwd);
    } catch {
      return reply.code(403).send({ error: "Workspace path is not available" });
    }
    try {
      // A session must belong to this workspace; anything else is an empty
      // result so one workspace can never observe another's sources.
      if (!sessionId || !await sessionRepository.findPath(cwd, sessionId)) return reply.code(200).send({ sessionId, sources: [] });
      const captured = captureCitationSources(await durableEventStore.readAfter(cwd, sessionId));
      const sources = await verifyCitationSources(cwd, captured, (absolutePath) => readFile(absolutePath, "utf8"));
      return reply.code(200).send(citationSourcesResponseSchema.parse({ sessionId, sources }));
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : "Citation sources failed" });
    }
  });
}
