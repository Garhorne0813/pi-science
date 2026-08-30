import { createHash } from "node:crypto";
import { appendJsonLineUnlocked, readJsonLines, withFileWriteLock, workspaceFile } from "../../storage/persistence.js";

const PROVENANCE_LOG = "provenance.jsonl";

/**
 * One provenance.jsonl entry. Field names match the historical inline
 * implementation in http/routes/artifact-routes.ts (sessionId/toolCallId/
 * executionId camelCase mapping) plus optional scheduled-task correlation
 * siblings; existing field names never change (docs/定时任务统一详细实现方案.md §9.11).
 */
export interface Provenance {
  path: string;
  version: number;
  ts: number;
  tool: string;
  toolCallId?: string;
  sessionId: string;
  model?: string;
  contentHash?: string;
  content?: string;
  diff?: string;
  executionId?: string;
  scheduled_task_id?: string;
  scheduled_task_run_id?: string;
  scheduled_task_attempt_id?: string;
}

/**
 * Workspace provenance ledger writer (.pi-science/provenance.jsonl).
 *
 * Extracted verbatim from http/routes/artifact-routes.ts so HTTP routes and
 * runtime executors (e.g. the scheduled-task executor) share one record()
 * path without importing HTTP route files. Version = max(version for path)+1,
 * contentHash is sha256(content).slice(0,16), content is truncated to 100k
 * chars, and execution_id maps onto the stored executionId field.
 */
export class ProvenanceRepository {
  async record(cwd: string, body: Record<string, unknown>): Promise<Provenance> {
    const path = String(body.path ?? "");
    return withFileWriteLock(workspaceFile(cwd, PROVENANCE_LOG), async () => { const records = await readJsonLines<Provenance>(workspaceFile(cwd, PROVENANCE_LOG)); const version = records.filter((record) => record.path === path).reduce((max, record) => Math.max(max, record.version), 0) + 1; const content = typeof body.content === "string" ? body.content : undefined; const record: Provenance = { path, version, ts: Date.now() / 1000, tool: String(body.tool ?? "unknown"), sessionId: String(body.session_id ?? body.sessionId ?? ""), ...(body.tool_call_id ? { toolCallId: String(body.tool_call_id) } : {}), ...(body.model ? { model: String(body.model) } : {}), ...(content !== undefined ? { contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16), content: content.slice(0, 100_000) } : {}), ...(body.diff ? { diff: String(body.diff) } : {}), ...(body.execution_id ? { executionId: String(body.execution_id) } : {}), ...(body.scheduled_task_id ? { scheduled_task_id: String(body.scheduled_task_id) } : {}), ...(body.scheduled_task_run_id ? { scheduled_task_run_id: String(body.scheduled_task_run_id) } : {}), ...(body.scheduled_task_attempt_id ? { scheduled_task_attempt_id: String(body.scheduled_task_attempt_id) } : {}) }; await appendJsonLineUnlocked(workspaceFile(cwd, PROVENANCE_LOG), record); return record; });
  }
}

export const provenanceRepository = new ProvenanceRepository();
