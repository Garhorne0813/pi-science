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

/** Whole-session cumulative stats, mirroring the durable whole-log projection
 *  served by the Pi runtime's `get_session_stats` plus control-plane wall-clock
 *  timing (LLM/decode/TTFT/tool durations) tracked from the event stream.
 *  Counters are the runtime's authoritative full-log fold (turns = user
 *  messages, tool calls deduped by call id); timing is persisted per session
 *  so it survives refresh even when the runtime is idle. */
export const sessionStatsSchema = z.object({
  userMessages: z.number().int().nonnegative(),
  assistantMessages: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolResults: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  tokens: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
  cost: z.number().nonnegative().optional(),
  /** Accumulated assistant-message wall time: message start → message end. */
  llmMs: z.number().nonnegative().optional(),
  /** Accumulated tool wall time: tool_execution_start → tool_execution_end. */
  toolMs: z.number().nonnegative().optional(),
  /** Time-to-first-token total and step count (message start → first non-empty
   *  text delta). decodeMs is first delta → message end; token/s is derived
   *  client-side as output tokens / decode seconds. */
  ttftMs: z.number().nonnegative().optional(),
  ttftSteps: z.number().int().nonnegative().optional(),
  decodeMs: z.number().nonnegative().optional(),
}).passthrough();

const sessionStatsEventSchema = z.object({
  type: z.literal("session.stats"),
  sessionId: z.string(),
  stats: sessionStatsSchema,
});

export const sessionEventSchema = z.discriminatedUnion("type", [
  textUpdatedEventSchema,
  toolUpdatedEventSchema,
  sessionIdleEventSchema,
  sessionErrorEventSchema,
  sessionStatsEventSchema,
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

export const executionKindSchema = z.enum([
  "tool",
  "kernel_cell",
  "job",
  "research_agent",
  "research_evaluation",
  "scheduled_task",
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

export const executionCorrelationSchema = z.object({
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
  scheduled_task_id: z.string().optional(),
  scheduled_task_run_id: z.string().optional(),
  scheduled_task_attempt_id: z.string().optional(),
}).default({});

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
  request: z.record(z.string(), z.unknown()).default({}),
  runtime: z.record(z.string(), z.unknown()).default({}),
  result: z.record(z.string(), z.unknown()).default({}),
  files: z.object({
    read: z.array(executionFileEvidenceSchema).default([]),
    written: z.array(executionFileEvidenceSchema).default([]),
  }).default({ read: [], written: [] }),
  artifacts: z.array(executionArtifactRefSchema).default([]),
  usage: z.record(z.string(), z.unknown()).optional(),
});

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
export type SessionStats = z.infer<typeof sessionStatsSchema>;
export type PiRpcCommand = z.infer<typeof piRpcCommandSchema>;
export type PiRpcResponse = z.infer<typeof piRpcResponseSchema>;
export type PiRuntimeEvent = z.infer<typeof piRuntimeEventSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type ExecutionKind = z.infer<typeof executionKindSchema>;
export type ExecutionSurface = z.infer<typeof executionSurfaceSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type ExecutionEventType = z.infer<typeof executionEventTypeSchema>;
export type ExecutionCorrelation = z.infer<typeof executionCorrelationSchema>;
export type ExecutionFileEvidence = z.infer<typeof executionFileEvidenceSchema>;
export type ExecutionArtifactRef = z.infer<typeof executionArtifactRefSchema>;
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
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
  // Skills must declare their license explicitly; "UNLICENSED" (never a
  // silent Apache-2.0 assumption) is the fallback until an author declares
  // one. Catalog validation warns on the undeclared case and rejects builtin
  // skills that omit it.
  license: z.string().max(120).default("UNLICENSED"),
  // Agent Skills interop hint (e.g. "claude", "pi", "*"). Accepts lists or
  // scalars from foreign front matter; pi-science never enforces
  // Claude-only semantics. Non-string values are coerced downstream.
  compatibility: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]).nullish().catch(undefined),
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
  compatibility: z.string().nullish(),
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
export const skillContentSchema = z.object({
  skill_id: z.string().min(1),
  name: z.string().min(1),
  digest: z.string().min(1),
  source: z.enum(["builtin", "project", "user"]),
  // Relative/display path (e.g. ".pi/skills/x/SKILL.md") — never an absolute path.
  location: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.startsWith("\\") &&
        !/^[A-Za-z]:[\\/]/.test(value) &&
        !value.startsWith("~/") &&
        !value.startsWith("~\\"),
      "location must be a relative display path",
    ),
  content: z.string(),
}).passthrough();

export type SkillContent = z.infer<typeof skillContentSchema>;
export type SkillInfo = z.infer<typeof skillInfoSchema>;

// ── Scheduled tasks (wire schemas only; server-internal entity interfaces live in apps/server/src/scheduled-tasks/types.ts) ──

