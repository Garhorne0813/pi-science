import { readdir } from "node:fs/promises";
import { join } from "node:path";
export async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx|mjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).replaceAll("\\", "/"))
    .sort();
}
