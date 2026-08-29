import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../../config/config.js";
import { executionRepository } from "../../runtime/executions/execution-repository.js";
import {
  diffWorkspaceSnapshots,
  snapshotWorkspace,
  type WorkspaceDiff,
} from "../../runtime/artifacts/workspace-artifact-snapshot.js";
import {
  publishWorkspaceArtifactsDetailed,
  type WorkspaceArtifactPublishFailure,
} from "../../runtime/artifacts/workspace-artifact-publisher.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import type { WorkspaceEnvironmentService } from "../../runtime/workspace/workspace-environment.js";
import type { KernelStreamEvent, NodeKernelManager } from "../../runtime/kernel/node-kernel-manager.js";

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
 * Executes cells with the Node-owned kernel manager: Node spawns the
 * project's kernel bridge directly, records execution evidence, and detects
 * files created or modified in the workspace. No Python worker round trip.
 */
export function registerKernelExecutionRoutes(app: FastifyInstance, config: ServerConfig, environments: WorkspaceEnvironmentService, kernels: NodeKernelManager): void {
  app.get("/api/kernels/status", async () => kernels.status());

  app.post("/api/kernels/shutdown-all", async () => {
    await kernels.shutdownAll();
    return { ok: true };
  });

  app.post("/api/kernels/:notebook_id/shutdown", async (request, reply) => {
    const notebookId = (request.params as { notebook_id?: unknown }).notebook_id;
    if (typeof notebookId !== "string" || !notebookId) return reply.code(400).send({ error: "Missing notebook id" });
    const cwdValue = (request.query as { cwd?: unknown }).cwd;
    let cwd: string | undefined;
    if (cwdValue !== undefined) {
      try { cwd = await validateWorkspaceCwd(String(cwdValue)); }
      catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    }
    const language = (request.query as { language?: unknown }).language;
    await kernels.shutdownNotebook(notebookId, cwd, language === undefined ? undefined : String(language));
    return { ok: true };
  });

  app.post("/api/kernels/:notebook_id/interrupt", async (request, reply) => {
    const notebookId = (request.params as { notebook_id?: unknown }).notebook_id;
    if (typeof notebookId !== "string" || !notebookId) return reply.code(400).send({ error: "Missing notebook id" });
    const cwdValue = (request.query as { cwd?: unknown }).cwd;
    if (cwdValue === undefined) return reply.code(400).send({ error: "Missing cwd" });
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(String(cwdValue)); }
    catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    const language = (request.query as { language?: unknown }).language;
    const interrupted = await kernels.interruptNotebook(notebookId, cwd, language === undefined ? undefined : String(language));
    return { ok: interrupted };
  });

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
        environment_prefix: environment.prefix,
        ...(body.kernel_instance_id ? { kernel_instance_id: body.kernel_instance_id } : {}),
      },
    });

    try {
      const result = await kernels.execute({
        language: body.language,
        code: body.code,
        cwd,
        environment,
        notebookId: body.notebook_id,
        sessionId: body.session_id,
        kernelInstanceId: body.kernel_instance_id,
        environmentRevisionId: environment.revision_id,
        timeoutMs: kernelTimeoutMs,
      });
      const after = await snapshotWorkspace(cwd);
      const diff = after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
      const outputEvidence = await publishKernelOutputs(cwd, diff, execution.execution_id, body, app.log);
      const error = result.error;
      await executionRepository.finish(cwd, execution.execution_id, {
        status: result.interrupted ? "interrupted" : result.ok ? "succeeded" : "failed",
        producer: "node-kernel-gateway",
        result: {
          ok: result.ok,
          http_status: 200,
          stdout_preview: preview(result.stdout),
          stderr_preview: preview(result.stderr),
          output_preview: preview(result.result),
          mime: result.mime,
          outputs: result.outputs ?? [],
          ...(error ? { error } : {}),
          ...(outputEvidence.failures.length > 0 ? { artifact_publish_errors: outputEvidence.failures } : {}),
        },
        files: { written: outputEvidence.written },
        artifacts: outputEvidence.artifacts,
      });
      return reply.send(withExecutionId({
        ...result,
        ...(outputEvidence.failures.length > 0 ? { artifact_publish_errors: outputEvidence.failures } : {}),
      }, execution.execution_id));
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "KernelTimeoutError";
      const message = timedOut ? "kernel timed out" : error instanceof Error ? error.message : "kernel unavailable";
      const after = await snapshotWorkspace(cwd);
      const diff = after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
      const outputEvidence = await publishKernelOutputs(cwd, diff, execution.execution_id, body, app.log);
      await executionRepository.finish(cwd, execution.execution_id, {
        status: timedOut ? "timed_out" : "failed",
        producer: "node-kernel-gateway",
        result: {
          ok: false,
          error: message,
          ...(outputEvidence.failures.length > 0 ? { artifact_publish_errors: outputEvidence.failures } : {}),
        },
        files: { written: outputEvidence.written },
        artifacts: outputEvidence.artifacts,
      });
      return reply.code(timedOut ? 504 : 500).send({ error: message, execution_id: execution.execution_id, request_id: request.id });
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
        environment_revision_id: environment.revision_id ?? "legacy-venv", environment_prefix: environment.prefix,
        ...(body.kernel_instance_id ? { kernel_instance_id: body.kernel_instance_id } : {}),
      },
    });

    reply.hijack();
    try {
      reply.raw.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", "x-pi-science-kernel": "node", "x-request-id": request.id });
      reply.raw.write(JSON.stringify({ type: "started", execution_id: execution.execution_id }) + "\n");
      const result = await kernels.execute({
        language: body.language,
        code: body.code,
        cwd,
        environment,
        notebookId: body.notebook_id,
        sessionId: body.session_id,
        kernelInstanceId: body.kernel_instance_id,
        environmentRevisionId: environment.revision_id,
        timeoutMs: kernelTimeoutMs,
        onEvent: (event: KernelStreamEvent) => {
          if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(event) + "\n");
        },
      });
      const after = await snapshotWorkspace(cwd);
      const diff = after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
      const outputEvidence = await publishKernelOutputs(cwd, diff, execution.execution_id, body, app.log);
      const error = result.error;
      await executionRepository.finish(cwd, execution.execution_id, {
        status: result.interrupted ? "interrupted" : result.ok ? "succeeded" : "failed",
        producer: "node-kernel-gateway",
        result: {
          ok: result.ok, http_status: 200, stdout_preview: preview(result.stdout), stderr_preview: preview(result.stderr), output_preview: preview(result.result),
          mime: result.mime, outputs: result.outputs ?? [], ...(error ? { error } : {}),
          ...(outputEvidence.failures.length > 0 ? { artifact_publish_errors: outputEvidence.failures } : {}),
        },
        files: { written: outputEvidence.written },
        artifacts: outputEvidence.artifacts,
      });
      if (!reply.raw.destroyed) {
        reply.raw.write(JSON.stringify({
          type: "result",
          ...result,
          ...(outputEvidence.failures.length > 0 ? { artifact_publish_errors: outputEvidence.failures } : {}),
          execution_id: execution.execution_id,
        }) + "\n");
        reply.raw.end();
      }
      return reply;
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "KernelTimeoutError";
      const message = timedOut ? "kernel timed out" : error instanceof Error ? error.message : "kernel unavailable";
      const after = await snapshotWorkspace(cwd);
      const diff = after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
      const outputEvidence = await publishKernelOutputs(cwd, diff, execution.execution_id, body, app.log);
      await executionRepository.finish(cwd, execution.execution_id, {
        status: timedOut ? "timed_out" : "failed",
        producer: "node-kernel-gateway",
        result: {
          ok: false,
          error: message,
          ...(outputEvidence.failures.length > 0 ? { artifact_publish_errors: outputEvidence.failures } : {}),
        },
        files: { written: outputEvidence.written },
        artifacts: outputEvidence.artifacts,
      });
      if (!reply.raw.destroyed) {
        reply.raw.write(JSON.stringify({
          type: "result",
          ok: false,
          error: message,
          ...(outputEvidence.failures.length > 0 ? { artifact_publish_errors: outputEvidence.failures } : {}),
          execution_id: execution.execution_id,
        }) + "\n");
        reply.raw.end();
      }
      return reply;
    }
  });
}

