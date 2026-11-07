import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isWithin } from "./policy.js";

export const CREDENTIAL_NAMES = [
  ".pi-science",
  ".pi",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".modal.toml",
  "credentials.json",
  "credentials.toml",
  ".env",
  ".env.*",
] as const;
export interface CredentialDenies {
  paths: string[];
  directories: number;
  entries: number;
}

export async function expandCredentialDenies(
  roots: string[],
  names: readonly string[],
  alreadyDenied: readonly string[],
): Promise<CredentialDenies> {
  const exact = new Set(names);
  const envPrefix = exact.delete(".env.*");
  const visited = new Set<string>();
  const found = new Set<string>();
  let directories = 0;
  let entries = 0;
  for (const root of roots) {
    const denied = new Set(alreadyDenied.filter((path) => path !== root && isWithin(root, path)));
    const covered = (path: string) => {
      for (;;) {
        if (denied.has(path)) return true;
        const parent = dirname(path);
        if (parent === path) return false;
        path = parent;
      }
    };
    let pending = [await realpath(root).catch(() => root)];
    const visit = async (directory: string) => {
      if (visited.has(directory) || covered(directory)) return;
      visited.add(directory);
      let listing;
      try {
        listing = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") found.add(directory);
        return;
      }
      directories++;
      entries += listing.length;
      for (const entry of listing) {
        const matched = exact.has(entry.name) || (envPrefix && entry.name.startsWith(".env."));
        if (!matched && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (matched) found.add(path);
        if (entry.isSymbolicLink()) {
          try {
            const target = await realpath(path);
            if (
              !isWithin(target, directory) &&
              !covered(path) &&
              !covered(target) &&
              (await stat(target)).isDirectory()
            )
              pending.push(target);
          } catch {
            /* Unresolved links have no directory tree to inspect. */
          }
        } else if (entry.isDirectory() && !matched && !covered(path)) pending.push(path);
      }
    };
    while (pending.length) {
      const level = pending;
      pending = [];
      for (let offset = 0; offset < level.length; offset += 16)
        await Promise.all(level.slice(offset, offset + 16).map(visit));
    }
  }
  const kept = new Set<string>();
  for (const path of [...found].sort()) {
    let covered = false;
    for (let parent = dirname(path); parent !== path; parent = dirname(parent)) {
      if (kept.has(parent)) {
        covered = true;
        break;
      }
      if (dirname(parent) === parent) break;
    }
    if (!covered) kept.add(path);
  }
  return { paths: [...kept], directories, entries };
}
