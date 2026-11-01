/**
 * Citation verification endpoints. The global internal-token hook covers the
 * agent path; workspace membership is validated per request. Verification
 * contacts free public scholarly APIs (Crossref, Unpaywall, arXiv) with
 * per-domain throttling and egress audit records.
 */
import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { citationVerifyService, type VerifyCitationsResult } from "../../runtime/citations/citation-verify-service.js";
import { citationAutoVerifyEnabled } from "../../runtime/citations/citation-auto-verify.js";

function q(request: { query: unknown }, key: string, fallback = "."): string {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : fallback;
}

async function ws(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  try { return await validateWorkspaceCwd(q(request, "cwd")); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

function bodyText(body: Record<string, unknown>, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): string | null {
  const text = String(body.text ?? "");
  if (!text.trim()) { reply.code(400).send({ error: "text is required" }); return null; }
  if (text.length > 500_000) { reply.code(413).send({ error: "text is too large to verify" }); return null; }
  return text;
}

/** The composite ids a source card's own check action names, or null after
 *  answering 400. */
function bodyIds(body: Record<string, unknown>, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): string[] | null {
  const ids = body.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string" && id.trim())) {
    reply.code(400).send({ error: "ids must be a non-empty array of non-empty strings" });
    return null;
  }
  return ids.map((id) => String(id).trim());
}

export function registerCitationRoutes(app: FastifyInstance, service = citationVerifyService): void {
  app.post("/api/citations/verify", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.ids !== undefined) {
      if (body.text !== undefined) { reply.code(400).send({ error: "Provide either text or ids, not both" }); return; }
      // A named source is the user's own request, so it is never gated on the
      // automatic switch; the text path below keeps that gate for agent calls.
      const ids = bodyIds(body, reply); if (ids === null) return;
      return await service.verifyIds(cwd, ids, { refresh: body.refresh === true });
    }
    const text = bodyText(body, reply); if (text === null) return;
    // `refresh` is the manual retry path: it re-queries providers instead of
    // replaying a snapshot taken before a rate limit or an outage. The trigger
    // is decided by server code, not by the model: with automatic verification
    // off, the agent's own call answers from the snapshot and contacts nobody.
    const result: VerifyCitationsResult = body.trigger === "agent" && !(await citationAutoVerifyEnabled())
      ? await service.lookupText(cwd, { text })
      : await service.verify(cwd, { text, refresh: body.refresh === true });
    return result;
  });

  // The source chips read the same answer text the agent saw, so a reference
  // entry that contradicts the record is visible without a provider request.
  app.post("/api/citations/snapshot", async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const text = bodyText((request.body ?? {}) as Record<string, unknown>, reply); if (text === null) return;
    return await service.lookupText(cwd, { text });
  });

  app.get("/api/citations", async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const raw = String(q(request, "ids", ""));
    const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return { citations: [] };
    return { citations: await service.lookup(cwd, ids) };
  });
}
