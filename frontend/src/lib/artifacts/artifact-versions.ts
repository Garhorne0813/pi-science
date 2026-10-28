// Pinned-version artifact lookups and structured version diffs.
import { apiRequest } from "../client/api";
import { encodeWorkspacePath } from "../files";

export interface PublishedArtifactRef {
  artifact_id: string;
  version: number;
  path: string;
  kind: string;
  mime: string;
  size: number;
  sha256: string;
  published_at: string;
}

export interface DiffLine {
  type: " " | "-" | "+";
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type ArtifactDiff =
  | { kind: "text"; from_version: number; to_version: number; hunks: DiffHunk[]; from_lines: number; to_lines: number; truncated: boolean }
  | { kind: "table"; from_version: number; to_version: number; delimiter: string; rows_added: number; rows_removed: number; cells: Array<{ row: number; column: string; from: string; to: string }>; hunks: DiffHunk[]; truncated: boolean }
  | { kind: "image"; from_version: number; to_version: number; from_sha256: string; to_sha256: string }
  | { kind: "unsupported"; from_version: number; to_version: number; reason: string };

/** Resolve the newest published artifact version for a workspace path, or null
 *  when the path was never published (callers fall back to the live file). */
export async function findPublishedVersion(cwd: string, path: string): Promise<PublishedArtifactRef | null> {
  try {
    const params = new URLSearchParams({ cwd });
    return await apiRequest<PublishedArtifactRef>(`/api/artifacts/by-path/${encodeWorkspacePath(path)}?${params}`);
  } catch {
    return null;
  }
}

/** Fetch the structured diff between two versions of one artifact. */
export async function fetchArtifactDiff(cwd: string, artifactId: string, from?: number, to?: number): Promise<ArtifactDiff | null> {
  try {
    const params = new URLSearchParams({ cwd });
    if (from !== undefined) params.set("from", String(from));
    if (to !== undefined) params.set("to", String(to));
    return await apiRequest<ArtifactDiff>(`/api/artifacts/${encodeURIComponent(artifactId)}/diff?${params}`);
  } catch {
    return null;
  }
}
