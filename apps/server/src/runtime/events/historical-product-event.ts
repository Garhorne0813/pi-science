import type { SseEventRecord } from "./event-store.js";

/** Decode persisted presentation records only. Never called for worker input
 * or live publication. Preserve the original cursor, timestamp and sequence. */
export function decodeHistoricalProductEvent(record: SseEventRecord): SseEventRecord {
  let value: Record<string, unknown>;
  try { value = JSON.parse(record.data); } catch { return record; }
  if (!value || typeof value !== "object" || value.schemaVersion === 3) return record;
  if (!value.type && !record.event) return record;
  // Unversioned extension records without a lifecycle type remain opaque.
  if (!value.type && !["agent_start", "agent_end", "agent_settled", "session.idle", "text.updated", "thinking.updated"].includes(record.event ?? "")) return record;
  const names: Record<string, string> = {
    agent_start: "operation.started", agent_settled: "operation.settled",
    agent_end: "runtime.progress", "session.idle": "operation.settled",
    "run.started": "operation.started", "run.completed": "operation.settled",
    "run.cancelled": "operation.settled", "run.failed": "error",
    "text.updated": "message.delta", "thinking.updated": "message.reasoning.delta",
    "item.started": "message.started", "item.completed": "message.completed",
    "item.text.delta": "message.delta", "item.snapshot": "message.snapshot",
    "question.asked": "interaction.requested", "permission.asked": "interaction.requested",
    "compaction.updated": "compaction.progress",
  };
  const oldType = String(value.type ?? record.event ?? "");
  let type = names[oldType] ?? oldType;
  const body = value.payload && typeof value.payload === "object" ? { ...(value.payload as Record<string, unknown>) } : { ...value };
  if (oldType === "tool.updated") type = body.status === "done" || body.status === "error" ? "tool.completed" : "tool.updated";
  if (type === "operation.settled") body.status = oldType === "run.cancelled" ? "aborted" : "completed";
  if (oldType === "permission.asked") { body.kind = "permission"; body.method = "confirm"; }
  body.type = type;
  return { ...record, event: type, data: JSON.stringify({ ...value, ...body, type, schemaVersion: 3,
    ...(value.payload ? { payload: body } : {}) }) };
}
