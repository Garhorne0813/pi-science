import { z } from "zod";
import { toolPresentationSchema } from "./presentation.js";
import { sessionStateSchema, sessionStatsSchema, sessionApprovalSchema } from "./sessions.js";
import { conversationEventTypes } from "./conversation-events.js";

export const streamGapReasonSchema = z.enum([
  "cursor_missing",
  "sequence_hole",
  "epoch_changed",
  "invalid_cursor",
  "client_detected_gap",
]);
export type StreamGapReason = z.infer<typeof streamGapReasonSchema>;

export const streamCursorSchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  id: z.string().min(1),
});
export type StreamCursor = z.infer<typeof streamCursorSchema>;

export const tokenUsageSchema = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
  })
  .passthrough();

const textUpdatedEventSchema = z.object({
  type: z.literal("message.delta"),
  sessionId: z.string(),
  partId: z.string(),
  text: z.string(),
  presentationRole: z.enum(["intermediate", "final"]).optional(),
});

const toolUpdatedEventSchema = z.object({
  type: z.literal("tool.updated"),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  status: z.enum(["running", "done", "error", "waiting-approval"]),
  title: z.string().optional(),
  presentation: toolPresentationSchema.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  details: z.unknown().optional(),
  partialOutput: z.string().optional(),
  diff: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  childSessionId: z.string().optional(),
});

const operationSettledEventSchema = z.object({
  type: z.literal("operation.settled"),
  sessionId: z.string(),
  status: z.enum(["completed", "declined", "aborted", "failed"]),
});
const operationStartedEventSchema = z.object({
  type: z.literal("operation.started"),
  sessionId: z.string(),
  runId: z.string(),
});
const runtimePausedEventSchema = z.object({
  type: z.literal("runtime.paused"),
  sessionId: z.string(),
});
const messageStartedEventSchema = z.object({
  type: z.literal("message.started"),
  sessionId: z.string(),
  itemId: z.string(),
});
const messageCompletedEventSchema = z.object({
  type: z.literal("message.completed"),
  sessionId: z.string(),
  itemId: z.string(),
});
const reasoningDeltaEventSchema = textUpdatedEventSchema.extend({
  type: z.literal("message.reasoning.delta"),
});
const toolStartedEventSchema = toolUpdatedEventSchema.extend({ type: z.literal("tool.started") });
const toolCompletedEventSchema = toolUpdatedEventSchema.extend({
  type: z.literal("tool.completed"),
});
const interactionRequestedEventSchema = z.object({
  type: z.literal("interaction.requested"),
  sessionId: z.string(),
  requestId: z.string(),
  kind: z.enum(["permission", "confirmation", "question"]),
  method: z.string(),
});
const sessionErrorEventSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string().optional(),
  message: z.string(),
  terminal: z.boolean().optional(),
});

export const approvalModeChangedEventSchema = sessionApprovalSchema.extend({
  type: z.literal("approval.mode.changed"),
  sessionId: z.string(),
  runtimeRestarted: z.boolean().optional(),
  kernelRestartCount: z.number().int().nonnegative().optional(),
});

const sessionStatsEventSchema = z.object({
  type: z.literal("session.stats"),
  sessionId: z.string(),
  stats: sessionStatsSchema,
});

export const sessionEventSchema = z
  .discriminatedUnion("type", [
    textUpdatedEventSchema,
    toolUpdatedEventSchema,
    operationSettledEventSchema,
    operationStartedEventSchema,
    runtimePausedEventSchema,
    messageStartedEventSchema,
    messageCompletedEventSchema,
    reasoningDeltaEventSchema,
    toolStartedEventSchema,
    toolCompletedEventSchema,
    interactionRequestedEventSchema,
    sessionErrorEventSchema,
    sessionStatsEventSchema,
    approvalModeChangedEventSchema,
  ])
  .and(z.looseObject({}));

/** Version 3 uses Core-aligned operation/message/tool lifecycle names.
 * Durable identity and revisions support replay without arrival-order guesses. */

