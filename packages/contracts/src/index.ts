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
  next_cursor: z.string().nullable().default(null),
  has_more: z.boolean().default(false),
  snapshot_version: z.string().default(""),
});

export const sessionUserMessageIndexSchema = z.object({
  messages: z.array(z.object({
    id: z.string().min(1),
    text: z.string(),
    timestamp: z.string().nullable().optional(),
    before: z.string(),
  })),
  snapshot_version: z.string().default(""),
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

const executionRequestSchema = z.object({
  tool: z.string().optional(),
  command: z.array(z.string()).optional(),
  notebook_id: z.string().optional(),
  code: z.string().optional(),
}).passthrough().default({});

const executionResultSchema = z.object({
  stdout_preview: z.string().optional(),
  stderr_preview: z.string().optional(),
  output_preview: z.string().optional(),
  error: z.string().optional(),
  exit_code: z.number().int().nullable().optional(),
}).passthrough().default({});

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
  files: z.object({
    read: z.array(executionFileEvidenceSchema).default([]),
    written: z.array(executionFileEvidenceSchema).default([]),
  }).default({ read: [], written: [] }),
  artifacts: z.array(executionArtifactRefSchema).default([]),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const executionListResponseSchema = z.object({
  executions: z.array(executionRecordSchema).default([]),
});

export const executionLogResponseSchema = z.object({
  execution_id: z.string().min(1).optional(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  source: z.enum(["job", "preview"]).optional(),
  complete: z.boolean().default(false),
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
  path: z.string(),
  version: z.number().int().nonnegative(),
  ts: z.number().finite(),
  tool: z.string(),
  toolCallId: z.string().optional(),
  sessionId: z.string(),
  model: z.string().optional(),
  contentHash: z.string().optional(),
  content: z.string().nullable().optional(),
  diff: z.string().optional(),
  log: z.string().optional(),
  executionId: z.string().optional(),
  env: z.object({
    python: z.string().optional(),
    platform: z.string().optional(),
    app: z.string().optional(),
    packages: z.object({ hash: z.string(), count: z.number().int().nonnegative() }).optional(),
    packages_hash: z.string().optional(),
    package_count: z.number().int().nonnegative().optional(),
    cpu_count: z.number().int().positive().optional(),
  }).passthrough().optional(),
}).passthrough();

export const provenanceVersionsResponseSchema = z.object({
  path: z.string(),
  versions: z.array(provenanceRecordSchema).default([]),
});

export const scientificRuntimeHealthSchema = z.object({
  status: z.literal("ok"),
  active_pi_processes: z.number().int().nonnegative(),
  active_kernels: z.number().int().nonnegative(),
});

export const gatewayHealthSchema = scientificRuntimeHealthSchema.extend({
  service: z.literal("pi-science-server"),
  control_plane: z.literal("node"),
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
export type ProvenanceEnvironment = NonNullable<ProvenanceRecord["env"]>;

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
}).refine(
  (candidate) => Object.keys(candidate.files).includes(candidate.entrypoint),
  "entrypoint must be included in candidate files",
);

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

// ── Auto Research Graph ───────────────────────────────────────────

export const researchIdSchema = z.string().regex(/^research-[a-z0-9]{16}$/);
export const researchNodeIdSchema = z.string().regex(/^node-[a-z0-9]{16}$/);
export const researchEdgeIdSchema = z.string().regex(/^edge-[a-z0-9]{16}$/);
export const researchActionIdSchema = z.string().min(1).max(120);

export const researchGraphStatusSchema = z.enum([
  "draft", "running", "pausing", "paused", "input_required",
  "completed", "failed", "cancelled",
]);

export const researchNodeStatusSchema = z.enum([
  "proposed", "ready", "running", "blocked", "succeeded", "failed",
  "rejected", "verified",
]);

export const researchNodeKindSchema = z.enum([
  "question", "hypothesis", "literature", "experiment", "analysis",
  "verification", "decision", "synthesis",
]);

export const researchEdgeRelationSchema = z.enum([
  "decomposes", "tests", "depends_on", "refines", "supports",
  "contradicts", "derived_from", "supersedes",
]);

export const autoResearchBudgetSchema = z.object({
  max_experiments: z.number().int().min(1).max(10_000).default(20),
  max_wall_seconds: z.number().int().min(1).max(31_536_000).default(7200),
  max_model_tokens: z.number().int().positive().nullable().default(null),
  max_cost_usd: z.number().nonnegative().nullable().default(null),
  max_parallel: z.number().int().min(1).max(32).default(2),
});

export const autoResearchUsageSchema = z.object({
  experiments_started: z.number().int().nonnegative().default(0),
  experiments_completed: z.number().int().nonnegative().default(0),
  model_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
  active_wall_ms: z.number().int().nonnegative().default(0),
});

export const experimentSpecSchema = z.object({
  objective: z.string().min(1).max(8000),
  expected_metrics: z.array(z.string().min(1).max(120)).max(100).default([]),
  constraints: z.array(z.string().max(1000)).max(100).default([]),
  estimated_cost: z.record(z.string(), z.number().nonnegative()).optional(),
  materialization: z.literal("pi_candidate").default("pi_candidate"),
});

const researchNodeBaseShape = {
  node_id: researchNodeIdSchema,
  status: researchNodeStatusSchema,
  priority: z.number().finite().default(0),
  created_at: z.string(),
  updated_at: z.string(),
};

export const questionNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("question"),
  question: z.string().min(1).max(8000),
});

export const hypothesisNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("hypothesis"),
  statement: z.string().min(1).max(8000),
  assumptions: z.array(z.string().max(2000)).max(100).default([]),
});

