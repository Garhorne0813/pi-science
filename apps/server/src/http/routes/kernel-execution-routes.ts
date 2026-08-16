import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../../config/config.js";
import { executionRepository } from "../../runtime/executions/execution-repository.js";
import {
  diffWorkspaceSnapshots,
  snapshotWorkspace,
} from "../../runtime/artifacts/workspace-artifact-snapshot.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { WorkspaceEnvironmentService } from "../../runtime/workspace/workspace-environment.js";

const executeCellRequestSchema = z.object({
  language: z.enum(["python", "r"]),
  code: z.string(),
  notebook_id: z.string().optional().nullable(),
  session_id: z.string().min(1).optional().nullable(),
  environment_revision_id: z.string().min(1).optional().nullable(),
  kernel_instance_id: z.string().min(1).optional().nullable(),
  source: z.enum(["agent", "session_notebook", "file_notebook", "terminal"]).optional(),
  notebook_path: z.string().optional().nullable(),
  cell_id: z.string().optional().nullable(),
  timeout_seconds: z.number().min(1).max(600).optional(),
});

const MAX_RECORDED_CODE_CHARS = 64 * 1024;
const MAX_RESULT_PREVIEW_CHARS = 16 * 1024;

/**
 * Wraps the Python-owned kernel endpoint with Node-owned execution evidence.
 * The scientific runtime still executes the cell; this route only records its
 * lifecycle and detects files created or modified in the workspace.
 */
