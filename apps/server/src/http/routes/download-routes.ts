import type { FastifyInstance } from "fastify";
import { downloadUrl, grantDownloadHost, NetworkAccessRequired } from "../../security/download-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { recordEgress } from "../../security/egress-audit.js";
import { downloadProteinStructure } from "../../security/protein-structure-download.js";

export function registerDownloadRoutes(app: FastifyInstance): void {
  app.post("/api/downloads/protein-structure", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.on("aborted", abort);
    reply.raw.on("close", abort);
    try {
      return await downloadProteinStructure({
        workspace: String(body.cwd ?? ""), sessionId: String(body.session_id ?? ""),
        accession: String(body.accession ?? ""),
        ...(typeof body.source === "string" ? { source: body.source as "best_available" | "experimental" | "predicted" } : {}),
        ...(typeof body.destination === "string" ? { destination: body.destination } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof NetworkAccessRequired) return reply.code(403).send({ code: error.code, host: error.host, error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  });
  app.post("/api/downloads/grants", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const workspace = await validateWorkspaceCwd(String(body.cwd ?? ""));
      const result = await grantDownloadHost(workspace, String(body.session_id ?? ""), String(body.url ?? ""));
      await recordEgress({ connector_type: "download", connector_id: String(body.session_id), target_domain: String(body.url), approved: true, note: "session_grant" });
      return result;
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/downloads", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.on("aborted", abort);
    reply.raw.on("close", abort);
    try {
      return await downloadUrl({
        workspace: String(body.cwd ?? ""), sessionId: String(body.session_id ?? ""),
        url: String(body.url ?? ""), destination: String(body.destination ?? ""),
        ...(typeof body.expected_sha256 === "string" ? { expectedSha256: body.expected_sha256 } : {}),
        ...(typeof body.max_bytes === "number" ? { maxBytes: body.max_bytes } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof NetworkAccessRequired) return reply.code(403).send({ code: error.code, host: error.host, error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  });
}
