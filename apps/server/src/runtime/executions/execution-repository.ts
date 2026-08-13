import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  executionEventSchema,
  executionRecordSchema,
  type ExecutionArtifactRef,
  type ExecutionCorrelation,
  type ExecutionEvent,
  type ExecutionEventType,
  type ExecutionFileEvidence,
  type ExecutionKind,
  type ExecutionRecord,
  type ExecutionStatus,
  type ExecutionSurface,
} from "@pi-science/contracts";
import { appendJsonLineUnlocked, readJsonLines, withFileWriteLock, workspaceFile } from "../../storage/persistence.js";

const EXECUTION_LOG = "execution-events-v1.jsonl";
const TERMINAL_STATUSES = new Set<ExecutionStatus>(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "lost"]);

export interface StartExecutionInput {
  execution_id?: string;
  kind: ExecutionKind;
  surface: ExecutionSurface;
  producer: string;
  created_at?: string;
  correlation?: ExecutionCorrelation;
  request?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  files?: Partial<{ read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] }>;
  artifacts?: ExecutionArtifactRef[];
}

export interface FinishExecutionInput {
  status: Exclude<ExecutionStatus, "pending" | "running">;
  producer: string;
  ended_at?: string;
  result?: Record<string, unknown>;
  files?: Partial<{ read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] }>;
  artifacts?: ExecutionArtifactRef[];
  usage?: Record<string, unknown>;
}

