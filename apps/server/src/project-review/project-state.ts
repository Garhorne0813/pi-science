// Shared accessor for the workspace project-knowledge state document. Both the
// project-knowledge routes and the reviewer that appends proposals to the inbox
// read and write it, so the shape lives here rather than inside either caller.
import { readJson, workspaceFile } from "../persistence.js";

export type Source = { session_id?: string | null; message_ids: string[]; files: string[]; run_ids: string[]; citations: string[] };
export type Policy = { auto_review: boolean; reminder_threshold: number; max_directory_depth: number; minimum_files_for_new_category: number; locked_paths: string[]; naming_pattern: string; accepted_counts: Record<string, number>; rejected_counts: Record<string, number>; external_services_allowed: boolean; allowed_egress_domains: string[]; blocked_data_classes: string[]; updated_at: string };
export type Item = { id: string; type: string; title: string; summary: string; confidence: string; importance: string; status: string; source: Source; related_files: string[]; conflicts_with: string[]; supersedes: string[]; proposal_id?: string; created_at: string; updated_at: string; [key: string]: unknown };
export type Proposal = Item & { proposal_type: "knowledge" | "file_operation"; knowledge_type?: string; reason: string; operations: unknown[]; decision_reason?: string | null; applied_history_id?: string | null };
export type ProjectState = { items: Item[]; proposals: Proposal[]; project_versions: Array<{ id: string; created_at: string; reason: string; knowledge_count: number; content: string }>; policy: Policy; history: Array<Record<string, unknown>> };

// `auto_review` defaults to false: an automatic model call after every settled turn spends the
// user's budget, so it must be opted into. A workspace that already stored a policy keeps its own
// value — readProjectState only falls back to these defaults for keys the state file does not have.
export const defaultPolicy = (): Policy => ({ auto_review: false, reminder_threshold: 5, max_directory_depth: 3, minimum_files_for_new_category: 3, locked_paths: [], naming_pattern: "{date}_{topic}_{kind}_{version}", accepted_counts: {}, rejected_counts: {}, external_services_allowed: true, allowed_egress_domains: [], blocked_data_classes: [], updated_at: new Date().toISOString() });
export function statePath(cwd: string): string { return workspaceFile(cwd, "project-state.json"); }
export async function readProjectState(cwd: string): Promise<ProjectState> { const value = await readJson<Partial<ProjectState>>(statePath(cwd), {}); return { items: Array.isArray(value.items) ? value.items : [], proposals: Array.isArray(value.proposals) ? value.proposals : [], project_versions: Array.isArray(value.project_versions) ? value.project_versions : [], policy: { ...defaultPolicy(), ...(value.policy ?? {}) }, history: Array.isArray(value.history) ? value.history : [] }; }
export function timestamp(): string { return new Date().toISOString(); }
