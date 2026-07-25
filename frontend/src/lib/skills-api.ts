export const skillsApi = {
  async list<T = unknown>(cwd?: string): Promise<T[]> {
    if (!cwd) return [];
    const response = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
    const data = await response.json().catch(() => ({})) as T[] & { error?: string; detail?: string };
    if (!response.ok) throw new Error(data.error || data.detail || "Unable to load skills");
    return data;
  },
};
