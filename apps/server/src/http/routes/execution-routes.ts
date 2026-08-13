import type { FastifyInstance } from "fastify";
import { executionKindSchema, executionStatusSchema } from "@pi-science/contracts";
import { executionRepository } from "../../runtime/executions/execution-repository.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

async function workspace(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  const query = request.query as Record<string, unknown>;
  try { return await validateWorkspaceCwd(typeof query.cwd === "string" && query.cwd ? query.cwd : "."); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

export function registerExecutionRoutes(app: FastifyInstance): void {
  app.get("/api/executions", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const query = request.query as { limit?: string; session_id?: string; kind?: string; status?: string };
    const kind = query.kind ? executionKindSchema.safeParse(query.kind) : null;
    const status = query.status ? executionStatusSchema.safeParse(query.status) : null;
    if (kind && !kind.success) return reply.code(400).send({ error: "Invalid execution kind" });
    if (status && !status.success) return reply.code(400).send({ error: "Invalid execution status" });
    const executions = await executionRepository.list(cwd, {
      limit: Number(query.limit ?? 100),
      ...(query.session_id ? { session_id: query.session_id } : {}),
      ...(kind?.success ? { kind: kind.data } : {}),
      ...(status?.success ? { status: status.data } : {}),
    });
    return { executions };
  });

  app.get<{ Params: { execution_id: string } }>("/api/executions/:execution_id", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const execution = await executionRepository.get(cwd, request.params.execution_id);
    return execution ?? reply.code(404).send({ error: "Execution not found" });
  });

  app.get<{ Params: { execution_id: string } }>("/api/executions/:execution_id/logs", async (request, reply) => {
    const cwd = await workspace(request, reply);
    if (!cwd) return;
    const execution = await executionRepository.get(cwd, request.params.execution_id);
    if (!execution) return reply.code(404).send({ error: "Execution not found" });
    return {
      execution_id: execution.execution_id,
      stdout: String(execution.result.stdout_preview ?? ""),
      stderr: String(execution.result.stderr_preview ?? execution.result.error ?? ""),
    };
  });
}
