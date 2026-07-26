import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./api";
import { queryClient } from "./query-client";

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

/** Every project-knowledge read shares this prefix so one mutation invalidates them all. */
export const projectKnowledgeKey = (...selector: Array<string | null>) => ["project-knowledge", ...selector];

// This resource kept a 5s TTL where the rest of the app used 3s; preserved here.
const KNOWLEDGE_STALE_MS = 5_000;

function read<T>(queryKey: Array<string | null>, path: string) {
  return { queryKey, queryFn: () => apiRequest<T>(path), staleTime: KNOWLEDGE_STALE_MS };
}

/** Imperative read for non-component callers; shares the cache with the hooks below. */
function get<T>(queryKey: Array<string | null>, path: string): Promise<T> {
  return queryClient.fetchQuery(read<T>(queryKey, path));
}

/** Writes go straight to the transport, then drop the whole resource from cache. */
async function write<T>(path: string, init: RequestInit): Promise<T> {
  const data = await apiRequest<T>(path, init);
  void queryClient.invalidateQueries({ queryKey: projectKnowledgeKey() });
  return data;
}

function query(cwd: string, extra?: Record<string, string>) {
  return new URLSearchParams({ cwd, ...(extra ?? {}) }).toString();
}

const proposalCountQuery = (cwd: string) => read<{ pending_count: number }>(projectKnowledgeKey("proposals-count", cwd), `/api/project-knowledge/proposals/count?${query(cwd)}`);

const fileViewsQuery = (cwd: string) => read<LogicalFileViews>(projectKnowledgeKey("file-views", cwd), `/api/project-knowledge/files/views?${query(cwd)}`);

/** Logical file views: mounted only by the files tab, refreshed by the write invalidation. */
export function useLogicalFileViews(cwd: string) {
  return useQuery(fileViewsQuery(cwd));
}

/** Pending-proposal badge: polled, not pushed — the server has no signal for it. */
export function usePendingProposalCount(cwd: string, refetchIntervalMs: number) {
  return useQuery({ ...proposalCountQuery(cwd), refetchInterval: refetchIntervalMs });
}

export const projectKnowledgeApi = {
  summary(cwd: string) {
    return get<ProjectSummary>(projectKnowledgeKey("summary", cwd), `/api/project-knowledge/summary?${query(cwd)}`);
  },
  project(cwd: string) {
    return get<ProjectSummary & { content: string }>(projectKnowledgeKey("project", cwd), `/api/project-knowledge/project?${query(cwd)}`);
  },
  projectVersions(cwd: string) {
    return get<{ versions: Array<{ id: string; created_at: string; reason: string; knowledge_count: number }> }>(projectKnowledgeKey("project-versions", cwd), `/api/project-knowledge/project/versions?${query(cwd)}`);
  },
  restoreProjectVersion(cwd: string, versionId: string) {
    return write<Record<string, unknown>>(`/api/project-knowledge/project/versions/${versionId}/restore?${query(cwd)}`, {
      method: "POST",
    });
  },
  proposals(cwd: string, status?: ProposalStatus) {
    const extra = status ? { status } : undefined;
    return get<{ proposals: Proposal[]; pending_count: number }>(projectKnowledgeKey("proposals", cwd, status ?? null), `/api/project-knowledge/proposals?${query(cwd, extra)}`);
  },
  proposalCount(cwd: string) {
    return queryClient.fetchQuery(proposalCountQuery(cwd));
  },
  items(cwd: string) {
    return get<{ items: KnowledgeItem[] }>(projectKnowledgeKey("items", cwd), `/api/project-knowledge/items?${query(cwd)}`);
  },
  review(cwd: string, sessionId?: string | null, forceFullSession = false) {
    return write<{ run_id: string; created: number; skipped: number; proposal_ids: string[]; message: string }>(
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
    return write<{ proposal: Proposal }>(`/api/project-knowledge/proposals/${proposalId}?${query(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
  },
  previewProposal(cwd: string, proposalId: string) {
    return get<Record<string, unknown>>(projectKnowledgeKey("proposal-preview", cwd, proposalId), `/api/project-knowledge/proposals/${proposalId}/preview?${query(cwd)}`);
  },
  accept(cwd: string, proposalId: string, edits?: { title?: string; summary?: string }) {
    return write<Record<string, unknown>>(`/api/project-knowledge/proposals/${proposalId}/accept?${query(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edits ?? {}),
    });
  },
  reject(cwd: string, proposalId: string, reason?: string) {
    return write<Record<string, unknown>>(`/api/project-knowledge/proposals/${proposalId}/reject?${query(cwd)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  },
  batch(cwd: string, proposalIds: string[], action: "accept" | "reject") {
    return write<{ ok: boolean; failures: Array<{ proposal_id: string; detail: string }> }>(
      `/api/project-knowledge/proposals/batch?${query(cwd)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal_ids: proposalIds, action }),
      },
    );
  },
  policy(cwd: string) {
    return get<ProjectPolicy>(projectKnowledgeKey("policy", cwd), `/api/project-knowledge/policy?${query(cwd)}`);
  },
  updatePolicy(cwd: string, changes: Partial<ProjectPolicy>) {
    return write<ProjectPolicy>(`/api/project-knowledge/policy?${query(cwd)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
  },
  files(cwd: string) {
    return queryClient.fetchQuery(fileViewsQuery(cwd));
  },
  history(cwd: string) {
    return get<{ history: Array<Record<string, unknown>> }>(projectKnowledgeKey("history", cwd), `/api/project-knowledge/history?${query(cwd)}`);
  },
  undo(cwd: string, historyId: string) {
    return write<Record<string, unknown>>(`/api/project-knowledge/file-operations/${historyId}/undo?${query(cwd)}`, {
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
