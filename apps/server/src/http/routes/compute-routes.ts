/**
 * Agent-facing remote compute endpoints. The global internal-token hook
 * authenticates the worker; workspace membership is validated per request.
 * Every mutating call also appends a provenance record so remote runs are
 * traceable from the conversation that produced them.
 */
import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { RemoteComputeError, remoteComputeService, type RemoteExecuteResult, type SlurmCheckResult, type SlurmSubmitResult } from "../../runtime/compute/remote-compute-service.js";
import { recordProvenance } from "./artifact-routes.js";

function q(request: { query: unknown }, key: string, fallback = "."): string {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : fallback;
}

async function ws(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> {
  try { return await validateWorkspaceCwd(q(request, "cwd")); }
  catch (error) { reply.code(403).send({ error: String(error) }); return null; }
}

export function registerComputeRoutes(app: FastifyInstance, service = remoteComputeService): void {
  app.post("/api/compute/execute", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(new Error("Remote compute client disconnected")); };
    reply.raw.once("close", disconnect);
    try {
      const result: RemoteExecuteResult = await service.execute(cwd, {
        machine_label: String(body.machine_label ?? ""),
        command: String(body.command ?? ""),
        timeout_seconds: Number(body.timeout_seconds ?? 300) || 300,
        session_id: typeof body.session_id === "string" ? body.session_id : undefined,
        tool_call_id: typeof body.tool_call_id === "string" ? body.tool_call_id : undefined,
        operation_id: typeof body.operation_id === "string" ? body.operation_id : undefined,
        signal: controller.signal,
      });
      await recordProvenance(cwd, {
        path: `remote:${result.machine.label}:${result.execution_id}`,
        tool: "remote_execute",
        session_id: body.session_id,
        content: `remote_execute exit=${result.exitCode ?? "null"} duration_ms=${result.durationMs} truncated=${result.stdoutTruncated}`,
        execution_id: result.execution_id,
      });
      return result;
    } catch (error) {
      if (error instanceof RemoteComputeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    } finally {
      reply.raw.removeListener("close", disconnect);
    }
  });

  app.post("/api/compute/slurm-submit", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(new Error("Remote compute client disconnected")); };
    reply.raw.once("close", disconnect);
    try {
      const result: SlurmSubmitResult = await service.slurmSubmit(cwd, {
        machine_label: String(body.machine_label ?? ""),
        script: String(body.script ?? ""),
        name: typeof body.name === "string" ? body.name : undefined,
        session_id: typeof body.session_id === "string" ? body.session_id : undefined,
        tool_call_id: typeof body.tool_call_id === "string" ? body.tool_call_id : undefined,
        operation_id: typeof body.operation_id === "string" ? body.operation_id : undefined,
        signal: controller.signal,
      });
      await recordProvenance(cwd, {
        path: `slurm:${result.machine.label}:${result.job_id}`,
        tool: "slurm_submit",
        session_id: body.session_id,
        content: `slurm job ${result.job_id} submitted to ${result.machine.label}; output=${result.output_path} error=${result.error_path}`,
        execution_id: result.execution_id,
      });
      return result;
    } catch (error) {
      if (error instanceof RemoteComputeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    } finally {
      reply.raw.removeListener("close", disconnect);
    }
  });

  app.post("/api/compute/slurm-check", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const cwd = await ws(request, reply); if (!cwd) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const result: SlurmCheckResult = await service.slurmCheck(cwd, {
        machine_label: String(body.machine_label ?? ""),
        job_id: String(body.job_id ?? ""),
        include_output: body.include_output !== false,
      });
      return result;
    } catch (error) {
      if (error instanceof RemoteComputeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
