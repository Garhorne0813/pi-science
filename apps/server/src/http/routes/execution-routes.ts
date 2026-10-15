import type { FastifyInstance } from "fastify";
import { executionKindSchema, executionListResponseSchema, executionRecordSchema, executionStatusSchema, executionLogResponseSchema } from "@pi-science/contracts";
import { executionRepository } from "../../runtime/executions/execution-repository.js";
import { subscribeExecutionEvents } from "../../runtime/executions/execution-events.js";
import type { JobCoordinator } from "../../runtime/jobs/job-coordinator.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

async function workspace(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  const query = request.query as Record<string, unknown>;
  try { return await validateWorkspaceCwd(typeof query.cwd === "string" && query.cwd ? query.cwd : "."); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

export function registerExecutionRoutes(app: FastifyInstance, jobs?: Pick<JobCoordinator, "logs">): void {
  app.get("/api/executions/events", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const push = (text: string) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(text);
    };
    push(": connected\n\n");
    const unsubscribe = subscribeExecutionEvents(cwd, (event) => push(`data: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => push(": ping\n\n"), 15_000);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    reply.raw.once("close", cleanup);
  });

  app.get("/api/executions", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const query = request.query as { limit?: string; offset?: string; target_id?: string; session_id?: string; kind?: string; status?: string; search?: string; from?: string; to?: string };
    const limit = Number(query.limit ?? 100);
    const offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000 || !Number.isInteger(offset) || offset < 0) {
      return reply.code(400).send({ error: "Invalid execution pagination" });
    }
    for (const value of [query.from, query.to]) {
      if (value !== undefined && !Number.isFinite(Date.parse(value))) return reply.code(400).send({ error: "Invalid execution time range" });
    }
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) return reply.code(400).send({ error: "Invalid execution time range" });
    const kind = query.kind ? executionKindSchema.safeParse(query.kind) : null;
    const status = query.status ? executionStatusSchema.safeParse(query.status) : null;
    if (kind && !kind.success) return reply.code(400).send({ error: "Invalid execution kind" });
    if (status && !status.success) return reply.code(400).send({ error: "Invalid execution status" });
    const page = await executionRepository.query(cwd, {
      limit, offset, target_id: query.target_id, search: query.search, from: query.from, to: query.to,
      ...(query.session_id ? { session_id: query.session_id } : {}),
      ...(kind?.success ? { kind: kind.data } : {}),
      ...(status?.success ? { status: status.data } : {}),
    });
    return executionListResponseSchema.parse(page);
  });

  app.get<{ Params: { execution_id: string } }>("/api/executions/:execution_id", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const execution = await executionRepository.get(cwd, request.params.execution_id);
    return execution ? executionRecordSchema.parse(execution) : reply.code(404).send({ error: "Execution not found" });
  });

  app.get<{ Params: { execution_id: string } }>("/api/executions/:execution_id/logs", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const execution = await executionRepository.get(cwd, request.params.execution_id);
    if (!execution) return reply.code(404).send({ error: "Execution not found" });
    const jobId = execution.kind === "job" ? execution.correlation.job_id : undefined;
    if (jobs && jobId) {
      const logs = await jobs.logs(cwd, jobId);
      if (logs) return executionLogResponseSchema.parse({
        execution_id: execution.execution_id,
        stdout: logs.stdout,
        stderr: logs.stderr,
        source: "job" as const,
        complete: !logs.stdout_truncated && !logs.stderr_truncated,
      });
    }
    return executionLogResponseSchema.parse({
      execution_id: execution.execution_id,
      stdout: [...new Set([execution.result.stdout_preview, execution.result.output_preview].filter(Boolean))].join("\n"),
      stderr: [...new Set([execution.result.stderr_preview, execution.result.error].filter(Boolean))].join("\n"),
      source: "preview" as const,
      complete: false,
    });
  });
}
