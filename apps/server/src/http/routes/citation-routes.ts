/**
 * Citation verification endpoints. The global internal-token hook covers the
 * agent path; workspace membership is validated per request. Verification
 * contacts free public scholarly APIs (Crossref, Unpaywall, arXiv) with
 * per-domain throttling and egress audit records.
 */
import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { citationVerifyService, type VerifyCitationsResult } from "../../runtime/citations/citation-verify-service.js";

function q(request: { query: unknown }, key: string, fallback = "."): string {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : fallback;
}

async function ws(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  try { return await validateWorkspaceCwd(q(request, "cwd")); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

export function registerCitationRoutes(app: FastifyInstance, service = citationVerifyService): void {
  app.post("/api/citations/verify", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const text = String(body.text ?? "");
    if (!text.trim()) return reply.code(400).send({ error: "text is required" });
    if (text.length > 500_000) return reply.code(413).send({ error: "text is too large to verify" });
    const result: VerifyCitationsResult = await service.verify(cwd, { text });
    return result;
  });

  app.get("/api/citations", async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const raw = String(q(request, "ids", ""));
    const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return { citations: [] };
    return { citations: await service.lookup(cwd, ids) };
  });
}
