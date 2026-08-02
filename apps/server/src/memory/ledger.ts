import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { configPath, readJson, withFileWriteLock, writeJsonAtomic, workspaceFile } from "../storage/persistence.js";

export const MEMORY_LEDGER_VERSION = 1 as const;

export const memoryScopes = ["global", "project", "session"] as const;
export type MemoryScope = typeof memoryScopes[number];

export const memoryEvidenceKinds = ["message", "file", "artifact", "run", "citation", "research_record"] as const;
export type MemoryEvidenceKind = typeof memoryEvidenceKinds[number];

export type MemoryStatus = "pending" | "active" | "accepted" | "rejected" | "superseded" | "archived" | "undone" | "failed";
export type ApprovalRequirement = "manual" | "explicit_user" | "policy";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface MemoryEvidence {
  id: string;
  kind: MemoryEvidenceKind;
  locator: string;
  project_id?: string | null;
  session_id?: string | null;
  message_id?: string | null;
  path?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  artifact_id?: string | null;
  version?: number | null;
  run_id?: string | null;
  citation?: string | null;
  sha256?: string | null;
  excerpt?: string | null;
  captured_at: string;
  [key: string]: unknown;
}

/** Source metadata shared by project knowledge, future global memory, and session bookmarks. */
export interface MemorySource {
  project_id?: string | null;
  session_id?: string | null;
  message_ids: string[];
  files: string[];
  run_ids: string[];
  citations: string[];
  evidence: MemoryEvidence[];
  [key: string]: unknown;
}

