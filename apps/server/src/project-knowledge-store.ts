import { readJson, withFileWriteLock, workspaceFile, writeJsonAtomic } from "./persistence.js";

export type Source = { session_id?: string | null; message_ids: string[]; files: string[]; run_ids: string[]; citations: string[] };
export type Policy = { auto_review: boolean; reminder_threshold: number; max_directory_depth: number; minimum_files_for_new_category: number; locked_paths: string[]; naming_pattern: string; accepted_counts: Record<string, number>; rejected_counts: Record<string, number>; external_services_allowed: boolean; allowed_egress_domains: string[]; blocked_data_classes: string[]; updated_at: string };
export type Item = { id: string; type: string; title: string; summary: string; confidence: string; importance: string; status: string; source: Source; related_files: string[]; conflicts_with: string[]; supersedes: string[]; proposal_id?: string; created_at: string; updated_at: string; [key: string]: unknown };
export type Proposal = Item & { proposal_type: "knowledge" | "file_operation"; knowledge_type?: string; reason: string; operations: unknown[]; decision_reason?: string | null; applied_history_id?: string | null };
export type ReviewCursor = { message_count: number; last_message_id: string | null; updated_at: string };
export type ReviewerRun = { id: string; session_id: string; status: "ok" | "error"; started_at: string; finished_at: string; duration_ms: number; created_count: number; skipped_count: number; rejected: Array<{ index: number; reason: string }>; error?: string };
export type ProjectState = {
  items: Item[];
  proposals: Proposal[];
  project_versions: Array<{ id: string; created_at: string; reason: string; knowledge_count: number; content: string }>;
  policy: Policy;
  history: Array<Record<string, unknown>>;
  review_cursors: Record<string, ReviewCursor>;
  reviewer_runs: ReviewerRun[];
};

export const MAX_REVIEWER_RUNS = 50;

export function defaultPolicy(): Policy {
  return { auto_review: true, reminder_threshold: 5, max_directory_depth: 3, minimum_files_for_new_category: 3, locked_paths: [], naming_pattern: "{date}_{topic}_{kind}_{version}", accepted_counts: {}, rejected_counts: {}, external_services_allowed: true, allowed_egress_domains: [], blocked_data_classes: [], updated_at: new Date().toISOString() };
}

export function statePath(cwd: string): string {
  return workspaceFile(cwd, "project-state.json");
}

export function now(): string {
  return new Date().toISOString();
}

export function source(value: unknown): Source {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    session_id: typeof input.session_id === "string" ? input.session_id : null,
    message_ids: Array.isArray(input.message_ids) ? input.message_ids.map(String) : [],
    files: Array.isArray(input.files) ? input.files.map(String) : [],
    run_ids: Array.isArray(input.run_ids) ? input.run_ids.map(String) : [],
    citations: Array.isArray(input.citations) ? input.citations.map(String) : [],
  };
}

/**
 * Every field the state file carries has to be listed here: reads normalize
 * into this shape and writes persist exactly it, so a key that is missing
 * would be silently dropped by the next route that saves.
 */
export async function readState(cwd: string): Promise<ProjectState> {
  const value = await readJson<Partial<ProjectState>>(statePath(cwd), {});
  return {
    items: Array.isArray(value.items) ? value.items : [],
    proposals: Array.isArray(value.proposals) ? value.proposals : [],
    project_versions: Array.isArray(value.project_versions) ? value.project_versions : [],
    policy: { ...defaultPolicy(), ...(value.policy ?? {}) },
    history: Array.isArray(value.history) ? value.history : [],
    review_cursors: value.review_cursors && typeof value.review_cursors === "object" ? value.review_cursors : {},
    reviewer_runs: Array.isArray(value.reviewer_runs) ? value.reviewer_runs : [],
  };
}

export async function writeState(cwd: string, value: ProjectState): Promise<void> {
  await writeJsonAtomic(statePath(cwd), value);
}

/**
 * Read-modify-write under the same advisory lock the artifact log uses, so a
 * reviewer run and a concurrent accept/reject cannot clobber one another.
 */
export async function updateState<T>(cwd: string, operation: (current: ProjectState) => Promise<T> | T): Promise<T> {
  return withFileWriteLock(statePath(cwd), async () => {
    const current = await readState(cwd);
    const result = await operation(current);
    await writeState(cwd, current);
    return result;
  });
}