export function executionIdFor(...parts: string[]): string {
  return `exec_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

export class ExecutionRepository {
  private path(cwd: string): string {
    return workspaceFile(cwd, EXECUTION_LOG);
  }

  async events(cwd: string): Promise<ExecutionEvent[]> {
    const rows = await readJsonLines<unknown>(this.path(cwd));
    return rows.flatMap((row) => {
      const parsed = executionEventSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async list(cwd: string, options: { limit?: number; session_id?: string; kind?: ExecutionKind; status?: ExecutionStatus } = {}): Promise<ExecutionRecord[]> {
    let records = reduceExecutionEvents(await this.events(cwd));
    if (options.session_id) records = records.filter((record) => record.correlation.session_id === options.session_id);
    if (options.kind) records = records.filter((record) => record.kind === options.kind);
    if (options.status) records = records.filter((record) => record.status === options.status);
    const limit = Math.min(1_000, Math.max(1, options.limit ?? 100));
    return records.sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, limit);
  }

  async get(cwd: string, executionId: string): Promise<ExecutionRecord | null> {
    return reduceExecutionEvents(await this.events(cwd)).find((record) => record.execution_id === executionId) ?? null;
  }

  async start(cwd: string, input: StartExecutionInput): Promise<ExecutionRecord> {
    const executionId = input.execution_id ?? `exec_${randomUUID().replaceAll("-", "")}`;
    await this.append(cwd, executionId, "execution.started", input.kind, input.surface, input.producer, {
      started_at: input.created_at ?? new Date().toISOString(),
      correlation: input.correlation ?? {},
      request: input.request ?? {},
      runtime: input.runtime ?? {},
      files: { read: input.files?.read ?? [], written: input.files?.written ?? [] },
      artifacts: input.artifacts ?? [],
    });
    const record = await this.get(cwd, executionId);
    if (!record) throw new Error(`Execution start was not persisted: ${executionId}`);
    return record;
  }

  async finish(cwd: string, executionId: string, input: FinishExecutionInput): Promise<ExecutionRecord | null> {
    const current = await this.get(cwd, executionId);
    if (!current) return null;
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const eventType = eventTypeForStatus(input.status);
    await this.append(cwd, executionId, eventType, current.kind, current.surface, input.producer, {
      status: input.status,
      ended_at: input.ended_at ?? new Date().toISOString(),
      result: input.result ?? {},
      files: { read: input.files?.read ?? [], written: input.files?.written ?? [] },
      artifacts: input.artifacts ?? [],
      ...(input.usage ? { usage: input.usage } : {}),
    });
    return this.get(cwd, executionId);
  }

  private async append(
    cwd: string,
    executionId: string,
    eventType: ExecutionEventType,
    kind: ExecutionKind,
    surface: ExecutionSurface,
    producer: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const path = this.path(cwd);
    await withFileWriteLock(path, async () => {
      const rows = await readJsonLines<unknown>(path);
      const events = rows.flatMap((row) => {
        const parsed = executionEventSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
      if (eventType === "execution.started" && events.some((event) => event.execution_id === executionId && event.event_type === eventType)) return;
      if (eventType !== "execution.started" && events.some((event) => event.execution_id === executionId && [
        "execution.completed", "execution.failed", "execution.cancelled", "execution.interrupted",
      ].includes(event.event_type))) return;
      const sequence = events.filter((event) => event.execution_id === executionId).reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
      const event = executionEventSchema.parse({
        schema_version: 1,
        event_id: `event_${randomUUID().replaceAll("-", "")}`,
        execution_id: executionId,
        sequence,
        event_type: eventType,
        kind,
        surface,
        workspace_id: resolve(cwd),
        created_at: new Date().toISOString(),
        producer,
        payload,
      });
      await appendJsonLineUnlocked(path, event);
    });
  }
}

export function reduceExecutionEvents(events: ExecutionEvent[]): ExecutionRecord[] {
  const records = new Map<string, ExecutionRecord>();
  const ordered = events.slice().sort((left, right) => left.execution_id === right.execution_id
    ? left.sequence - right.sequence
    : left.created_at.localeCompare(right.created_at));
  for (const event of ordered) {
    const payload = event.payload;
    const previous = records.get(event.execution_id);
    if (!previous) {
      if (event.event_type !== "execution.started") continue;
      const parsed = executionRecordSchema.safeParse({
        schema_version: 1,
        execution_id: event.execution_id,
        kind: event.kind,
        surface: event.surface,
        status: "running",
        workspace_id: event.workspace_id,
        created_at: stringValue(payload.started_at) ?? event.created_at,
        started_at: stringValue(payload.started_at) ?? event.created_at,
        producer: event.producer,
        correlation: objectValue(payload.correlation),
        request: objectValue(payload.request),
        runtime: objectValue(payload.runtime),
        result: {},
        files: filesValue(payload.files),
        artifacts: artifactRefs(payload.artifacts),
      });
      if (parsed.success) records.set(event.execution_id, parsed.data);
      continue;
    }
    const status = statusForEvent(event);
    const next = executionRecordSchema.parse({
      ...previous,
      status,
      ended_at: stringValue(payload.ended_at) ?? previous.ended_at,
      producer: event.producer,
      correlation: { ...previous.correlation, ...objectValue(payload.correlation) },
      request: { ...previous.request, ...objectValue(payload.request) },
      runtime: { ...previous.runtime, ...objectValue(payload.runtime) },
      result: { ...previous.result, ...objectValue(payload.result) },
      files: mergeFiles(previous.files, filesValue(payload.files)),
      artifacts: mergeArtifacts(previous.artifacts, artifactRefs(payload.artifacts)),
      usage: { ...(previous.usage ?? {}), ...objectValue(payload.usage) },
    });
    records.set(event.execution_id, next);
  }
  return [...records.values()];
}

function eventTypeForStatus(status: FinishExecutionInput["status"]): ExecutionEventType {
  if (status === "succeeded") return "execution.completed";
  if (status === "cancelled") return "execution.cancelled";
  if (status === "interrupted") return "execution.interrupted";
  return "execution.failed";
}

function statusForEvent(event: ExecutionEvent): ExecutionStatus {
  const explicit = event.payload.status;
  if (typeof explicit === "string") {
    const parsed = executionRecordSchema.shape.status.safeParse(explicit);
    if (parsed.success) return parsed.data;
  }
  if (event.event_type === "execution.completed") return "succeeded";
  if (event.event_type === "execution.cancelled") return "cancelled";
  if (event.event_type === "execution.interrupted") return "interrupted";
  if (event.event_type === "execution.failed") return "failed";
  return "running";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function filesValue(value: unknown): { read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] } {
  const object = objectValue(value);
  const parse = (items: unknown): ExecutionFileEvidence[] => Array.isArray(items)
    ? items.flatMap((item) => {
      const parsed = executionFileEvidenceSchemaSafe(item);
      return parsed ? [parsed] : [];
    })
    : [];
  return { read: parse(object.read), written: parse(object.written) };
}

function executionFileEvidenceSchemaSafe(value: unknown): ExecutionFileEvidence | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string" || !item.path) return null;
  if (!["explicit", "snapshot", "runtime_audit", "declared"].includes(String(item.detection))) return null;
  return item as ExecutionFileEvidence;
}

function artifactRefs(value: unknown): ExecutionArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.artifact_id !== "string" || !Number.isInteger(candidate.version) || !["input", "output"].includes(String(candidate.relation))) return [];
    return [candidate as ExecutionArtifactRef];
  });
}

function mergeFiles(left: { read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] }, right: { read: ExecutionFileEvidence[]; written: ExecutionFileEvidence[] }) {
  const merge = (items: ExecutionFileEvidence[]) => [...new Map(items.map((item) => [`${item.path}\0${item.detection}`, item])).values()];
  return { read: merge([...left.read, ...right.read]), written: merge([...left.written, ...right.written]) };
}

function mergeArtifacts(left: ExecutionArtifactRef[], right: ExecutionArtifactRef[]): ExecutionArtifactRef[] {
  return [...new Map([...left, ...right].map((item) => [`${item.artifact_id}\0${item.version}\0${item.relation}`, item])).values()];
}

export const executionRepository = new ExecutionRepository();
