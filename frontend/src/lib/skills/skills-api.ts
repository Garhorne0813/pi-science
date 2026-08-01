import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export const skillsKey = (...selector: Array<string | null>) => ["skills", ...selector];

const listQuery = <T,>(cwd: string) => ({ queryKey: skillsKey("list", cwd), queryFn: () => apiRequest<T[]>(`/api/skills?cwd=${encodeURIComponent(cwd)}`) });

export const skillsApi = {
  async list<T = unknown>(cwd?: string): Promise<T[]> {
    if (!cwd) return [];
    return queryClient.fetchQuery(listQuery<T>(cwd));
  },

  /** Scientific tool detection — workspace independent, same 3s TTL as the skill list. */
  tools<T = unknown>(): Promise<T[]> {
    return queryClient.fetchQuery({ queryKey: skillsKey("tools"), queryFn: () => apiRequest<T[]>("/api/skills/tools") });
  },
};