export const literatureNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("literature"),
  question: z.string().min(1).max(8000),
  findings: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const experimentNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("experiment"),
  hypothesis_id: researchNodeIdSchema,
  spec: experimentSpecSchema,
  candidate_id: z.string().nullable().default(null),
  execution_id: z.string().nullable().default(null),
  result_node_id: researchNodeIdSchema.nullable().default(null),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
});

export const analysisNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("analysis"),
  target_node_ids: z.array(researchNodeIdSchema).min(1),
  findings: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const verificationNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("verification"),
  target_node_id: researchNodeIdSchema,
  verdict: z.enum(["pending", "verified", "failed"]).default("pending"),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const decisionNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("decision"),
  reason: z.string().min(1).max(8000),
  options: z.array(z.string().max(2000)).max(50).default([]),
  resolution: z.string().max(8000).nullable().default(null),
});

export const synthesisNodeSchema = z.object({
  ...researchNodeBaseShape,
  kind: z.literal("synthesis"),
  summary: z.string().max(50_000).default(""),
  claim_ids: z.array(z.string()).default([]),
});

export const researchNodeSchema = z.discriminatedUnion("kind", [
  questionNodeSchema, hypothesisNodeSchema, literatureNodeSchema,
  experimentNodeSchema, analysisNodeSchema, verificationNodeSchema,
  decisionNodeSchema, synthesisNodeSchema,
]);

export const researchEdgeSchema = z.object({
  edge_id: researchEdgeIdSchema,
  from: researchNodeIdSchema,
  to: researchNodeIdSchema,
  relation: researchEdgeRelationSchema,
  created_at: z.string(),
});

export const researchClaimSchema = z.object({
  claim_id: z.string().regex(/^claim-[a-z0-9]{16}$/),
  statement: z.string().min(1).max(20_000),
  scope: z.string().max(4000).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  status: z.enum(["proposed", "verified", "qualified", "rejected"]),
  created_at: z.string(),
  updated_at: z.string(),
});

export const researchEvidenceSchema = z.object({
  evidence_id: z.string().regex(/^evidence-[a-z0-9]{16}$/),
  kind: z.enum(["paper", "citation", "artifact", "execution", "metric", "file", "dataset", "observation"]),
  locator: z.record(z.string(), z.unknown()),
  digest: z.string().nullable().default(null),
  created_at: z.string(),
});

export const claimEvidenceSchema = z.object({
  claim_id: z.string(),
  evidence_id: z.string(),
  relation: z.enum(["supports", "contradicts", "derives_from"]),
  strength: z.number().min(0).max(1).default(0.5),
});

export const researchNodeRefSchema = z.union([
  z.object({ node_id: researchNodeIdSchema }),
  z.object({ action_id: researchActionIdSchema }),
]);