export const conversationRunStateSchema = z.enum([
  "queued",
  "active",
  "waiting",
  "stopping",
  "completed",
  "failed",
  "cancelled",
]);
export type ConversationRunState = z.infer<typeof conversationRunStateSchema>;

export const conversationRunOutcomeSchema = z.enum(["ok", "with_issues", "no_answer"]);
export type ConversationRunOutcome = z.infer<typeof conversationRunOutcomeSchema>;

export const conversationEventPhaseSchema = z.enum(["commentary", "final_answer", "unknown"]);
export type ConversationEventPhase = z.infer<typeof conversationEventPhaseSchema>;

const eventIdSchema = z.string().min(1);
const occurredAtSchema = z.string().min(1);

export const conversationEventV3Schema = z.looseObject({
  schemaVersion: z.literal(3),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  streamEpoch: z.string().min(1),
  eventId: eventIdSchema,
  seq: z.number().int().nonnegative(),
  turnId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  parentItemId: z.string().min(1).optional(),
  occurredAt: occurredAtSchema,
  type: z.enum(conversationEventTypes),
  payload: z.unknown().optional(),
});
export type ConversationEventV3 = z.infer<typeof conversationEventV3Schema>;

export const textDeltaPayloadSchema = z.object({
  partId: z.string().min(1),
  phase: conversationEventPhaseSchema,
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  text: z.string(),
});
export type TextDeltaPayload = z.infer<typeof textDeltaPayloadSchema>;

export const textSnapshotPayloadSchema = z.object({
  revision: z.number().int().nonnegative(),
  phase: conversationEventPhaseSchema,
  parts: z.array(z.object({ partId: z.string().min(1), text: z.string() })),
});
export type TextSnapshotPayload = z.infer<typeof textSnapshotPayloadSchema>;

export const conversationItemStartedPayloadSchema = z.looseObject({
  itemType: z.enum([
    "user",
    "commentary",
    "assistant",
    "tool",
    "interaction",
    "artifact",
    "system",
  ]),
  phase: conversationEventPhaseSchema.optional(),
  content: z.string().optional(),
});

export const conversationItemCompletedPayloadSchema = z.looseObject({
  revision: z.number().int().nonnegative().optional(),
});

export const conversationToolUpdatedPayloadSchema = z.looseObject({
  callId: z.string().min(1),
  operationId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  tool: z.string().min(1),
  status: z.enum(["running", "done", "error", "waiting-approval", "unknown"]),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  partialOutput: z.string().optional(),
  diff: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
});

export const conversationRunRecordSchema = z.looseObject({
  turnId: z.string().min(1),
  runId: z.string().min(1),
  retryOfRunId: z.string().min(1).optional(),
  state: conversationRunStateSchema,
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  finalItemId: z.string().min(1).optional(),
  outcome: conversationRunOutcomeSchema.optional(),
  issues: z
    .array(
      z.object({
        itemId: z.string().min(1).optional(),
        code: z.string().min(1),
        resolvedByItemId: z.string().min(1).optional(),
      }),
    )
    .default([]),
});
export type ConversationRunRecord = z.infer<typeof conversationRunRecordSchema>;

export const conversationSnapshotSchema = z.looseObject({
  schemaVersion: z.literal(2),
  sessionId: z.string().min(1),
  streamEpoch: z.string().min(1),
  throughSeq: z.number().int().nonnegative(),
  snapshotVersion: z.string().min(1),
  turns: z.array(z.unknown()),
  runs: z.array(conversationRunRecordSchema),
  items: z.array(z.unknown()),
  pendingInteractions: z.array(z.unknown()),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
  // Optional during the compatibility window: older servers expose the flat
  // snapshot fields but do not yet return a resumable cursor/state bundle.
  resumeCursor: z.string().nullable().default(null),
  sessionState: sessionStateSchema.optional(),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

export type SessionEvent = z.infer<typeof sessionEventSchema>;
