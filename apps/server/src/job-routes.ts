import type { FastifyInstance } from "fastify";
import { JobCoordinator, type JobRequirement } from "./job-coordinator.js";
import { validateWorkspaceCwd } from "./workspace-security.js";

async function workspace(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  const query = request.query as Record<string, unknown>;
  try { return await validateWorkspaceCwd(typeof query.cwd === "string" && query.cwd ? query.cwd : "."); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

export function registerJobRoutes(app: FastifyInstance, jobs: JobCoordinator): void {
  app.post("/api/jobs/capabilities", async (request) => jobs.capabilities((request.body ?? {}) as JobRequirement));
  app.post("/api/jobs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { return await jobs.submit(cwd, (request.body ?? {}) as Record<string, unknown>); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.get("/api/jobs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; const q = request.query as { limit?: string }; return { jobs: await jobs.list(cwd, Math.min(1000, Math.max(1, Number(q.limit ?? 100)))) }; });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { return await jobs.get(cwd, request.params.job_id) ?? reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.delete<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { return await jobs.cancel(cwd, request.params.job_id) ?? reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id/logs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { return await jobs.logs(cwd, request.params.job_id) ?? reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.addHook("onClose", () => jobs.shutdown());
}