const actionBase = { action_id: researchActionIdSchema };
export const researchActionSchema = z.discriminatedUnion("type", [
  z.object({ ...actionBase, type: z.literal("question.add"), question: z.string().min(1).max(8000) }),
  z.object({ ...actionBase, type: z.literal("hypothesis.add"), statement: z.string().min(1).max(8000), assumptions: z.array(z.string().max(2000)).max(100).default([]), parent_refs: z.array(researchNodeRefSchema).default([]) }),
  z.object({ ...actionBase, type: z.literal("experiment.propose"), hypothesis_ref: researchNodeRefSchema, spec: experimentSpecSchema, priority: z.number().finite().default(0) }),
  z.object({ ...actionBase, type: z.literal("literature.request"), question: z.string().min(1).max(8000), parent_refs: z.array(researchNodeRefSchema).default([]), priority: z.number().finite().default(0) }),
  z.object({ ...actionBase, type: z.literal("node.prioritize"), node_id: researchNodeIdSchema, priority: z.number().finite() }),
  z.object({ ...actionBase, type: z.literal("branch.close"), node_id: researchNodeIdSchema, reason: z.string().min(1).max(8000) }),
  z.object({ ...actionBase, type: z.literal("verification.request"), target_node_id: researchNodeIdSchema, priority: z.number().finite().default(0) }),
  z.object({ ...actionBase, type: z.literal("synthesis.request"), target_node_ids: z.array(researchNodeIdSchema).default([]), priority: z.number().finite().default(0) }),
  z.object({ ...actionBase, type: z.literal("user_input.request"), reason: z.string().min(1).max(8000), options: z.array(z.string().max(2000)).max(50).default([]) }),
  z.object({ ...actionBase, type: z.literal("claim.propose"), statement: z.string().min(1).max(20_000), scope: z.string().max(4000).nullable().default(null), confidence: z.number().min(0).max(1).default(0.5) }),
  z.object({ ...actionBase, type: z.literal("research.stop_recommended"), reason: z.string().min(1).max(8000) }),
]);

export const researchCommitSchema = z.object({
  research_id: researchIdSchema,
  base_revision: z.number().int().nonnegative(),
  rationale: z.string().max(20_000).default(""),
  actions: z.array(researchActionSchema).min(1).max(100),
});

export const createAutoResearchSchema = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(8000),
  project_id: z.string().min(1).max(200).default("workspace"),
  origin_session_id: z.string().min(1).nullable().default(null),
  origin_message_id: z.string().min(1).nullable().default(null),
  constraints: z.array(z.string().max(1000)).max(100).default([]),
  budget: autoResearchBudgetSchema.partial().default({}),
  target_metrics: z.record(z.string(), z.object({ value: z.number().finite(), direction: z.enum(["maximize", "minimize"]) })).default({}),
});

export const autoResearchSnapshotSchema = z.object({
  schema_version: z.literal(1),
  research_id: researchIdSchema,
  project_id: z.string(),
  origin_session_id: z.string().nullable(),
  origin_message_id: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  title: z.string(),
  objective: z.string(),
  status: researchGraphStatusSchema,
  constraints: z.array(z.string()),
  budget: autoResearchBudgetSchema,
  usage: autoResearchUsageSchema,
  target_metrics: z.record(z.string(), z.object({ value: z.number(), direction: z.enum(["maximize", "minimize"]) })),
  nodes: z.array(researchNodeSchema),
  edges: z.array(researchEdgeSchema),
  claims: z.array(researchClaimSchema),
  evidence: z.array(researchEvidenceSchema),
  claim_evidence: z.array(claimEvidenceSchema),
  current_activity: z.string().nullable(),
  best_result: z.record(z.string(), z.unknown()).nullable(),
  report_path: z.string().nullable().default(null),
  stop_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

export const researchSseEventSchema = z.object({
  id: z.string(),
  type: z.enum([
    "research.created", "research.started", "research.snapshot",
    "research.progress.updated", "research.activity.changed",
    "research.best_result.updated", "research.input.required",
    "research.finding.created", "research.completed", "research.failed",
  ]),
  timestamp: z.string(),
  project_id: z.string(),
  session_id: z.string().optional(),
  message_id: z.string().optional(),
  research_id: researchIdSchema,
  node_id: researchNodeIdSchema.optional(),
  execution_id: z.string().optional(),
  revision: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()),
});

export type ResearchGraphStatus = z.infer<typeof researchGraphStatusSchema>;
export type ResearchNodeStatus = z.infer<typeof researchNodeStatusSchema>;
export type ResearchNodeKind = z.infer<typeof researchNodeKindSchema>;
export type ResearchNode = z.infer<typeof researchNodeSchema>;
export type ResearchEdge = z.infer<typeof researchEdgeSchema>;
export type ResearchClaim = z.infer<typeof researchClaimSchema>;
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>;
export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;
export type ResearchNodeRef = z.infer<typeof researchNodeRefSchema>;
export type ResearchAction = z.infer<typeof researchActionSchema>;
export type ResearchCommit = z.infer<typeof researchCommitSchema>;
export type CreateAutoResearch = z.infer<typeof createAutoResearchSchema>;
export type AutoResearchBudget = z.infer<typeof autoResearchBudgetSchema>;
export type AutoResearchUsage = z.infer<typeof autoResearchUsageSchema>;
export type AutoResearchSnapshot = z.infer<typeof autoResearchSnapshotSchema>;
export type ExperimentSpec = z.infer<typeof experimentSpecSchema>;
export type ResearchSseEvent = z.infer<typeof researchSseEventSchema>;

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

export * from "./model-resources.js";
