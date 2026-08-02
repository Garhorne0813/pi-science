import { z } from "zod";

export const piConfigSchema = z.object({
  model: z.string().nullish(),
  provider: z.string().nullish(),
  api_key: z.string().nullish(),
  thinking: z.string().nullish(),
  compaction_enabled: z.boolean().optional(),
  compaction_threshold_percent: z.number().min(50).max(95).optional(),
  model_context_window: z.number().int().positive().optional(),
  skills: z.array(z.string()).default([]),
  extensions: z.array(z.string()).default([]),
});

export const createSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  config: piConfigSchema.default({ skills: [], extensions: [] }),
});

export const createSessionResponseSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  project_id: z.string().min(1).optional(),
});

export const sessionInfoSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  project_id: z.string().min(1).nullish(),
});

export const sessionStateSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  is_streaming: z.boolean(),
  is_compacting: z.boolean(),
  pending_message_count: z.number().int().nonnegative(),
  model: z.string().nullish(),
  thinking: z.string().nullish(),
  context_tokens: z.number().int().nonnegative().nullable().optional(),
  context_window: z.number().int().positive().nullable().optional(),
  context_percent: z.number().nonnegative().nullable().optional(),
  compaction_enabled: z.boolean().optional(),
  compaction_threshold_percent: z.number().min(0).max(100).nullable().optional(),
});

export const historyMessageSchema = z.object({
  id: z.string().min(1),
  role: z.string(),
  content: z.array(z.record(z.string(), z.unknown())),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  timestamp: z.string().nullish(),
});

export const sessionMessagePageSchema = z.object({
  messages: z.array(historyMessageSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  snapshot_version: z.string(),
});

export const workspaceInfoSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  project_id: z.string().min(1).optional(),
  session_count: z.number().int().nonnegative().default(0),
  last_modified: z.string().default(""),
});

export const fileListEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  isDir: z.boolean(),
  size: z.number().nonnegative(),
  modified: z.number(),
});

export const tokenUsageSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
}).passthrough();

const textUpdatedEventSchema = z.object({
  type: z.literal("text.updated"),
  sessionId: z.string(),
  partId: z.string(),
  text: z.string(),
});

const toolUpdatedEventSchema = z.object({
  type: z.literal("tool.updated"),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  status: z.enum(["running", "done", "error", "waiting-approval"]),
  title: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  partialOutput: z.string().optional(),
  diff: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  childSessionId: z.string().optional(),
});

const sessionIdleEventSchema = z.object({ type: z.literal("session.idle"), sessionId: z.string() });
const sessionErrorEventSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string().optional(),
  message: z.string(),
  terminal: z.boolean().optional(),
});

export const sessionEventSchema = z.discriminatedUnion("type", [
  textUpdatedEventSchema,
  toolUpdatedEventSchema,
  sessionIdleEventSchema,
  sessionErrorEventSchema,
]).and(z.looseObject({}));

export const piRpcCommandSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
}).passthrough();

export const piRpcResponseSchema = z.object({
  id: z.string().min(1),
  success: z.boolean().optional(),
}).passthrough();

export const piRuntimeEventSchema = z.object({
  type: z.string().min(1),
}).passthrough();

export const jobRecordSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["queued", "pending", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  created_at: z.string(),
  updated_at: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export const artifactManifestSchema = z.object({
  artifact_id: z.string().min(1),
  version: z.number().int().positive(),
  path: z.string().min(1),
  kind: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(16).max(64),
  published_at: z.string(),
}).passthrough();

export const provenanceRecordSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  actor: z.string().min(1),
  created_at: z.string(),
}).passthrough();

export const scientificRuntimeHealthSchema = z.object({
  status: z.literal("ok"),
  active_pi_processes: z.number().int().nonnegative(),
  active_kernels: z.number().int().nonnegative(),
});

export const gatewayHealthSchema = scientificRuntimeHealthSchema.extend({
  service: z.literal("pi-science-server"),
  control_plane: z.literal("node"),
  scientific_runtime: z.enum(["idle", "starting", "ready", "stopping", "failed", "external"]),
});

