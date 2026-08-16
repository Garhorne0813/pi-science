import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ScheduledTaskCoordinatorProvider } from "../../scheduled-tasks/coordinator-manager.js";
import { ScheduledTaskRepository } from "../../scheduled-tasks/repository.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

const RUN_LOG_TAIL_CHARS = 8000;

async function workspace(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  const query = request.query as Record<string, unknown>;
  try { return await validateWorkspaceCwd(typeof query.cwd === "string" && query.cwd ? query.cwd : "."); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Coordinator failures are client errors (400); a missing task surfaces as
 *  404 instead so the UI can distinguish "gone" from "bad request". The
 *  "[non-retryable]" run-failure prefix is passed through unchanged. */
function errorStatus(error: unknown): number {
  return error instanceof Error && /not found/.test(error.message) ? 404 : 400;
}

async function logTail(repository: ScheduledTaskRepository, runId: string): Promise<string> {
  try {
    const content = await readFile(repository.logPath(runId), "utf8");
    return content.length > RUN_LOG_TAIL_CHARS ? content.slice(-RUN_LOG_TAIL_CHARS) : content;
  } catch { return ""; }
}

export function registerScheduledTaskRoutes(
  app: FastifyInstance,
  coordinators: ScheduledTaskCoordinatorProvider,
  options: { log?: (line: string) => void } = {},
): void {
  app.get("/api/scheduled-tasks", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    try { return { tasks: await coordinators.coordinatorFor(cwd).list() }; }
    catch (error) { return reply.code(400).send({ error: messageOf(error) }); }
  });

  app.post("/api/scheduled-tasks", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    try { return reply.code(201).send(await coordinators.coordinatorFor(cwd).create(request.body ?? {})); }
    catch (error) { return reply.code(400).send({ error: messageOf(error) }); }
  });

  app.get<{ Params: { task_id: string } }>("/api/scheduled-tasks/:task_id", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    try {
      const task = await coordinators.coordinatorFor(cwd).get(request.params.task_id);
      return task ?? reply.code(404).send({ error: "Scheduled task not found" });
    } catch (error) { return reply.code(400).send({ error: messageOf(error) }); }
  });

  app.patch<{ Params: { task_id: string } }>("/api/scheduled-tasks/:task_id", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    try { return await coordinators.coordinatorFor(cwd).update(request.params.task_id, request.body ?? {}); }
    catch (error) { return reply.code(errorStatus(error)).send({ error: messageOf(error) }); }
  });

  app.delete<{ Params: { task_id: string } }>("/api/scheduled-tasks/:task_id", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    try { await coordinators.coordinatorFor(cwd).delete(request.params.task_id); return { ok: true }; }
    catch (error) { return reply.code(errorStatus(error)).send({ error: messageOf(error) }); }
  });

  app.post<{ Params: { task_id: string } }>("/api/scheduled-tasks/:task_id/run", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    options.log?.(`manual scheduled-task run ${request.params.task_id} (${cwd})`);
    try { return await coordinators.coordinatorFor(cwd).run(request.params.task_id, "manual"); }
    catch (error) { return reply.code(errorStatus(error)).send({ error: messageOf(error) }); }
  });

  app.post<{ Params: { task_id: string } }>("/api/scheduled-tasks/:task_id/approve", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const body = (request.body ?? {}) as { categories?: unknown };
    const categories = Array.isArray(body.categories) ? body.categories as string[] : [];
    try { return await coordinators.coordinatorFor(cwd).approve(request.params.task_id, { categories }); }
    catch (error) { return reply.code(errorStatus(error)).send({ error: messageOf(error) }); }
  });

  app.get<{ Params: { task_id: string } }>("/api/scheduled-tasks/:task_id/runs", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    try {
      const coordinator = coordinators.coordinatorFor(cwd);
      const task = await coordinator.get(request.params.task_id);
      if (!task) return reply.code(404).send({ error: "Scheduled task not found" });
      return { runs: await new ScheduledTaskRepository(cwd).listRuns(request.params.task_id, 100) };
    } catch (error) { return reply.code(400).send({ error: messageOf(error) }); }
  });

  app.get<{ Params: { task_id: string; run_id: string } }>("/api/scheduled-tasks/:task_id/runs/:run_id", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    try {
      const repository = new ScheduledTaskRepository(cwd);
      const run = await repository.getRun(request.params.run_id);
      if (!run || run.task_id !== request.params.task_id) return reply.code(404).send({ error: "Scheduled task run not found" });
      return { ...run, log_tail: await logTail(repository, run.run_id) };
    } catch (error) { return reply.code(400).send({ error: messageOf(error) }); }
  });
}
