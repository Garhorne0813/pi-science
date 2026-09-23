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
  app.post("/api/jobs/conversation", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 100_000) return reply.code(400).send({ error: "Invalid conversation command" });
    if (body.client_job_id !== undefined && (typeof body.client_job_id !== "string" || !/^job_[0-9a-f]{16}$/.test(body.client_job_id))) return reply.code(400).send({ error: "Invalid conversation job ID" });
    const timeout = body.timeout_seconds === undefined ? 3600 : Number(body.timeout_seconds);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) return reply.code(400).send({ error: "Invalid conversation timeout" });
    const command = process.platform === "win32"
      ? [requireWindowsShell()]
      : ["/bin/bash"];
    try {
      return publicJobRecord(await jobs.submit(cwd, { command, conversation_script: body.command, surface: "conversation", requirement: { timeout_seconds: timeout }, env: body.env, client_job_id: body.client_job_id }));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/jobs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; const q = request.query as { limit?: string }; return { jobs: (await jobs.list(cwd, Math.min(1000, Math.max(1, Number(q.limit ?? 100))))).map(publicJobRecord) }; });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { const record = await jobs.get(cwd, request.params.job_id); return record ? publicJobRecord(record) : reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.delete<{ Params: { job_id: string } }>("/api/jobs/:job_id", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { const record = await jobs.cancel(cwd, request.params.job_id); return record ? publicJobRecord(record) : reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id/logs", async (request, reply) => { const cwd = await workspace(request, reply); if (!cwd) return; try { return await jobs.logs(cwd, request.params.job_id) ?? reply.code(404).send({ error: "Job not found" }); } catch (error) { return reply.code(400).send({ error: String(error) }); } });
  app.get<{ Params: { job_id: string } }>("/api/jobs/:job_id/output", async (request, reply) => {
    const cwd = await workspace(request, reply); if (!cwd) return;
    const cursor = Number((request.query as { cursor?: string }).cursor ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return reply.code(400).send({ error: "Invalid output cursor" });
    try { return await jobs.outputSince(cwd, request.params.job_id, cursor) ?? reply.code(404).send({ error: "Job not found" }); }
    catch (error) { return reply.code(400).send({ error: String(error) }); }
  });
  app.addHook("onClose", () => jobs.shutdown());
}

function requireWindowsShell(): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
}
