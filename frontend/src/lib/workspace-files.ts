import type { FileListEntry } from "../components/sidebar/FileContextMenu";
import { apiRequest } from "./api";
import { queryClient } from "./query-client";

export interface Breadcrumb { name: string; path: string }

export const workspaceFilesKey = (...selector: string[]) => ["workspace-files", ...selector];

// Entries and breadcrumbs are always read together and always shown together, so
// they are one cache entry — that is also what shares the request between the
// sidebar and the files page (the role the old directoryLoads map played).
const directoryQuery = (cwd: string, subdir: string) => ({
  queryKey: workspaceFilesKey(cwd, subdir),
  queryFn: async () => {
    const params = new URLSearchParams({ cwd });
    if (subdir) params.set("subdir", subdir);
    const [entries, breadcrumbs] = await Promise.all([
      apiRequest<FileListEntry[]>(`/api/files?${params}`),
      apiRequest<Breadcrumb[]>(`/api/files/breadcrumbs?cwd=${encodeURIComponent(cwd)}&subdir=${encodeURIComponent(subdir)}`),
    ]);
    return { entries, breadcrumbs };
  },
});

export const workspaceFiles = {
  invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: workspaceFilesKey() });
  },

  async directory(cwd: string, subdir = "", signal?: AbortSignal): Promise<{ entries: FileListEntry[]; breadcrumbs: Breadcrumb[] }> {
    // The shared request is never aborted by one observer leaving; the caller that
    // gave up simply stops caring about the result.
    const result = await queryClient.fetchQuery(directoryQuery(cwd, subdir));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  },

  async sidebar(cwd: string, signal?: AbortSignal): Promise<FileListEntry[]> {
    const { entries } = await this.directory(cwd, "", signal);
    return entries.filter((entry) => !entry.name.startsWith(".")).slice(0, 30);
  },

  async remove(cwd: string, path: string): Promise<void> {
    await apiRequest(`/api/files/${encodeURIComponent(path)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });
    this.invalidate();
  },

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  },
};
