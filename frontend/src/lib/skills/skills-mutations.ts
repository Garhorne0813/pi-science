import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";
import { settingsKey } from "../settings/settings-api";

export interface ProjectSkillInput {
  name: string;
  description: string;
  body?: string;
  version?: string;
  license?: string;
  category?: string;
}

export interface SkillUploadCandidate {
  name: string;
  root_path: string;
  description: string;
  files: Array<{ path: string; size: number }>;
}

export interface GithubSkillCandidate {
  name: string;
  root_path: string;
  description: string;
  files: Array<{ path: string; size: number }>;
}

export interface SkillMutationResponse {
  ok: boolean;
  skill?: unknown;
  candidates?: SkillUploadCandidate[];
  imported?: unknown[];
  skipped?: Array<{ name: string; reason: string }>;
  error?: string;
}

function skillCwd(cwd: string): string {
  return `?cwd=${encodeURIComponent(cwd)}`;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function writeSkill<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  return apiRequest<T>(url, { ...init, errorFallback: fallback });
}

function invalidateAfterWrite(): void {
  void queryClient.invalidateQueries({ queryKey: settingsKey("skills") });
  void queryClient.invalidateQueries({ queryKey: settingsKey() });
}

export const skillsMutations = {
  async create(cwd: string, input: ProjectSkillInput): Promise<SkillMutationResponse> {
    const result = await writeSkill<SkillMutationResponse>(`/api/settings/skills${skillCwd(cwd)}`, json("POST", input), "Unable to create skill");
    invalidateAfterWrite();
    return result;
  },

  async update(cwd: string, skillId: string, input: ProjectSkillInput): Promise<SkillMutationResponse> {
    const result = await writeSkill<SkillMutationResponse>(`/api/settings/skills/${encodeURIComponent(skillId)}${skillCwd(cwd)}`, json("PUT", input), "Unable to update skill");
    invalidateAfterWrite();
    return result;
  },

  async remove(cwd: string, skillId: string): Promise<SkillMutationResponse> {
    const result = await writeSkill<SkillMutationResponse>(`/api/settings/skills/${encodeURIComponent(skillId)}${skillCwd(cwd)}`, { method: "DELETE" }, "Unable to delete skill");
    invalidateAfterWrite();
    return result;
  },

  async previewUpload(cwd: string, filename: string, contentBase64: string): Promise<SkillMutationResponse> {
    return writeSkill<SkillMutationResponse>(`/api/settings/skills/upload/preview${skillCwd(cwd)}`, json("POST", { filename, content_base64: contentBase64 }), "Unable to preview skill upload");
  },

  async importUpload(cwd: string, filename: string, contentBase64: string, rootPath: string): Promise<SkillMutationResponse> {
    const result = await writeSkill<SkillMutationResponse>(`/api/settings/skills/upload/import${skillCwd(cwd)}`, json("POST", { filename, content_base64: contentBase64, root_path: rootPath }), "Unable to import skill upload");
    invalidateAfterWrite();
    return result;
  },

  async previewGithub(repo: string): Promise<SkillMutationResponse> {
    return writeSkill<SkillMutationResponse>("/api/settings/skills/import-github/preview", json("POST", { repo }), "Unable to preview GitHub skills");
  },

  async importGithub(cwd: string, repo: string, selected: string[]): Promise<SkillMutationResponse> {
    const result = await writeSkill<SkillMutationResponse>(`/api/settings/skills/import-github/import${skillCwd(cwd)}`, json("POST", { repo, selected }), "Unable to import GitHub skills");
    invalidateAfterWrite();
    return result;
  },
};