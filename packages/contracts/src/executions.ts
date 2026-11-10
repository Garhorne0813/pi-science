import { z } from "zod";

export const executionKindSchema = z.enum([
  "tool",
  "kernel_cell",
  "job",
  "research_agent",
  "research_evaluation",
]);

export const executionSurfaceSchema = z.enum([
  "pi",
  "python",
  "r",
  "local",
  "ssh",
  "hpc",
  "research",
]);

export const executionStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "lost",
]);

export const executionEventTypeSchema = z.enum([
  "execution.started",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
  "execution.interrupted",
  "execution.reconciled",
]);

export const executionCorrelationSchema = z
  .object({
    session_id: z.string().optional(),
    turn_id: z.string().optional(),
    message_id: z.string().optional(),
    tool_call_id: z.string().optional(),
    job_id: z.string().optional(),
    run_id: z.string().optional(),
    operation_id: z.string().optional(),
    loop_id: z.string().optional(),
    candidate_id: z.string().optional(),
    parent_execution_id: z.string().optional(),
    request_id: z.string().optional(),
  })
  .default({});

export const executionFileEvidenceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().optional(),
  artifact_id: z.string().optional(),
  artifact_version: z.number().int().positive().optional(),
  detection: z.enum(["explicit", "snapshot", "runtime_audit", "declared"]),
});

export const executionArtifactRefSchema = z.object({
  artifact_id: z.string().min(1),
  version: z.number().int().positive(),
  relation: z.enum(["input", "output"]),
});

export const executionEventSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().min(1),
  execution_id: z.string().min(1),
  sequence: z.number().int().positive(),
  event_type: executionEventTypeSchema,
  kind: executionKindSchema,
  surface: executionSurfaceSchema,
  workspace_id: z.string().min(1),
  created_at: z.string(),
  producer: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const executionRequestSchema = z
  .object({
    tool: z.string().optional(),
    command: z.array(z.string()).optional(),
    notebook_id: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough()
  .default({});

const executionResultSchema = z
  .object({
    stdout_preview: z.string().optional(),
    stderr_preview: z.string().optional(),
    output_preview: z.string().optional(),
    error: z.string().optional(),
    exit_code: z.number().int().nullable().optional(),
  })
  .passthrough()
  .default({});

export const executionRecordSchema = z.object({
  schema_version: z.literal(1),
  execution_id: z.string().min(1),
  kind: executionKindSchema,
  surface: executionSurfaceSchema,
  status: executionStatusSchema,
  workspace_id: z.string().min(1),
  created_at: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  producer: z.string().min(1),
  correlation: executionCorrelationSchema,
  request: executionRequestSchema,
  runtime: z.record(z.string(), z.unknown()).default({}),
  result: executionResultSchema,
  files: z
    .object({
      read: z.array(executionFileEvidenceSchema).default([]),
      written: z.array(executionFileEvidenceSchema).default([]),
    })
    .default({ read: [], written: [] }),
  artifacts: z.array(executionArtifactRefSchema).default([]),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const executionListResponseSchema = z.object({
  executions: z.array(executionRecordSchema).default([]),
  total: z.number().int().nonnegative().optional(),
  filtered_total: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  status_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  completed_duration_ms: z.number().nonnegative().optional(),
  completed_duration_count: z.number().int().nonnegative().optional(),
  target_offset: z.number().int().nonnegative().nullable().optional(),
  target_in_scope: z.boolean().optional(),
  target_matches: z.boolean().optional(),
});

export const executionLogResponseSchema = z.object({
  execution_id: z.string().min(1).optional(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  source: z.enum(["job", "preview"]).optional(),
  complete: z.boolean().default(false),
});

export type ExecutionKind = z.infer<typeof executionKindSchema>;
export type ExecutionSurface = z.infer<typeof executionSurfaceSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type ExecutionEventType = z.infer<typeof executionEventTypeSchema>;
export type ExecutionCorrelation = z.infer<typeof executionCorrelationSchema>;
export type ExecutionFileEvidence = z.infer<typeof executionFileEvidenceSchema>;
export type ExecutionArtifactRef = z.infer<typeof executionArtifactRefSchema>;
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
