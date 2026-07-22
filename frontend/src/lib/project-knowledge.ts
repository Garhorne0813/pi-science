import { apiRequest, invalidateApiCache } from "./api";

export type KnowledgeType =
  | "finding"
  | "conclusion"
  | "decision"
  | "hypothesis"
  | "question"
  | "task"
  | "project_change"
  | "artifact";

export type ProposalStatus = "pending" | "accepted" | "rejected" | "failed" | "undone";

export interface SourceReference {
  session_id?: string | null;
  message_ids: string[];
  files: string[];
  run_ids: string[];
  citations: string[];
}

export interface FileOperation {
  type: "mkdir" | "move" | "rename";
  source?: string | null;
  target: string;
  reason?: string;
}

export interface Proposal {
  id: string;
  proposal_type: "knowledge" | "file_operation";
  knowledge_type?: KnowledgeType | null;
  title: string;
  summary: string;
  reason: string;
  confidence: "low" | "medium" | "high";
  importance: "normal" | "important" | "critical";
  source_message_ids: string[];
  related_files: string[];
  conflicts_with: string[];
  supersedes: string[];
  operations: FileOperation[];
  experience_ids?: string[];
  loop_ids?: string[];
  candidate_ids?: string[];
  evaluator_refs?: Array<Record<string, unknown>>;
  artifact_refs?: Array<Record<string, unknown>>;
  status: ProposalStatus;
  source: SourceReference;
  created_at: string;
  updated_at: string;
  decision_reason?: string | null;
  applied_history_id?: string | null;
}

export interface KnowledgeItem {
  id: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  confidence: "low" | "medium" | "high";
  importance: "normal" | "important" | "critical";
  status: "active" | "superseded" | "archived";
  source: SourceReference;
  related_files: string[];
  conflicts_with: string[];
  supersedes: string[];
  experience_ids?: string[];
  loop_ids?: string[];
  candidate_ids?: string[];
  evaluator_refs?: Array<Record<string, unknown>>;
  artifact_refs?: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary {
  workspace: string;
  project_file: string;
  pending_count: number;
  knowledge_count: number;
  auto_review: boolean;
}

export interface ProjectPolicy {
  auto_review: boolean;
  reminder_threshold: number;
  max_directory_depth: number;
  minimum_files_for_new_category: number;
  locked_paths: string[];
  naming_pattern: string;
  accepted_counts: Record<string, number>;
  rejected_counts: Record<string, number>;
  updated_at: string;
}

export interface IndexedFile {
  id: string;
  path: string;
  name: string;
  directory: string;
  extension: string;
  kind: string;
  size: number;
  modified: number;
  fingerprint: string;
  tags: string[];
}

export interface LogicalFileViews {
  updated_at: string;
  files: IndexedFile[];
  by_type: Record<string, IndexedFile[]>;
  by_topic: Record<string, IndexedFile[]>;
  by_month: Record<string, IndexedFile[]>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const data = await apiRequest<T>(path, { ...init, cacheTtlMs: init?.method ? 0 : 5000 });
  if (init?.method && init.method !== "GET") invalidateApiCache("/api/project-knowledge/");
  return data;
}

function query(cwd: string, extra?: Record<string, string>) {
  return new URLSearchParams({ cwd, ...(extra ?? {}) }).toString();
}

export const projectKnowledgeApi = {
  summary(cwd: string) {
    return request<ProjectSummary>(`/api/project-knowledge/summary?${query(cwd)}`);
  },
  project(cwd: string) {
    return request<ProjectSummary & { content: string }>(`/api/project-knowledge/project?${query(cwd)}`);
  },
  projectVersions(cwd: string) {
    return request<{ versions: Array<{ id: string; created_at: string; reason: string; knowledge_count: number }> }>(`/api/project-knowledge/project/versions?${query(cwd)}`);
  },
  restoreProjectVersion(cwd: string, versionId: string) {
    return request<Record<string, unknown>>(`/api/project-knowledge/project/versions/${versionId}/restore?${query(cwd)}`, {
      method: "POST",
    });
  },
  proposals(cwd: string, status?: ProposalStatus) {
    const extra = status ? { status } : undefined;
    return request<{ proposals: Proposal[]; pending_count: number }>(`/api/project-knowledge/proposals?${query(cwd, extra)}`);
  },
  proposalCount(cwd: string) {
    return request<{ pending_count: number }>(`/api/project-knowledge/proposals/count?${query(cwd)}`);
  },
  items(cwd: string) {
    return request<{ items: KnowledgeItem[] }>(`/api/project-knowledge/items?${query(cwd)}`);
  },
  review(cwd: string, sessionId?: string | null, forceFullSession = false) {
    return request<{ run_id: string; created: number; skipped: number; proposal_ids: string[]; message: string }>(
      "/api/project-knowledge/review",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          session_id: sessionId || null,
          include_files: true,
          force_full_session: forceFullSession,
        }),
      },
    );
  },
  updateProposal(cwd: string, proposalId: string, changes: Partial<Proposal>) {
    return request<{ proposal: Proposal }>(`/api/project-knowledge/proposals/${proposalId}?${query(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
  },
  previewProposal(cwd: string, proposalId: string) {
    return request<Record<string, unknown>>(`/api/project-knowledge/proposals/${proposalId}/preview?${query(cwd)}`);
  },
  accept(cwd: string, proposalId: string, edits?: { title?: string; summary?: string }) {
    return request<Record<string, unknown>>(`/api/project-knowledge/proposals/${proposalId}/accept?${query(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits ?? {}),
    });
  },
  reject(cwd: string, proposalId: string, reason?: string) {
    return request<Record<string, unknown>>(`/api/project-knowledge/proposals/${proposalId}/reject?${query(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  },
  batch(cwd: string, proposalIds: string[], action: "accept" | "reject") {
    return request<{ ok: boolean; failures: Array<{ proposal_id: string; detail: string }> }>(
      `/api/project-knowledge/proposals/batch?${query(cwd)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal_ids: proposalIds, action }),
      },
    );
  },
  policy(cwd: string) {
    return request<ProjectPolicy>(`/api/project-knowledge/policy?${query(cwd)}`);
  },
  updatePolicy(cwd: string, changes: Partial<ProjectPolicy>) {
    return request<ProjectPolicy>(`/api/project-knowledge/policy?${query(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
  },
  files(cwd: string) {
    return request<LogicalFileViews>(`/api/project-knowledge/files/views?${query(cwd)}`);
  },
  history(cwd: string) {
    return request<{ history: Array<Record<string, unknown>> }>(`/api/project-knowledge/history?${query(cwd)}`);
  },
  undo(cwd: string, historyId: string) {
    return request<Record<string, unknown>>(`/api/project-knowledge/file-operations/${historyId}/undo?${query(cwd)}`, {
      method: "POST",
    });
  },
};

export const KNOWLEDGE_LABELS: Record<KnowledgeType, string> = {
  finding: "Finding",
  conclusion: "Conclusion",
  decision: "Decision",
  hypothesis: "Hypothesis",
  question: "Open question",
  task: "Next step",
  project_change: "Project change",
  artifact: "Artifact",
};

export function groupKnowledgeItems(items: KnowledgeItem[]) {
  return items.reduce<Record<string, KnowledgeItem[]>>((groups, item) => {
    (groups[item.type] ??= []).push(item);
    return groups;
  }, {});
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
