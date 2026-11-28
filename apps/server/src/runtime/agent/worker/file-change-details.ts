import { createTwoFilesPatch, diffLines } from "diff";

export interface ToolFileChange {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  truncated?: boolean;
}

const MAX_PATCH_CHARS = 100_000;

/** Build immutable, per-tool line statistics. Unlike Git decorations these
 * describe one completed mutation and therefore survive a later commit. */
export function toolFileChange(path: string, before: string, after: string): ToolFileChange {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(before, after)) {
    if (change.added) additions += change.count ?? 0;
    if (change.removed) deletions += change.count ?? 0;
  }
  const completePatch = createTwoFilesPatch(path, path, before, after, "before", "after", {
    context: 3,
  });
  const truncated = completePatch.length > MAX_PATCH_CHARS;
  return {
    path,
    additions,
    deletions,
    patch: truncated ? completePatch.slice(0, MAX_PATCH_CHARS) : completePatch,
    ...(truncated ? { truncated: true } : {}),
  };
}