export type GatewayHealth = z.infer<typeof gatewayHealthSchema>;
export type PiConfig = z.infer<typeof piConfigSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type HistoryMessage = z.infer<typeof historyMessageSchema>;
export type SessionMessagePage = z.infer<typeof sessionMessagePageSchema>;
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;
export type FileListEntry = z.infer<typeof fileListEntrySchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type PiRpcCommand = z.infer<typeof piRpcCommandSchema>;
export type PiRpcResponse = z.infer<typeof piRpcResponseSchema>;
export type PiRuntimeEvent = z.infer<typeof piRuntimeEventSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;

// ── Durable subagent research loops ────────────────────────────────

export const researchMetricSchema = z.object({
  name: z.string().min(1).max(120),
  direction: z.enum(["maximize", "minimize"]),
  weight: z.number().finite().default(1),
  source: z.enum(["deterministic", "llm_judged"]).default("deterministic"),
});

export const evaluatorRefSchema = z.object({
  evaluator_id: z.string().min(1).max(120),
  version: z.number().int().positive(),
  digest: z.string().min(8).max(128),
});

export const evaluatorSpecSchema = evaluatorRefSchema.extend({
  status: z.enum(["draft", "approved", "deprecated"]).default("draft"),
  metrics: z.array(researchMetricSchema).min(1),
  hard_checks: z.array(z.string().min(1).max(120)).default([]),
  command: z.array(z.string().min(1)).min(1).default(["builtin:result-json"]),
  created_at: z.string().optional(),
});

export const researchBudgetSchema = z.object({
  max_candidates: z.number().int().min(1).max(10_000).default(20),
  max_wall_seconds: z.number().int().min(1).max(31_536_000).default(7200),
  max_model_tokens: z.number().int().positive().nullable().optional(),
  max_cost_usd: z.number().nonnegative().nullable().optional(),
  max_parallel: z.literal(1).default(1),
});

export const researchStopConditionsSchema = z.object({
  target_metrics: z.record(z.string(), z.number().finite()).default({}),
  patience: z.number().int().min(1).max(10_000).default(5),
  min_improvement: z.number().nonnegative().default(0),
});

export const researchLoopStatusSchema = z.enum([
  "draft", "ready", "running", "pausing", "paused", "cancelling",
  "completed", "failed", "cancelled", "needs_attention",
]);

export const researchTaskTypeSchema = z.enum([
  "research_loop", "optimize", "compare", "evaluate", "reproduce",
]);

export const researchLoopSchema = z.object({
  schema_version: z.literal(2).default(2),
  loop_id: z.string().min(1),
  revision: z.number().int().nonnegative().default(0),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(4000),
  task_type: researchTaskTypeSchema.default("research_loop"),
  status: researchLoopStatusSchema,
  mode: z.literal("serial").default("serial"),
  evaluator_ref: evaluatorRefSchema.nullable().default(null),
  budget: researchBudgetSchema,
  stop_conditions: researchStopConditionsSchema,
  constraints: z.array(z.string().max(1000)).max(100).default([]),
  created_by: z.string().default("user"),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable().default(null),
  active_wall_ms: z.number().int().nonnegative().default(0),
  stop_reason: z.string().nullable().default(null),
  current_operation_id: z.string().nullable().default(null),
});

export const createResearchLoopSchema = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(4000),
  task_type: researchTaskTypeSchema.default("research_loop"),
  evaluator_ref: evaluatorRefSchema.nullable().optional(),
  budget: researchBudgetSchema.partial().optional(),
  stop_conditions: researchStopConditionsSchema.partial().optional(),
  constraints: z.array(z.string().max(1000)).max(100).default([]),
  created_by: z.string().default("user"),
});

export const candidateProposalSchema = z.object({
  approach_summary: z.string().min(1).max(4000),
  rationale: z.string().max(8000).default(""),
  files: z.record(z.string(), z.string()).refine(
    (files) => Object.keys(files).length > 0 && Object.keys(files).length <= 100,
    "files must contain 1-100 entries",
  ),
  entrypoint: z.string().min(1).max(500).default("solve.sh"),
  parent_candidate_ids: z.array(z.string()).max(100).default([]),
  expected_artifacts: z.array(z.object({ path: z.string(), kind: z.string().default("data") })).default([]),
});

export const metricValueSchema = z.object({
  value: z.number().finite(),
  direction: z.enum(["maximize", "minimize"]),
  source: z.enum(["deterministic", "llm_judged"]).default("deterministic"),
});