export function registerKernelExecutionRoutes(app: FastifyInstance, config: ServerConfig, environments: WorkspaceEnvironmentService): void {
  app.post("/api/kernels/execute", async (request, reply) => {
    const parsed = executeCellRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid kernel execution request" });

    const cwdValue = String((request.query as { cwd?: unknown }).cwd ?? ".");
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(cwdValue);
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }

    const body = parsed.data;
    const environment = await environments.ensure(cwd);
    if (body.environment_revision_id && environment.revision_id !== body.environment_revision_id) {
      return reply.code(409).send({ error: "Requested environment revision is not bound to this workspace" });
    }
    const kernelTimeoutMs = Math.max(config.upstreamTimeoutMs, (body.timeout_seconds ?? 120) * 1_000 + 5_000);
    const code = body.code.length <= MAX_RECORDED_CODE_CHARS
      ? body.code
      : body.code.slice(0, MAX_RECORDED_CODE_CHARS);
    const before = await snapshotWorkspace(cwd);
    const execution = await executionRepository.start(cwd, {
      kind: "kernel_cell",
      surface: body.language,
      producer: "node-kernel-gateway",
      correlation: {
        request_id: request.id,
        ...(body.session_id ? { session_id: body.session_id } : {}),
      },
      request: {
        language: body.language,
        notebook_id: body.notebook_id ?? "default",
        code,
        code_sha256: createHash("sha256").update(body.code).digest("hex"),
        code_truncated: code.length !== body.code.length,
        timeout_seconds: body.timeout_seconds ?? 120,
        source: body.source ?? "agent",
        ...(body.notebook_path ? { notebook_path: body.notebook_path } : {}),
        ...(body.cell_id ? { cell_id: body.cell_id } : {}),
      },
      runtime: {
        cwd,
        gateway_timeout_ms: kernelTimeoutMs,
        environment_id: environment.environment_id ?? "legacy-venv",
        environment_revision_id: environment.revision_id ?? "legacy-venv",
        environment_prefix: environment.virtual_env,
        ...(body.kernel_instance_id ? { kernel_instance_id: body.kernel_instance_id } : {}),
      },
    });

    const upstreamUrl = new URL("/api/kernels/execute", config.pythonOrigin);
    upstreamUrl.searchParams.set("cwd", cwd);
    // A cell's declared execution timeout can be longer than the gateway's
    // general-purpose proxy timeout. Give the kernel a small response buffer so
    // the gateway does not abort a valid long-running cell prematurely.
    try {
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": request.id,
          ...(config.internalToken ? { "x-pi-science-internal-token": config.internalToken } : {}),
        },
        body: JSON.stringify({
          language: body.language,
          code: body.code,
          notebook_id: body.notebook_id,
          session_id: body.session_id,
          environment_revision_id: environment.revision_id ?? "legacy-venv",
          environment_prefix: environment.virtual_env,
          kernel_instance_id: body.kernel_instance_id,
          timeout_seconds: body.timeout_seconds,
        }),
        signal: AbortSignal.timeout(kernelTimeoutMs),
      });
      const responseBody = await parseResponseBody(upstream);
      const after = await snapshotWorkspace(cwd);
      const diff = after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
      const written = after
        ? [...diff.created, ...diff.modified]
          .map((entry) => ({ path: entry.path, detection: "snapshot" as const }))
        : [];
      const responseObject = objectValue(responseBody);
      const kernelSucceeded = upstream.ok && responseObject.ok !== false;
      const kernelInterrupted = responseObject.interrupted === true;
      const error = errorMessage(responseBody);
      await executionRepository.finish(cwd, execution.execution_id, {
        status: kernelInterrupted ? "interrupted" : kernelSucceeded ? "succeeded" : "failed",
        producer: "node-kernel-gateway",
        result: {
          ok: kernelSucceeded,
          http_status: upstream.status,
          stdout_preview: preview(responseObject.stdout),
          output_preview: preview(responseObject.result),
          mime: objectValue(responseObject.mime),
          ...(error ? { error } : {}),
        },
        files: { written },
      });

      reply.header("x-pi-science-upstream", "python");
      return reply.code(upstream.status).send(withExecutionId(responseBody, execution.execution_id));
    } catch (error) {
      const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      const message = timedOut ? "scientific runtime timed out" : "scientific runtime unavailable";
      const after = await snapshotWorkspace(cwd);
      const diff = after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
      await executionRepository.finish(cwd, execution.execution_id, {
        status: timedOut ? "timed_out" : "failed",
        producer: "node-kernel-gateway",
        result: { ok: false, error: message },
        files: {
          written: [...diff.created, ...diff.modified].map((entry) => ({ path: entry.path, detection: "snapshot" })),
        },
      });
      return reply.code(504).send({ error: message, execution_id: execution.execution_id, request_id: request.id });
    }
  });

  app.post("/api/kernels/execute-stream", async (request, reply) => {
    const parsed = executeCellRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid kernel execution request" });
    const cwdValue = String((request.query as { cwd?: unknown }).cwd ?? ".");
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }

    const body = parsed.data;
    const environment = await environments.ensure(cwd);
    if (body.environment_revision_id && environment.revision_id !== body.environment_revision_id) {
      return reply.code(409).send({ error: "Requested environment revision is not bound to this workspace" });
    }
    const kernelTimeoutMs = Math.max(config.upstreamTimeoutMs, (body.timeout_seconds ?? 120) * 1_000 + 5_000);
    const code = body.code.slice(0, MAX_RECORDED_CODE_CHARS);
    const before = await snapshotWorkspace(cwd);
    const execution = await executionRepository.start(cwd, {
      kind: "kernel_cell",
      surface: body.language,
      producer: "node-kernel-gateway",
      correlation: { request_id: request.id, ...(body.session_id ? { session_id: body.session_id } : {}) },
      request: {
        language: body.language, notebook_id: body.notebook_id ?? "default", code,
        code_sha256: createHash("sha256").update(body.code).digest("hex"), code_truncated: code.length !== body.code.length,
        timeout_seconds: body.timeout_seconds ?? 120, source: body.source ?? "agent",
        ...(body.notebook_path ? { notebook_path: body.notebook_path } : {}), ...(body.cell_id ? { cell_id: body.cell_id } : {}),
      },
      runtime: {
        cwd, gateway_timeout_ms: kernelTimeoutMs, environment_id: environment.environment_id ?? "legacy-venv",
        environment_revision_id: environment.revision_id ?? "legacy-venv", environment_prefix: environment.virtual_env,
        ...(body.kernel_instance_id ? { kernel_instance_id: body.kernel_instance_id } : {}),
      },
    });

    let streaming = false;
    try {
      const upstreamUrl = new URL("/api/kernels/execute-stream", config.pythonOrigin);
      upstreamUrl.searchParams.set("cwd", cwd);
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": request.id, ...(config.internalToken ? { "x-pi-science-internal-token": config.internalToken } : {}) },
        body: JSON.stringify({
          language: body.language, code: body.code, notebook_id: body.notebook_id, session_id: body.session_id,
          environment_revision_id: environment.revision_id ?? "legacy-venv", environment_prefix: environment.virtual_env,
          kernel_instance_id: body.kernel_instance_id, timeout_seconds: body.timeout_seconds,
        }),
        signal: AbortSignal.timeout(kernelTimeoutMs),
      });
      if (!upstream.ok || !upstream.body) throw new Error(`scientific runtime returned HTTP ${upstream.status}`);

      reply.hijack();
      streaming = true;
      reply.raw.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", "x-pi-science-upstream": "python", "x-request-id": request.id });
      reply.raw.write(JSON.stringify({ type: "started", execution_id: execution.execution_id }) + "\n");
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: Record<string, unknown> | null = null;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = objectValue(JSON.parse(line));
          if (event.type === "result") finalResult = event;
          else if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(event) + "\n");
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const event = objectValue(JSON.parse(buffer));
        if (event.type === "result") finalResult = event;
      }
      finalResult ??= { type: "result", ok: false, error: "scientific runtime ended without a result" };
      const after = await snapshotWorkspace(cwd);
      const diff = after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
      const interrupted = finalResult.interrupted === true;
      const succeeded = finalResult.ok !== false;
      const error = errorMessage(finalResult);
      await executionRepository.finish(cwd, execution.execution_id, {
        status: interrupted ? "interrupted" : succeeded ? "succeeded" : "failed",
        producer: "node-kernel-gateway",
        result: {
          ok: succeeded, http_status: upstream.status, stdout_preview: preview(finalResult.stdout), output_preview: preview(finalResult.result),
          mime: objectValue(finalResult.mime), ...(error ? { error } : {}),
        },
        files: { written: [...diff.created, ...diff.modified].map((entry) => ({ path: entry.path, detection: "snapshot" })) },
      });
      if (!reply.raw.destroyed) {
        reply.raw.write(JSON.stringify({ ...finalResult, execution_id: execution.execution_id }) + "\n");
        reply.raw.end();
      }
      return reply;
    } catch (error) {
      const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      const message = timedOut ? "scientific runtime timed out" : error instanceof Error ? error.message : "scientific runtime unavailable";
      await executionRepository.finish(cwd, execution.execution_id, { status: timedOut ? "timed_out" : "failed", producer: "node-kernel-gateway", result: { ok: false, error: message } });
      if (streaming) {
        if (!reply.raw.destroyed) { reply.raw.write(JSON.stringify({ type: "result", ok: false, error: message, execution_id: execution.execution_id }) + "\n"); reply.raw.end(); }
        return reply;
      }
      return reply.code(504).send({ error: message, execution_id: execution.execution_id, request_id: request.id });
    }
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { error: text }; }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function withExecutionId(value: unknown, executionId: string): Record<string, unknown> {
  return { ...objectValue(value), execution_id: executionId };
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, MAX_RESULT_PREVIEW_CHARS);
}

function errorMessage(value: unknown): string | undefined {
  const object = objectValue(value);
  const error = object.error ?? object.detail;
  return error === null || error === undefined ? undefined : preview(error);
}
