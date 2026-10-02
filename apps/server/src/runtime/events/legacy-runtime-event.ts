import { legacyAssistantContent } from "./assistant-content.js";
import type { RuntimeEvent } from "../agent/agent-runtime-types.js";

const names: Record<string, string> = {
  "agent_start": "operation.started",
  "agent_settled": "operation.settled",
  "agent_end": "operation.ended",
  "message_start": "message.started",
  "message_update": "message.updated",
  "message_end": "message.completed",
  "tool_execution_start": "tool.started",
  "tool_execution_update": "tool.updated",
  "tool_execution_end": "tool.completed",
  "compaction_start": "compaction.start",
  "compaction_update": "compaction.update",
  "compaction_end": "compaction.end",
  "compaction_error": "compaction.error",
  "retry_start": "retry.start",
  "retry_update": "retry.update",
  "retry_end": "retry.end",
  "status": "runtime.status",
  "error": "runtime.error",
  "extension_ui_request": "interaction.requested",
  "extension_error": "runtime.extension_error",
  "artifact_published": "artifact.published",
  "bash_execution_update": "legacy.bash.update",
  "subagent_request": "subagent.requested",
  "subagent_cancel": "subagent.cancelled",
  "turn_start": "model.turn.started",
};

/** Normalize legacy producers once; core already emits product input names. */
export function productInput(event: RuntimeEvent): RuntimeEvent {
  const type = names[event.type];
  if (!type) return event;
  const normalized = { ...event, type };
  return type === "message.updated" ? { ...normalized, content: legacyAssistantContent(normalized) } : normalized;
}
