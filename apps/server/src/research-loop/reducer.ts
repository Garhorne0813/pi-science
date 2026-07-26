import { researchLoopSchema, type ResearchLoop } from "@pi-science/contracts";
import type { ResearchCandidate, ResearchOperation, ResearchRecord, ResearchSnapshot } from "./types.js";

const operationEvents = new Map([
  ["agent.run_reserved", "reserved"], ["agent.run_started", "started"],
  ["agent.run_completed", "completed"], ["agent.run_failed", "failed"],
  ["candidate.execution_reserved", "reserved"], ["candidate.execution_started", "started"],
  ["candidate.execution_finished", "completed"], ["candidate.execution_failed", "failed"],
  ["candidate.evaluation_reserved", "reserved"], ["candidate.evaluation_started", "started"], ["candidate.evaluated", "completed"],
  ["candidate.evaluation_failed", "failed"],
] as const);

export function reduceResearchRecords(records: ResearchRecord[], loopId: string): ResearchSnapshot {
  const rows = records.filter((row) => row.loop_id === loopId);
  let rawLoop: Record<string, unknown> | null = null;
  const candidates = new Map<string, ResearchCandidate>();
  const operations = new Map<string, ResearchOperation>();

  for (const row of rows) {
    if (row.record_type === "loop.created") rawLoop = { ...row.payload, loop_id: loopId };
    else if (rawLoop !== null && ["loop.updated", "loop.state_changed"].includes(row.record_type)) rawLoop = Object.assign({}, rawLoop, row.payload);

    if (row.record_type === "candidate.proposed" && row.candidate_id) {
      candidates.set(row.candidate_id, {
        candidate_id: row.candidate_id,
        loop_id: loopId,
        status: "proposed",
        proposal: row.payload as ResearchCandidate["proposal"],
        execution: {},
        evaluation: null,
        evaluation_status: null,
        created_at: row.created_at,
      });
    }
    const candidate = row.candidate_id ? candidates.get(row.candidate_id) : undefined;
    if (candidate && row.record_type === "candidate.execution_started") {
      candidate.status = "executing";
      candidate.execution = { ...candidate.execution, ...row.payload };
    } else if (candidate && row.record_type === "candidate.execution_finished") {
      candidate.execution = { ...candidate.execution, ...row.payload };
      const status = String(row.payload.status ?? "failed");
      candidate.status = status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed";
    } else if (candidate && row.record_type === "candidate.execution_failed") {
      candidate.execution = { ...candidate.execution, ...row.payload };
      candidate.status = row.payload.status === "cancelled" ? "cancelled" : "failed";
    } else if (candidate && row.record_type === "candidate.evaluated") {
      candidate.evaluation = row.payload.evaluation as ResearchCandidate["evaluation"];
      candidate.evaluation_status = row.payload.evaluation_status === "passed" ? "passed" : "failed";
      candidate.status = "evaluated";
    }

    const operationStatus = operationEvents.get(row.record_type as never);
    if (operationStatus && row.operation_id) {
      const previous = operations.get(row.operation_id);
      const kind = row.record_type.startsWith("agent.") ? "agent"
        : row.record_type.includes("execution") ? "execution" : "evaluation";
      operations.set(row.operation_id, {
        operation_id: row.operation_id,
        kind,
        phase: String(row.payload.phase ?? previous?.phase ?? kind),
        status: operationStatus,
        loop_id: loopId,
        ...(row.candidate_id ? { candidate_id: row.candidate_id } : previous?.candidate_id ? { candidate_id: previous.candidate_id } : {}),
        ...(row.run_id ? { run_id: row.run_id } : previous?.run_id ? { run_id: previous.run_id } : {}),
        attempt: Number(row.payload.attempt ?? previous?.attempt ?? 1),
        idempotency_key: String(row.payload.idempotency_key ?? previous?.idempotency_key ?? row.operation_id),
        ...(typeof row.payload.error === "string" ? { error: row.payload.error } : previous?.error ? { error: previous.error } : {}),
        ...(row.payload.result && typeof row.payload.result === "object"
          ? { result: row.payload.result as Record<string, unknown> }
          : row.record_type.endsWith("_started")
            ? { result: { ...previous?.result, ...row.payload } }
            : previous?.result ? { result: previous.result } : {}),
        created_at: previous?.created_at ?? row.created_at,
        updated_at: row.created_at,
      });
    }
  }

  const parsed = rawLoop ? researchLoopSchema.safeParse(rawLoop) : null;
  return {
    loop: parsed?.success ? parsed.data : null,
    candidates: [...candidates.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    operations: [...operations.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    records: rows,
  };
}

export function listReducedLoops(records: ResearchRecord[]): ResearchLoop[] {
  const ids = [...new Set(records.flatMap((row) => row.loop_id ? [row.loop_id] : []))];
  return ids.flatMap((id) => {
    const loop = reduceResearchRecords(records, id).loop;
    return loop ? [loop] : [];
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
