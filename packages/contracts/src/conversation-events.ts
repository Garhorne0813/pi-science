/** Lightweight public SSE names shared by server contracts and browser transport. */
export const conversationEventTypes = [
  "operation.started", "operation.settled", "runtime.paused", "runtime.progress", "error",
  "message.started", "message.delta", "message.reasoning.delta", "message.completed", "message.snapshot",
  "tool.started", "tool.updated", "tool.completed",
  "interaction.requested", "interaction.resolved", "questionnaire.asked", "questionnaire.finished",
  "compaction.started", "compaction.progress", "compaction.completed", "compaction.failed",
  "artifact.published", "artifact.updated", "turn.artifacts", "plan.updated",
  "status.updated", "session.replaced", "stream.gap", "session.stats",
] as const;