export const candidateEvaluationSchema = z.object({
  metrics: z.record(z.string(), metricValueSchema).default({}),
  hard_checks: z.record(z.string(), z.enum(["passed", "failed"])).default({}),
  artifact_refs: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().min(16).max(128).optional(),
    kind: z.string().default("data"),
  })).default([]),
  findings: z.array(z.record(z.string(), z.unknown())).default([]),
  model_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
});

export const researchAgentResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("candidate"), proposal: candidateProposalSchema }),
  z.object({
    kind: z.literal("analysis"),
    findings: z.array(z.record(z.string(), z.unknown())).default([]),
    next_strategy: z.string().max(8000).default(""),
  }),
]);

export type ResearchMetric = z.infer<typeof researchMetricSchema>;
export type EvaluatorRef = z.infer<typeof evaluatorRefSchema>;
export type EvaluatorSpec = z.infer<typeof evaluatorSpecSchema>;
export type ResearchBudget = z.infer<typeof researchBudgetSchema>;
export type ResearchStopConditions = z.infer<typeof researchStopConditionsSchema>;
export type ResearchLoopStatus = z.infer<typeof researchLoopStatusSchema>;
export type ResearchTaskType = z.infer<typeof researchTaskTypeSchema>;
export type ResearchLoop = z.infer<typeof researchLoopSchema>;
export type CreateResearchLoop = z.infer<typeof createResearchLoopSchema>;
export type CandidateProposal = z.infer<typeof candidateProposalSchema>;
export type CandidateEvaluation = z.infer<typeof candidateEvaluationSchema>;
export type ResearchAgentResult = z.infer<typeof researchAgentResultSchema>;

// ── Skill catalog contracts (aligned with backend/models/skill.py) ──

export const skillThirdPartySchema = z.object({
  kind: z.enum(["weights", "service", "dataset", "library", "other"]).default("other"),
  name: z.string().min(1).max(200),
  provider: z.string().max(200).nullish(),
  license: z.string().max(120).nullish(),
  terms_url: z.string().nullish(),
  info_url: z.string().nullish(),
  privacy_url: z.string().nullish(),
}).passthrough();

export const skillRequirementSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["command", "python", "node", "r", "gpu", "package", "service", "other"]).default("other"),
  version: z.string().max(120).nullish(),
  optional: z.boolean().default(false),
  description: z.string().max(500).nullish(),
}).passthrough();

export const skillMetadataSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/),
  description: z.string().min(1).max(4000),
  version: z.string().max(80).default("0.1.0"),
  license: z.string().max(120).default("Apache-2.0"),
  category: z.string().max(80).default("general"),
  requirements: z.array(skillRequirementSchema).default([]),
  third_party: z.array(skillThirdPartySchema).default([]),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  entrypoints: z.array(z.string()).default([]),
  required_tools: z.array(z.string()).default([]),
  required_mcp_tools: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export const skillValidationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  checked_at: z.string(),
});

export const skillFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["skill", "reference", "helper", "requirement", "other"]).default("other"),
  size: z.number().int().nonnegative(),
});

export const skillInfoSchema = z.object({
  skill_id: z.string(),
  digest: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  category: z.string(),
  license: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  quality: z.enum(["draft", "validated", "verified", "deprecated"]).default("draft"),
  location: z.string(),
  source: z.enum(["builtin", "project", "user"]),
  enabled: z.boolean().default(true),
  requirements: z.array(skillRequirementSchema).default([]),
  third_party: z.array(skillThirdPartySchema).default([]),
  entrypoints: z.array(z.string()).default([]),
  required_tools: z.array(z.string()).default([]),
  required_mcp_tools: z.array(z.string()).default([]),
  files: z.array(skillFileSchema).default([]),
  validation: skillValidationSchema,
  shadowed: z.array(z.string()).default([]),
}).passthrough();

export type SkillThirdParty = z.infer<typeof skillThirdPartySchema>;
export type SkillRequirement = z.infer<typeof skillRequirementSchema>;
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export type SkillValidation = z.infer<typeof skillValidationSchema>;
export type SkillFile = z.infer<typeof skillFileSchema>;
export type SkillInfo = z.infer<typeof skillInfoSchema>;
