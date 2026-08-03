import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export const skillsKey = (...selector: Array<string | null>) => ["skills", ...selector];

export interface SkillRequirementProbe {
  name: string;
  kind: string;
  optional: boolean;
  version?: string | null;
  status: "ready" | "missing" | "missing-optional" | "not-probed";
  reason?: string;
  hint?: string;
}

export interface SkillReadiness {
  skill_id: string;
  ready: boolean;
  requirements: SkillRequirementProbe[];
}

const listQuery = <T,>(cwd: string) => ({ queryKey: skillsKey("list", cwd), queryFn: () => apiRequest<T[]>(`/api/skills?cwd=${encodeURIComponent(cwd)}`) });

/** Skill dependency readiness — cached per skill id + workspace. */
export const skillReadinessKey = (skillId: string, cwd: string | null) => skillsKey("readiness", skillId, cwd);

export const skillsApi = {
  async list<T = unknown>(cwd?: string): Promise<T[]> {
    if (!cwd) return [];
    return queryClient.fetchQuery(listQuery<T>(cwd));
  },

  /** Scientific tool detection — workspace independent, same 3s TTL as the skill list. */
  tools<T = unknown>(): Promise<T[]> {
    return queryClient.fetchQuery({ queryKey: skillsKey("tools"), queryFn: () => apiRequest<T[]>("/api/skills/tools") });
  },

  /** Dependency readiness for one skill (blocked/ready + per-requirement probes). */
  readiness<T = SkillReadiness>(skillId: string, cwd?: string): Promise<T> {
    const cwdPart = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return queryClient.fetchQuery({
      queryKey: skillReadinessKey(skillId, cwd ?? null),
      queryFn: () => apiRequest<T>(`/api/skills/${encodeURIComponent(skillId)}/readiness${cwdPart}`),
    });
  },
};
