import type { FastifyInstance } from "fastify";
import { LiteratureService } from "../../literature/literature-service.js";
import { DEFAULT_PROVIDERS, isProviderId, type LiteratureProviderId } from "../../literature/types.js";
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from "../../security/sensitive-terms.js";

/**
 * Literature gateway routes (node control plane). The search route applies
 * the sensitive-term hard gate; the approve route issues short-lived tokens
 * that let a deliberate sensitive query through while still recording the
 * decision in the egress audit.
 */

export function registerLiteratureRoutes(app: FastifyInstance, service: LiteratureService = new LiteratureService()): void {
  app.post("/api/literature/search", async (request, reply) => {
    const body = (request.body ?? {}) as { query?: unknown; providers?: unknown; approvedToken?: unknown };
    if (typeof body.query !== "string") return reply.code(400).send({ error: "query is required" });
    let providers: LiteratureProviderId[] | undefined;
    if (body.providers !== undefined) {
      if (!Array.isArray(body.providers) || body.providers.length === 0 || body.providers.some((provider) => typeof provider !== "string" || !isProviderId(provider))) {
        return reply.code(400).send({ error: `providers must be a non-empty subset of: ${DEFAULT_PROVIDERS.join(", ")}` });
      }
      providers = body.providers as LiteratureProviderId[];
    }
    const approvedToken = typeof body.approvedToken === "string" && body.approvedToken ? body.approvedToken : undefined;
    try {
      return await service.search(body.query, { providers, approvedToken });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/literature/approve", async (request, reply) => {
    const body = (request.body ?? {}) as { query?: unknown; categories?: unknown };
    if (typeof body.query !== "string") return reply.code(400).send({ error: "query is required" });
    if (!Array.isArray(body.categories) || body.categories.length === 0) {
      return reply.code(400).send({ error: "categories must be a non-empty array" });
    }
    const categories: SensitiveCategory[] = [];
    for (const category of body.categories) {
      if (typeof category !== "string" || !SENSITIVE_CATEGORIES.includes(category as SensitiveCategory)) {
        return reply.code(400).send({ error: `categories must be a subset of: ${SENSITIVE_CATEGORIES.join(", ")}` });
      }
      categories.push(category as SensitiveCategory);
    }
    try {
      return await service.approve(body.query, categories);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
