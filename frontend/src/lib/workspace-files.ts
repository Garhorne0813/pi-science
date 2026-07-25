import type { FileListEntry } from "../components/sidebar/FileContextMenu";
import { apiRequest, invalidateApiCache } from "./api";

export interface Breadcrumb { name: string; path: string }

interface DirectoryResult { entries: FileListEntry[]; breadcrumbs: Breadcrumb[] }

const directoryLoads = new Map<string, Promise<DirectoryResult>>();

function loadDirectory(cwd: string, subdir: string): Promise<DirectoryResult> {
  const params = new URLSearchParams({ cwd });
  if (subdir) params.set("subdir", subdir);
  const key = params.toString();
  const activeLoad = directoryLoads.get(key);
  if (activeLoad) return activeLoad;

  const load = Promise.all([
    apiRequest<FileListEntry[]>(`/api/files?${params}`, { cacheTtlMs: 3000 }),
    apiRequest<Breadcrumb[]>(`/api/files/breadcrumbs?cwd=${encodeURIComponent(cwd)}&subdir=${encodeURIComponent(subdir)}`, { cacheTtlMs: 3000 }),
  ]).then(([entries, breadcrumbs]) => ({ entries, breadcrumbs }));
  directoryLoads.set(key, load);
  const clear = () => {
    if (directoryLoads.get(key) === load) directoryLoads.delete(key);
  };
  void load.then(clear, clear);
  return load;
}

export const workspaceFiles = {
  async directory(cwd: string, subdir = "", signal?: AbortSignal): Promise<{ entries: FileListEntry[]; breadcrumbs: Breadcrumb[] }> {
    const result = await loadDirectory(cwd, subdir);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  },

  async sidebar(cwd: string, signal?: AbortSignal): Promise<FileListEntry[]> {
    const { entries } = await this.directory(cwd, "", signal);
    return entries.filter((entry) => !entry.name.startsWith(".")).slice(0, 30);
  },

  async remove(cwd: string, path: string): Promise<void> {
    await apiRequest(`/api/files/${encodeURIComponent(path)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });
    invalidateApiCache("/api/files");
  },

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  },
};
