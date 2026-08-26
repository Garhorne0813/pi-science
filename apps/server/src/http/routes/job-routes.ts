import type { FastifyInstance } from "fastify";
import { JobCoordinator, publicJobRecord, type JobRequirement } from "../../runtime/jobs/job-coordinator.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

async function workspace(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  const query = request.query as Record<string, unknown>;
  try { return await validateWorkspaceCwd(typeof query.cwd === "string" && query.cwd ? query.cwd : "."); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

export function registerJobRoutes(app: FastifyInstance, jobs: JobCoordinator): void {
  app.post("/api/jobs/capabilities", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const body = (request.body ?? {}) as JobRequirement;
    if (typeof query.cwd === "string" && query.cwd) {
      const cwd = await workspace(request, reply);
      if (!cwd) return;
      try { return await jobs.capabilitiesForWorkspace(cwd, body); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
    }
    return jobs.capabilities(body);
  });
  app.post("/api/jobs", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { return publicJobRecord(await jobs.submit(cwd, (request.body ?? {}) as Record<string, unknown>)); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.get("/api/jobs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; const q = request.query as { limit?: string }; return { jobs: (await jobs.list(cwd, Math.min(1000, Math.max(1, Number(q.limit ?? 100))))).map(publicJobRecord) }; });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { const record = await jobs.get(cwd, request.params.job_id); return record ? publicJobRecord(record) : reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.delete<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { const record = await jobs.cancel(cwd, request.params.job_id); return record ? publicJobRecord(record) : reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id/logs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { return await jobs.logs(cwd, request.params.job_id) ?? reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.addHook("onClose", () => jobs.shutdown());
}
