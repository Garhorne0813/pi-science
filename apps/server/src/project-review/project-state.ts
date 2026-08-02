// Shared accessor for the workspace project-knowledge state document. Both the
// project-knowledge routes and the reviewer that appends proposals to the inbox
// read and write it, so the shape lives here rather than inside either caller.
import { readJson, withFileWriteLock, writeJsonAtomic, workspaceFile } from "../storage/persistence.js";
import {
  normalizeMemoryRecord,
  projectMemoryLedgerPath,
  readMemoryLedgerUnlocked,
  type MemoryProposal,
  type MemoryRecord,
  type MemorySource,
  type MemoryDecision,
  writeMemoryLedgerUnlocked,
} from "../memory/ledger.js";

export type Source = MemorySource;
export type Policy = { auto_review: boolean; reminder_threshold: number; max_directory_depth: number; minimum_files_for_new_category: number; locked_paths: string[]; naming_pattern: string; accepted_counts: Record<string, number>; rejected_counts: Record<string, number>; external_services_allowed: boolean; allowed_egress_domains: string[]; blocked_data_classes: string[]; updated_at: string };
export type Item = MemoryRecord;
export type Proposal = MemoryProposal;
export type ProjectState = { items: Item[]; proposals: Proposal[]; decisions: MemoryDecision[]; project_versions: Array<{ id: string; created_at: string; reason: string; knowledge_count: number; content: string }>; policy: Policy; history: Array<Record<string, unknown>> };

// `auto_review` defaults to false: an automatic model call after every settled turn spends the
// user's budget, so it must be opted into. A workspace that already stored a policy keeps its own
// value — readProjectState only falls back to these defaults for keys the state file does not have.
export const defaultPolicy = (): Policy => ({ auto_review: false, reminder_threshold: 5, max_directory_depth: 3, minimum_files_for_new_category: 3, locked_paths: [], naming_pattern: "{date}_{topic}_{kind}_{version}", accepted_counts: {}, rejected_counts: {}, external_services_allowed: true, allowed_egress_domains: [], blocked_data_classes: [], updated_at: new Date().toISOString() });
export function statePath(cwd: string): string { return workspaceFile(cwd, "project-state.json"); }
export function timestamp(): string { return new Date().toISOString(); }

/** Convert an accepted knowledge proposal into the canonical knowledge item shape.
 *  The deterministic id also lets older states affected by the batch-accept bug be
 *  repaired repeatedly without creating duplicates. */
export function knowledgeItemFromProposal(proposal: Proposal): Item {
  const at = proposal.updated_at || proposal.created_at || timestamp();
  return normalizeMemoryRecord({
    ...proposal,
    id: `knowledge-${proposal.id.replace(/^proposal-/, "")}`,
    scope: proposal.scope ?? "project",
    type: proposal.knowledge_type ?? proposal.type ?? "finding",
    kind: proposal.knowledge_type ?? proposal.kind ?? proposal.type ?? "finding",
    title: proposal.title,
    summary: proposal.summary,
    confidence: proposal.confidence,
    importance: proposal.importance,
    status: "active",
    source: proposal.source,
    related_files: proposal.related_files,
    conflicts_with: proposal.conflicts_with,
    supersedes: proposal.supersedes,
    proposal_id: proposal.id,
    approval: { required: "manual", status: "approved", actor: "user", decided_at: at, reason: null, policy_version: null },
    created_at: at,
    updated_at: at,
  }, { scope: proposal.scope ?? "project", projectId: proposal.project_id, sessionId: proposal.session_id, at });
}

/** Idempotently materialize a knowledge item for a proposal. */
export function ensureKnowledgeItem(state: ProjectState, proposal: Proposal): Item | null {
  if (proposal.proposal_type !== "knowledge") return null;
  const existing = state.items.find((item) => item.proposal_id === proposal.id);
  if (existing) return existing;
  const item = knowledgeItemFromProposal(proposal);
  state.items.push(item);
  return item;
}

async function readProjectStateUnlocked(cwd: string): Promise<ProjectState> {
  const value = await readJson<Partial<ProjectState>>(statePath(cwd), {});
  const ledger = await readMemoryLedgerUnlocked(cwd);
  const current: ProjectState = {
    items: ledger.records,
    proposals: ledger.proposals,
    decisions: ledger.decisions,
    project_versions: Array.isArray(value.project_versions) ? value.project_versions : [],
    policy: { ...defaultPolicy(), ...(value.policy ?? {}) },
    history: Array.isArray(value.history) ? value.history : [],
  };

  // Compatibility repair for states written by the old batch endpoint, which
  // marked proposals accepted but never appended their knowledge items.
  for (const proposal of current.proposals) {
    if (proposal.status === "accepted") ensureKnowledgeItem(current, proposal);
  }
  return current;
}

/** Read project metadata and the canonical memory ledger under one workspace lock. */
export async function readProjectState(cwd: string): Promise<ProjectState> {
  return withFileWriteLock(projectMemoryLedgerPath(cwd), () => readProjectStateUnlocked(cwd));
}

async function persistProjectStateUnlocked(cwd: string, state: ProjectState): Promise<void> {
  const ledger = await readMemoryLedgerUnlocked(cwd);
  await writeMemoryLedgerUnlocked(cwd, { ...ledger, records: state.items, proposals: state.proposals, decisions: state.decisions });
  // Keep the old document as a compatibility projection for older clients and
  // local tooling. New memory reads always prefer memory/ledger.json.
  await writeJsonAtomic(statePath(cwd), state);
}

/** Persist both canonical memory and the legacy project-state projection. */
export async function writeProjectState(cwd: string, state: ProjectState): Promise<void> {
  await withFileWriteLock(projectMemoryLedgerPath(cwd), () => persistProjectStateUnlocked(cwd, state));
}

/** Serialize a read/modify/write operation so memory decisions cannot overwrite each other. */
export async function mutateProjectState<T>(cwd: string, operation: (state: ProjectState) => Promise<T> | T): Promise<T> {
  return withFileWriteLock(projectMemoryLedgerPath(cwd), async () => {
    const current = await readProjectStateUnlocked(cwd);
    const result = await operation(current);
    await persistProjectStateUnlocked(cwd, current);
    return result;
  });
}
