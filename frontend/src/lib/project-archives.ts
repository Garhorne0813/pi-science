import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client/api";
type ProjectArchive = {
  id: string;
  title: string;
  objective: string;
  status: string;
  path: string;
  record_count: number;
};
export function useProjectArchives(cwd: string) {
  return useQuery({
    queryKey: ["project-archives", cwd],
    queryFn: () =>
      apiRequest<{ archives: ProjectArchive[] }>(
        `/api/project/archives?cwd=${encodeURIComponent(cwd)}`,
      ),
  });
}
export const projectArchiveApi = {
  exportArchive(cwd: string, id: string) {
    return apiRequest<{ archive: ProjectArchive }>(
      `/api/project/archives/${encodeURIComponent(id)}/export?cwd=${encodeURIComponent(cwd)}`,
      { method: "POST" },
    );
  },
};
