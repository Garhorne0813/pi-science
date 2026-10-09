import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

// Runtime bookkeeping and dependency/cache trees are not research activity.
// Session activity is read separately, including relocated session storage.
const ignoredDirectories = new Set([".pi-science", ".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"]);

/** Include nested file edits and directory changes (e.g. deletion), without
 * following symlinks into other workspaces or counting read/access times. */
export async function latestWorkspaceFileActivity(root: string, rootModified: number): Promise<number> {
  let latest = rootModified;
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && ignoredDirectories.has(entry.name))) continue;
      const path = join(directory, entry.name);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
        latest = Math.max(latest, info.mtimeMs);
        if (info.isDirectory()) directories.push(path);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }
  return latest;
}
