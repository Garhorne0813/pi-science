/**
 * Artifact Library client: lists every artifact manifest in a workspace and
 * groups them into logical entries (path-derived artifact_id, versions
 * newest-first). Pure client-side grouping over the existing artifacts API —
 * no dedicated server endpoint (reverse-cs-inspiration 4.1, project-level
 * Artifact Library).
 */

import { apiRequest } from "../../lib/client/api";
import type { ArtifactManifestV2 } from "./artifact-lineage";

export interface ArtifactLibraryEntry {
  /** Path-derived identity (first-seen path for multi-path logical chains). */
  artifact_id: string;
  /** Latest manifest of the chain. */
  latest: ArtifactManifestV2;
  /** Every version, newest first. */
  versions: ArtifactManifestV2[];
  /** Latest review verdict if any review was recorded. */
  latestReview?: { status: "passed" | "failed" | "needs_work"; actor: string; at: string };
}

/** Fetch up to `limit` artifact rows (all versions) for a workspace. */
export async function listArtifacts(cwd: string, limit = 1000): Promise<ArtifactManifestV2[]> {
  const params = new URLSearchParams({ cwd, limit: String(limit) });
  const data = await apiRequest<{ artifacts?: ArtifactManifestV2[] }>("/api/artifacts?" + params.toString());
  return data.artifacts ?? [];
}

/** Group manifests by artifact_id, versions newest-first, latest derived. */
export function groupArtifacts(manifests: readonly ArtifactManifestV2[]): ArtifactLibraryEntry[] {
  const byId = new Map<string, ArtifactManifestV2[]>();
  for (const manifest of manifests) {
    const list = byId.get(manifest.artifact_id) ?? [];
    list.push(manifest);
    byId.set(manifest.artifact_id, list);
  }
  const entries: ArtifactLibraryEntry[] = [];
  for (const [artifactId, versions] of byId) {
    versions.sort((left, right) => right.version - left.version);
    const latest = versions[0]!;
    const reviews = latest.reviews ?? [];
    const latestReview = reviews.length > 0 ? reviews[reviews.length - 1] : undefined;
    entries.push({ artifact_id: artifactId, latest, versions, latestReview });
  }
  entries.sort((left, right) => right.latest.published_at.localeCompare(left.latest.published_at));
  return entries;
}
