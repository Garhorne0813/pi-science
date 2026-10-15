import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export interface ProjectMemoryOverview {
  workspace: string;
  project_file: string;
  pending_count: number;
  knowledge_count: number;
  auto_review: boolean;
  run_count: number;
  artifact_count: number;
  result_review_count: number;
  research_record_count: number;
  research_loop_count: number;
  active_research_loop_count: number;
}

export interface MemoryArchive { id: string; title: string; objective: string; status: string; path: string; record_count: number }

function query(cwd: string) {
  return new URLSearchParams({ cwd }).toString();
}

/** Every project-memory read shares this prefix so one mutation invalidates them all. */
export const projectMemoryKey = (...selector: Array<string | null>) => ["project-memory", ...selector];

function read<T>(queryKey: Array<string | null>, path: string) {
  return { queryKey, queryFn: () => apiRequest<T>(path) };
}

/** Imperative read for non-component callers; shares the cache with the hooks below. */
function get<T>(queryKey: Array<string | null>, path: string): Promise<T> {
  return queryClient.fetchQuery(read<T>(queryKey, path));
}

export function useMemoryArchives(cwd: string) {
  return useQuery(read<{ archives: MemoryArchive[] }>(projectMemoryKey("archives", cwd), `/api/project-memory/archives?${query(cwd)}`));
}
export function useProjectTimeline(cwd: string, limit = 200) {
  return useQuery(read<{ timeline: Array<Record<string, unknown>> }>(projectMemoryKey("timeline", cwd, String(limit)), `/api/project-memory/timeline?${query(cwd)}&limit=${limit}`));
}

export const projectMemoryApi = {
  overview(cwd: string) {
    return get<ProjectMemoryOverview>(projectMemoryKey("overview", cwd), `/api/project-memory/overview?${query(cwd)}`);
  },
  exportArchive(cwd: string, id: string) {
    return apiRequest<{ archive: MemoryArchive }>(`/api/project-memory/archives/${encodeURIComponent(id)}/export?${query(cwd)}`, { method: "POST" });
  },
  archives(cwd: string) {
    return get<{ archives: MemoryArchive[] }>(projectMemoryKey("archives", cwd), `/api/project-memory/archives?${query(cwd)}`);
  },
};