async function publishKernelOutputs(
  cwd: string,
  diff: WorkspaceDiff,
  executionId: string,
  body: z.infer<typeof executeCellRequestSchema>,
  logger?: { warn: (...args: any[]) => void },
): Promise<{
  written: Array<{
    path: string;
    detection: "snapshot";
    sha256?: string;
    artifact_id?: string;
    artifact_version?: number;
  }>;
  artifacts: Array<{ artifact_id: string; version: number; relation: "output" }>;
  failures: WorkspaceArtifactPublishFailure[];
}> {
  const entries = [...diff.created, ...diff.modified];
  const published = await publishWorkspaceArtifactsDetailed(cwd, entries.map((entry) => entry.path), {
    tool: "node-kernel-gateway",
    executionId,
    sessionId: body.session_id,
    source: body.source,
    notebookPath: body.notebook_path,
    cellId: body.cell_id,
    onFailure: (failure) => logger?.warn({
      execution_id: executionId,
      artifact_path: failure.path,
      artifact_error: failure.error,
      ...(failure.code ? { error_code: failure.code } : {}),
    }, "Kernel output artifact publication failed"),
  });
  const byPath = new Map(published.artifacts.map((artifact) => [artifact.path, artifact]));
  return {
    written: entries.map((entry) => {
      const artifact = byPath.get(entry.path);
      return {
        path: entry.path,
        detection: "snapshot" as const,
        ...(artifact ? {
          sha256: artifact.sha256,
          artifact_id: artifact.artifact_id,
          artifact_version: artifact.version,
        } : {}),
      };
    }),
    artifacts: published.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      version: artifact.version,
      relation: "output" as const,
    })),
    failures: published.failures,
  };
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
