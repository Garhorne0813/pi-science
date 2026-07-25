import { apiRequest } from "./api";

export const skillsApi = {
  async list<T = unknown>(cwd?: string, signal?: AbortSignal): Promise<T[]> {
    if (!cwd) return [];
    return apiRequest<T[]>(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal, cacheTtlMs: 3000 });
  },
};