/** RFC 3339 with a mandatory zone designator (`Z`, `z`, or ±HH:MM offset). */
const rfc3339WithZone = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/, "must be RFC 3339 with Z or explicit offset");

/** RFC 3339 normalized to UTC (`Z`) — server-generated anchor instants. */
const rfc3339Utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?[Zz]$/, "must be RFC 3339 in UTC (Z)");

/** IANA timezone name; deep validation (Intl probe) is server-side in validateSchedule. */
const ianaTimezone = z.string().min(1).regex(/^\S+$/, "must be an IANA timezone name");

export const scheduledOnceScheduleSchema = z.object({
  type: z.literal("once"),
  at: rfc3339WithZone,
  timezone: ianaTimezone,
});

export const scheduledIntervalScheduleSchema = z.object({
  type: z.literal("interval"),
  // First-version minimum interval is 300 seconds (docs §5.3).
  every_seconds: z.number().int().min(300),
  anchor_at: rfc3339Utc,
  timezone: ianaTimezone,
});

export const scheduledCronScheduleSchema = z.object({
  type: z.literal("cron"),
  // First version accepts exactly 5 fields (no seconds field); 6-field and
  // @predefined forms are rejected here and again by the server parser wrapper.
  expression: z.string().refine((expr) => expr.trim().split(/\s+/).length === 5, "cron expression must have exactly 5 fields"),
  timezone: ianaTimezone,
});

export const scheduledTaskScheduleSchema = z.discriminatedUnion("type", [
  scheduledOnceScheduleSchema,
  scheduledIntervalScheduleSchema,
  scheduledCronScheduleSchema,
]);

export const literatureProviderSchema = z.enum(["pubmed", "genbank", "arxiv", "pubchem", "uniprot"]);

export const literatureDigestConfigSchema = z.object({
  query: z.string().min(1).max(2000),
  providers: z.array(literatureProviderSchema).min(1),
  instructions: z.string().max(4000).optional(),
  max_results: z.number().int().min(1).max(100).default(30),
  language: z.enum(["zh-CN", "en"]).default("zh-CN"),
});

// Only `literature_digest` is allowed. Shell / job_command / command arrays are
// deliberately absent (docs §3.3, §9.12).
export const scheduledTaskExecutorSchema = z.object({
  kind: z.literal("literature_digest"),
  config: literatureDigestConfigSchema,
});

export const retryPolicySchema = z.object({
  max_attempts: z.number().int().min(1).max(5).default(3),
  initial_backoff_seconds: z.number().int().min(1).default(30),
  multiplier: z.number().min(1).default(4),
  max_backoff_seconds: z.number().int().min(1).default(600),
});

export const scheduledTaskBudgetSchema = z.object({
  max_wall_time_seconds: z.number().int().min(60).max(3600).default(900),
});

export const misfirePolicySchema = z.enum(["coalesce_latest", "skip"]);
export const concurrencyPolicySchema = z.enum(["forbid"]);

/** Canonical approval-scope payload hashed by the server (docs §9.4); fixed key order is enforced by the hash builder, not JSON parsing. */
export const approvalScopeHashPayloadSchema = z.object({
  executor_kind: z.literal("literature_digest"),
  query: z.string().min(1),
  providers: z.array(literatureProviderSchema).min(1),
  instructions: z.string(),
  max_results: z.number().int().min(1).max(100),
  language: z.enum(["zh-CN", "en"]),
  output_relative_root: z.string().min(1),
});

export const scheduledTaskApprovalSchema = z.object({
  status: z.enum(["none", "pending", "approved"]).default("none"),
  scope_hash: z.string().default(""),
  approved_revision: z.number().int().nonnegative().nullable().default(null),
  categories: z.array(z.string()).default([]),
  terms: z.array(z.string()).default([]),
  approved_at: z.string().nullable().default(null),
});

export type ScheduledOnceSchedule = z.infer<typeof scheduledOnceScheduleSchema>;
export type ScheduledIntervalSchedule = z.infer<typeof scheduledIntervalScheduleSchema>;
export type ScheduledCronSchedule = z.infer<typeof scheduledCronScheduleSchema>;
export type ScheduledTaskSchedule = z.infer<typeof scheduledTaskScheduleSchema>;
export type LiteratureProvider = z.infer<typeof literatureProviderSchema>;
export type LiteratureDigestConfig = z.infer<typeof literatureDigestConfigSchema>;
export type ScheduledTaskExecutor = z.infer<typeof scheduledTaskExecutorSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type ScheduledTaskBudget = z.infer<typeof scheduledTaskBudgetSchema>;
export type MisfirePolicy = z.infer<typeof misfirePolicySchema>;
export type ConcurrencyPolicy = z.infer<typeof concurrencyPolicySchema>;
export type ApprovalScopeHashPayload = z.infer<typeof approvalScopeHashPayloadSchema>;
export type ScheduledTaskApproval = z.infer<typeof scheduledTaskApprovalSchema>;
