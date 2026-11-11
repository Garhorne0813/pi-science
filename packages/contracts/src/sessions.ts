import { z } from "zod";
import { toolPresentationSchema } from "./presentation.js";

export const piConfigSchema = z.object({
  model: z.string().nullish(),
  provider: z.string().nullish(),
  api_key: z.string().nullish(),
  thinking: z.string().nullish(),
  compaction_enabled: z.boolean().optional(),
  compaction_threshold_percent: z.number().min(50).max(95).optional(),
  model_context_window: z.number().int().positive().optional(),
  model_context_window_override: z
    .object({ model: z.string().min(1), context_window: z.number().int().positive() })
    .optional(),
  model_max_output_tokens: z.number().int().positive().optional(),
  skills: z.array(z.string()).default([]),
  extensions: z.array(z.string()).default([]),
});

export const approvalPreferencesSchema = z
  .object({ defaultMode: z.enum(["ask", "auto"]).default("ask") })
  .strict();

export const approvalModeSchema = z.enum(["ask", "auto", "full"]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export const sessionApprovalSchema = z.object({
  mode: approvalModeSchema,
  revision: z.number().int().nonnegative(),
});
export const updateSessionApprovalSchema = z
  .object({
    mode: approvalModeSchema,
    revision: z.number().int().nonnegative(),
    acknowledgeFullAccess: z.boolean().optional(),
  })
  .strict();

export const initialSessionApprovalSchema = z
  .object({ mode: approvalModeSchema, acknowledgeFullAccess: z.boolean().optional() })
  .strict()
  .refine((value) => value.mode !== "full" || value.acknowledgeFullAccess === true, {
    message: "Full access requires explicit acknowledgement",
  });

export const createSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  config: piConfigSchema.default({ skills: [], extensions: [] }),
  initialApproval: initialSessionApprovalSchema.optional(),
  // Callers that may retry a create (a reloaded page replaying its first
  // prompt) supply the same key so the server adopts the session it already
  // started instead of spawning a second worker.
  idempotencyKey: z.string().min(1).max(200).optional(),
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

export const sessionListPageSchema = z.object({
  sessions: z.array(sessionInfoSchema),
  next_cursor: z.string().nullable().default(null),
  has_more: z.boolean().default(false),
});

export const sessionStateSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  is_streaming: z.boolean(),
  is_compacting: z.boolean(),
  pending_message_count: z.number().int().nonnegative(),
  mcp_diagnostics: z.array(z.string().max(2048)).optional(),
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
  client_message_id: z.string().min(1).optional(),
  content: z.array(z.record(z.string(), z.unknown())),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  timestamp: z.string().nullish(),
  details: z.unknown().optional(),
  presentation: toolPresentationSchema.optional(),
  presentationRole: z.enum(["intermediate", "final"]).optional(),
  turnId: z.string().optional(),
  runId: z.string().optional(),
  itemId: z.string().optional(),
  parentItemId: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  sequence: z.number().int().nonnegative().optional(),
  turnStatus: z.enum(["completed", "declined", "aborted", "failed"]).optional(),
  turnStartedAt: z.string().datetime().optional(),
  turnEndedAt: z.string().datetime().optional(),
  classificationSource: z.enum(["explicit", "legacy_inferred", "unknown"]).optional(),
});

export const sessionMessagePageSchema = z.object({
  messages: z.array(historyMessageSchema),
  next_cursor: z.string().nullable().default(null),
  has_more: z.boolean().default(false),
  snapshot_version: z.string().default(""),
});

export const sessionUserMessageIndexSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string(),
      timestamp: z.string().nullable().optional(),
      before: z.string(),
    }),
  ),
  snapshot_version: z.string().default(""),
});

/** Whole-session cumulative stats, mirroring the durable whole-log projection
 *  served by the Pi runtime's `get_session_stats` plus control-plane wall-clock
 *  timing (LLM/decode/TTFT/tool durations) tracked from the event stream.
 *  Counters are the runtime's authoritative full-log fold (turns = user
 *  messages, tool calls deduped by call id); timing is persisted per session
 *  so it survives refresh even when the runtime is idle. */
export const sessionStatsSchema = z
  .object({
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
    /** Accumulated tool wall time: tool.started → tool.completed. */
    toolMs: z.number().nonnegative().optional(),
    /** Time-to-first-token total and step count (message start → first non-empty
     *  text delta). decodeMs is first delta → message end; token/s is derived
     *  client-side as output tokens / decode seconds. */
    ttftMs: z.number().nonnegative().optional(),
    ttftSteps: z.number().int().nonnegative().optional(),
    decodeMs: z.number().nonnegative().optional(),
  })
  .passthrough();

export type PiConfig = z.infer<typeof piConfigSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type SessionInfo = z.infer<typeof sessionInfoSchema>;
export type SessionListPage = z.infer<typeof sessionListPageSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type HistoryMessage = z.infer<typeof historyMessageSchema>;
export type SessionMessagePage = z.infer<typeof sessionMessagePageSchema>;
export type SessionStats = z.infer<typeof sessionStatsSchema>;
