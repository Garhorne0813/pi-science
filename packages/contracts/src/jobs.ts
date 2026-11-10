import { z } from "zod";

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.array(z.string()).optional(),
  }),
  request_id: z.string(),
});
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
export const jobRequirementSchema = z
  .object({
    cpu: z.number().positive().optional(),
    memory_mb: z.number().positive().optional(),
    gpu: z.boolean().optional(),
    runtime: z.string().optional(),
    packages: z.array(z.string()).optional(),
    environment_revision_id: z.string().optional(),
    environment_revision: z.string().optional(),
    timeout_seconds: z.number().positive().optional(),
  })
  .passthrough();
export const jobSubmitRequestSchema = z
  .object({
    command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    requirement: jobRequirementSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    surface: z.string().optional(),
    execution_cwd: z.string().optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .passthrough();
export const jobListQuerySchema = z.object({
  cwd: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export const jobParamsSchema = z.object({ job_id: z.string().regex(/^job_[A-Za-z0-9]{16}$/) });
// The unversioned prompt route retains its no-ID compatibility branch.
export const promptSubmissionRequestSchema = z.object({
  message: z.string().min(1),
  client_message_id: z.uuidv4(),
});
export const legacyPromptSubmissionRequestSchema = promptSubmissionRequestSchema.partial({
  client_message_id: true,
});
export const approvalInteractionRequestSchema = z.object({
  cancelled: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  value: z.unknown().optional(),
  alwaysAllow: z.boolean().optional(),
});

export const jobRecordSchema = z
  .object({
    job_id: z.string().min(1),
    status: z.enum([
      "queued",
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
    ]),
    created_at: z.string(),
    updated_at: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type JobRecord = z.infer<typeof jobRecordSchema>;