export interface MemoryApproval {
  required: ApprovalRequirement;
  status: ApprovalStatus;
  actor: string | null;
  decided_at: string | null;
  reason: string | null;
  policy_version: string | null;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  project_id?: string | null;
  session_id?: string | null;
  kind: string;
  // `type` remains part of the shape for the existing project-knowledge UI.
  type: string;
  title: string;
  summary: string;
  confidence: string;
  importance: string;
  status: MemoryStatus | string;
  source: MemorySource;
  related_files: string[];
  conflicts_with: string[];
  supersedes: string[];
  proposal_id?: string;
  approval: MemoryApproval;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface MemoryProposal extends MemoryRecord {
  proposal_type: "knowledge" | "file_operation";
  knowledge_type?: string;
  reason: string;
  operations: unknown[];
  decision_reason?: string | null;
  applied_history_id?: string | null;
}

export interface MemoryDecision {
  id: string;
  target_id: string;
  action: "accepted" | "rejected" | "repaired" | "superseded" | "archived";
  actor: string;
  reason: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface MemoryLedger {
  version: typeof MEMORY_LEDGER_VERSION;
  records: MemoryRecord[];
  proposals: MemoryProposal[];
  decisions: MemoryDecision[];
  migrated_from?: { path: string; migrated_at: string } | null;
  updated_at: string;
}

export function projectMemoryLedgerPath(cwd: string): string {
  return workspaceFile(cwd, "memory/ledger.json");
}

/** Reserved now so global memory can use the same ledger format without adding a second schema. */
export function globalMemoryLedgerPath(): string {
  return configPath("memory/global-ledger.json");
}

export function emptyMemoryLedger(at = new Date().toISOString()): MemoryLedger {
  return { version: MEMORY_LEDGER_VERSION, records: [], proposals: [], decisions: [], migrated_from: null, updated_at: at };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function validScope(value: unknown): MemoryScope {
  return memoryScopes.includes(value as MemoryScope) ? value as MemoryScope : "project";
}

function validEvidenceKind(value: unknown): MemoryEvidenceKind {
  return memoryEvidenceKinds.includes(value as MemoryEvidenceKind) ? value as MemoryEvidenceKind : "message";
}

function evidenceId(kind: MemoryEvidenceKind, locator: string): string {
  return `evidence:${kind}:${locator}`;
}

function fallbackMemoryId(value: Record<string, unknown>): string {
  return `memory-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function normalizeEvidence(value: unknown, capturedAt: string, fallback: { projectId?: string | null; sessionId?: string | null } = {}): MemoryEvidence | null {
  const input = recordValue(value);
  const kind = validEvidenceKind(input.kind);
  const locator = stringValue(input.locator);
  if (!locator) return null;
  return {
    ...input,
    id: stringValue(input.id, evidenceId(kind, locator)),
    kind,
    locator,
    project_id: nullableString(input.project_id) ?? fallback.projectId ?? null,
    session_id: nullableString(input.session_id) ?? fallback.sessionId ?? null,
    message_id: nullableString(input.message_id),
    path: nullableString(input.path),
    line_start: numberOrNull(input.line_start),
    line_end: numberOrNull(input.line_end),
    artifact_id: nullableString(input.artifact_id),
    version: numberOrNull(input.version),
    run_id: nullableString(input.run_id),
    citation: nullableString(input.citation),
    sha256: nullableString(input.sha256),
    excerpt: nullableString(input.excerpt),
    captured_at: stringValue(input.captured_at, capturedAt),
  };
}

function derivedEvidence(source: Pick<MemorySource, "project_id" | "session_id" | "message_ids" | "files" | "run_ids" | "citations">, capturedAt: string): MemoryEvidence[] {
  const result: MemoryEvidence[] = [];
  for (const messageId of source.message_ids) {
    const locator = source.session_id ? `${source.session_id}@${messageId}` : messageId;
    result.push({ id: evidenceId("message", locator), kind: "message", locator, project_id: source.project_id ?? null, session_id: source.session_id ?? null, message_id: messageId, captured_at: capturedAt });
  }
  for (const path of source.files) result.push({ id: evidenceId("file", path), kind: "file", locator: path, project_id: source.project_id ?? null, path, captured_at: capturedAt });
  for (const runId of source.run_ids) result.push({ id: evidenceId("run", runId), kind: "run", locator: runId, project_id: source.project_id ?? null, run_id: runId, captured_at: capturedAt });
  for (const citation of source.citations) result.push({ id: evidenceId("citation", citation), kind: "citation", locator: citation, project_id: source.project_id ?? null, citation, captured_at: capturedAt });
  return result;
}

function normalizeSource(value: unknown, fallback: { projectId?: string | null; sessionId?: string | null; at: string }): MemorySource {
  const input = recordValue(value);
  const source: MemorySource = {
    ...input,
    project_id: nullableString(input.project_id) ?? fallback.projectId ?? null,
    session_id: nullableString(input.session_id) ?? fallback.sessionId ?? null,
    message_ids: stringList(input.message_ids),
    files: stringList(input.files),
    run_ids: stringList(input.run_ids),
    citations: stringList(input.citations),
    evidence: [],
  };
  const seen = new Set<string>();
  const add = (evidence: MemoryEvidence) => {
    const key = `${evidence.kind}:${evidence.locator}`;
    if (seen.has(key)) return;
    seen.add(key);
    source.evidence.push(evidence);
  };
  for (const item of Array.isArray(input.evidence) ? input.evidence : []) {
    const evidence = normalizeEvidence(item, fallback.at, { projectId: source.project_id, sessionId: source.session_id });
    if (evidence) add(evidence);
  }
  for (const evidence of derivedEvidence(source, fallback.at)) add(evidence);
  return source;
}

function defaultApproval(status: string, required: ApprovalRequirement = "manual"): MemoryApproval {
  if (status === "pending") return { required, status: "pending", actor: null, decided_at: null, reason: null, policy_version: null };
  if (status === "rejected") return { required, status: "rejected", actor: "legacy", decided_at: null, reason: null, policy_version: null };
  return { required, status: "approved", actor: "legacy", decided_at: null, reason: "Migrated from accepted project knowledge", policy_version: null };
}

function normalizeApproval(value: unknown, status: string): MemoryApproval {
  const input = recordValue(value);
  const required = input.required === "explicit_user" || input.required === "policy" ? input.required : "manual";
  const approvalStatus = input.status === "pending" || input.status === "rejected" || input.status === "approved"
    ? input.status
    : defaultApproval(status, required).status;
  return {
    required,
    status: approvalStatus,
    actor: nullableString(input.actor) ?? defaultApproval(status, required).actor,
    decided_at: nullableString(input.decided_at) ?? defaultApproval(status, required).decided_at,
    reason: nullableString(input.reason) ?? defaultApproval(status, required).reason,
    policy_version: nullableString(input.policy_version),
  };
}

export function normalizeMemoryRecord(value: unknown, fallback: { scope?: MemoryScope; projectId?: string | null; sessionId?: string | null; at?: string } = {}): MemoryRecord {
  const input = recordValue(value);
  const at = fallback.at ?? new Date().toISOString();
  const status = stringValue(input.status, "active") as MemoryStatus | string;
  const kind = stringValue(input.kind, stringValue(input.type, "finding"));
  return {
    ...input,
    id: stringValue(input.id, fallbackMemoryId(input)),
    scope: validScope(input.scope ?? fallback.scope),
    project_id: nullableString(input.project_id) ?? fallback.projectId ?? null,
    session_id: nullableString(input.session_id) ?? fallback.sessionId ?? null,
    kind,
    type: stringValue(input.type, kind),
    title: stringValue(input.title, "Untitled memory"),
    summary: stringValue(input.summary),
    confidence: stringValue(input.confidence, "medium"),
    importance: stringValue(input.importance, "normal"),
    status,
    source: normalizeSource(input.source, { projectId: nullableString(input.project_id) ?? fallback.projectId ?? null, sessionId: nullableString(input.session_id) ?? fallback.sessionId ?? null, at }),
    related_files: stringList(input.related_files),
    conflicts_with: stringList(input.conflicts_with),
    supersedes: stringList(input.supersedes),
    approval: normalizeApproval(input.approval, status),
    created_at: stringValue(input.created_at, at),
    updated_at: stringValue(input.updated_at, at),
  };
}

export function normalizeMemoryProposal(value: unknown, fallback: { scope?: MemoryScope; projectId?: string | null; sessionId?: string | null; at?: string } = {}): MemoryProposal {
  const input = recordValue(value);
  const proposalType = input.proposal_type === "file_operation" ? "file_operation" : "knowledge";
  const kind = stringValue(input.kind, stringValue(input.knowledge_type, stringValue(input.type, proposalType === "file_operation" ? "file_operation" : "finding")));
  const record = normalizeMemoryRecord({ ...input, kind, type: stringValue(input.type, kind), status: stringValue(input.status, "pending") }, fallback);
  return {
    ...record,
    proposal_type: proposalType,
    knowledge_type: stringValue(input.knowledge_type, kind),
    reason: stringValue(input.reason),
    operations: Array.isArray(input.operations) ? input.operations : [],
    decision_reason: nullableString(input.decision_reason),
    applied_history_id: nullableString(input.applied_history_id),
  };
}

function acceptedRecordFromProposal(proposal: MemoryProposal, at: string): MemoryRecord | null {
  if (proposal.proposal_type !== "knowledge" || proposal.status !== "accepted") return null;
  const recordId = `knowledge-${proposal.id.replace(/^proposal-/, "")}`;
  return normalizeMemoryRecord({
    ...proposal,
    id: recordId,
    kind: proposal.knowledge_type ?? proposal.kind,
    type: proposal.knowledge_type ?? proposal.type,
    status: "active",
    proposal_id: proposal.id,
    approval: { required: "manual", status: "approved", actor: "legacy", decided_at: proposal.updated_at || at, reason: "Migrated from accepted project knowledge", policy_version: null },
    created_at: proposal.updated_at || proposal.created_at || at,
    updated_at: proposal.updated_at || proposal.created_at || at,
  }, { scope: proposal.scope, projectId: proposal.project_id, sessionId: proposal.session_id, at });
}

/** Convert the old project-state memory arrays into the canonical ledger shape. */
export function migrateProjectStateMemory(value: unknown, at = new Date().toISOString()): MemoryLedger {
  const input = recordValue(value);
  const proposals = (Array.isArray(input.proposals) ? input.proposals : []).map((item) => normalizeMemoryProposal(item, { scope: "project", at }));
  const records = (Array.isArray(input.items) ? input.items : []).map((item) => normalizeMemoryRecord(item, { scope: "project", at }));
  const recordProposalIds = new Set(records.map((item) => item.proposal_id).filter((id): id is string => typeof id === "string"));
  for (const proposal of proposals) {
    const record = acceptedRecordFromProposal(proposal, at);
    if (record && !recordProposalIds.has(proposal.id)) {
      records.push(record);
      recordProposalIds.add(proposal.id);
    }
  }
  return {
    version: MEMORY_LEDGER_VERSION,
    records,
    proposals,
    decisions: (Array.isArray(input.decisions) ? input.decisions : []).map((item) => normalizeDecision(item, at)).filter((item): item is MemoryDecision => item !== null),
    migrated_from: { path: "project-state.json", migrated_at: at },
    updated_at: at,
  };
}

function normalizeDecision(value: unknown, at: string): MemoryDecision | null {
  const input = recordValue(value);
  const action = ["accepted", "rejected", "repaired", "superseded", "archived"].includes(String(input.action))
    ? input.action as MemoryDecision["action"]
    : null;
  const targetId = stringValue(input.target_id);
  if (!action || !targetId) return null;
  return { ...input, id: stringValue(input.id, `decision-${targetId}-${at}`), target_id: targetId, action, actor: stringValue(input.actor, "system"), reason: nullableString(input.reason), created_at: stringValue(input.created_at, at) };
}

export function normalizeMemoryLedger(value: unknown, at = new Date().toISOString()): MemoryLedger {
  const input = recordValue(value);
  if (input.version !== MEMORY_LEDGER_VERSION) throw new Error(`Unsupported memory ledger version: ${String(input.version ?? "missing")}`);
  const records = (Array.isArray(input.records) ? input.records : []).map((item) => normalizeMemoryRecord(item, { scope: "project", at }));
  const proposals = (Array.isArray(input.proposals) ? input.proposals : []).map((item) => normalizeMemoryProposal(item, { scope: "project", at }));
  const recordProposalIds = new Set(records.map((item) => item.proposal_id).filter((id): id is string => typeof id === "string"));
  for (const proposal of proposals) {
    const record = acceptedRecordFromProposal(proposal, at);
    if (record && !recordProposalIds.has(proposal.id)) {
      records.push(record);
      recordProposalIds.add(proposal.id);
    }
  }
  return {
    version: MEMORY_LEDGER_VERSION,
    records,
    proposals,
    decisions: (Array.isArray(input.decisions) ? input.decisions : []).map((item) => normalizeDecision(item, at)).filter((item): item is MemoryDecision => item !== null),
    migrated_from: input.migrated_from && typeof input.migrated_from === "object"
      ? { path: stringValue((input.migrated_from as Record<string, unknown>).path, "project-state.json"), migrated_at: stringValue((input.migrated_from as Record<string, unknown>).migrated_at, at) }
      : null,
    updated_at: stringValue(input.updated_at, at),
  };
}

async function readLedgerFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid memory ledger JSON: ${path}`);
    throw error;
  }
}

/** Read a project ledger while holding its lock; the first read lazily migrates legacy memory. */
export async function readMemoryLedgerUnlocked(cwd: string): Promise<MemoryLedger> {
  const path = projectMemoryLedgerPath(cwd);
  const stored = await readLedgerFile(path);
  if (stored !== null) return normalizeMemoryLedger(stored);
  const legacy = await readJson<Record<string, unknown>>(workspaceFile(cwd, "project-state.json"), {});
  // Normalize once more before persisting so the first read and all later
  // reads expose exactly the same evidence shape.
  const migrated = normalizeMemoryLedger(migrateProjectStateMemory(legacy));
  await writeJsonAtomic(path, migrated);
  return migrated;
}

export async function readMemoryLedger(cwd: string): Promise<MemoryLedger> {
  return withFileWriteLock(projectMemoryLedgerPath(cwd), () => readMemoryLedgerUnlocked(cwd));
}

export async function writeMemoryLedgerUnlocked(cwd: string, ledger: MemoryLedger): Promise<MemoryLedger> {
  const next = normalizeMemoryLedger({ ...ledger, updated_at: new Date().toISOString() });
  await writeJsonAtomic(projectMemoryLedgerPath(cwd), next);
  return next;
}

export async function writeMemoryLedger(cwd: string, ledger: MemoryLedger): Promise<MemoryLedger> {
  return withFileWriteLock(projectMemoryLedgerPath(cwd), () => writeMemoryLedgerUnlocked(cwd, ledger));
}
