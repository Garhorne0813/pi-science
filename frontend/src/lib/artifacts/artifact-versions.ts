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
  | { kind: "table"; from_version: number; to_version: number; delimiter: string; rows_added: number; rows_removed: number; cells: Array<{ row: number; column: string; from: string; to: string }>; hunks: DiffHunk[]; truncated: boolean; cells_unavailable?: "unbalanced_quotes" }
  | { kind: "image"; from_version: number; to_version: number; from_sha256: string; to_sha256: string }
  | { kind: "unsupported"; from_version: number; to_version: number; reason: string };

/** Identity of the published version a durable reference points at. Turn
 *  summaries persist artifact id and version, so a reference that formed in an
 *  earlier turn can name its own version instead of inheriting the newest one. */
export interface PublishedReference {
  artifactId?: string;
  version?: number;
  sha256?: string;
}

/** `pinned` when the caller named a version, `latest` when it fell back to the
 *  newest published one. The UI labels the fallback so it never implies a pin. */
export type VersionSource = "pinned" | "latest";

/** Resolve the newest published artifact version for a workspace path, or a
 *  specific version when one is named. Null means the path was never published
 *  and the caller falls back to the live file. */
export async function findPublishedVersion(cwd: string, path: string, version?: number): Promise<PublishedArtifactRef | null> {
  try {
    const params = new URLSearchParams({ cwd });
    if (version !== undefined) params.set("version", String(version));
    return await apiRequest<PublishedArtifactRef>(`/api/artifacts/by-path/${encodeWorkspacePath(path)}?${params}`);
  } catch {
    return null;
  }
}

/** Resolve the version a reference names, falling back to the newest published
 *  version when that exact version is gone, and report which one happened. */
export async function resolvePublishedVersion(cwd: string, path: string, reference?: PublishedReference): Promise<{ ref: PublishedArtifactRef; source: VersionSource } | null> {
  if (reference?.version !== undefined) {
    const pinned = await findPublishedVersion(cwd, path, reference.version);
    if (pinned) return { ref: pinned, source: "pinned" };
  }
  const latest = await findPublishedVersion(cwd, path);
  return latest ? { ref: latest, source: "latest" } : null;
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
