/** Artifact lineage client: resolves a file path (or an exact artifact
 *  version) to its versioned upstream/downstream relations from the Node
 *  control plane. Distinguishes "no manifest for this file" (404 / empty)
 *  from transient failures: network errors and 5xx responses REJECT so React
 *  Query retries them, while a 404 resolves as `not-found`. */

import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiError } from "../client/api";
import { queryClient } from "../client/query-client";
import { useRuntimeStore } from "../agent-runtime";

export interface ArtifactVersionRef {
  artifact_id: string;
  version: number;
}

export type ArtifactClassification = "intermediate" | "deliverable" | "unspecified";

export interface ArtifactManifestV2 {
  schema_version: 2;
  artifact_id: string;
  version: number;
  path: string;
  kind: string;
  mime: string;
  size: number;
  sha256: string;
  published_at: string;
  inputs: Array<ArtifactVersionRef | string>;
  supersedes: ArtifactVersionRef | null;
  classification: ArtifactClassification;
  producer?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  verification?: Record<string, unknown>;
}

export interface ArtifactLineage {
  artifact: ArtifactManifestV2;
  upstream: Array<{ kind: "consumes" | "supersedes"; artifact: ArtifactManifestV2 }>;
  downstream: Array<{ kind: "consumed_by" | "superseded_by"; artifact: ArtifactManifestV2 }>;
  unresolved_inputs: string[];
}

export type ArtifactLineageResult =
  | { ok: true; data: ArtifactLineage }
  | { ok: false; reason: "not-found" };

export function artifactLineageKey(cwd: string, path: string, artifactId?: string, version?: number): string[] {
  return artifactId && version !== undefined
    ? ["artifact-lineage", cwd, artifactId, String(version)]
    : ["artifact-lineage", cwd, path];
}

async function fetchLatestManifest(cwd: string, path: string): Promise<ArtifactManifestV2 | null> {
  const params = new URLSearchParams({ cwd, path, latest: "1" });
  const data = await apiRequest<{ artifacts?: ArtifactManifestV2[] }>(`/api/artifacts?${params}`);
  return data.artifacts?.[0] ?? null;
}

async function fetchExactManifest(cwd: string, artifactId: string, version: number): Promise<ArtifactManifestV2> {
  const params = new URLSearchParams({ cwd, version: String(version) });
  return apiRequest<ArtifactManifestV2>(`/api/artifacts/${encodeURIComponent(artifactId)}?${params}`);
}

async function fetchLineage(cwd: string, artifactId: string, version: number): Promise<ArtifactLineage> {
  const params = new URLSearchParams({ cwd, version: String(version) });
  return apiRequest<ArtifactLineage>(`/api/artifacts/${encodeURIComponent(artifactId)}/lineage?${params}`);
}

/** Resolve the lineage of a file path, or of an exact artifact version when
 *  `artifactId`/`version` are provided (lineage relation jumps). Returns
 *  `not-found` for 404s and missing manifests; network errors and 5xx are
 *  rethrown so React Query can retry them. */
export async function getArtifactLineage(cwd: string, path: string, artifactId?: string, version?: number): Promise<ArtifactLineageResult> {
  try {
    let target: ArtifactManifestV2;
    if (artifactId && version !== undefined) {
      target = await fetchExactManifest(cwd, artifactId, version);
    } else {
      const latest = await fetchLatestManifest(cwd, path);
      if (!latest) return { ok: false, reason: "not-found" };
      target = latest;
    }
    const data = await fetchLineage(cwd, target.artifact_id, target.version);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { ok: false, reason: "not-found" };
    throw error;
  }
}

/** React binding for the inspector. The query key includes the runtime
 *  `fileRevision` signal, which bumps when a turn settles with file changes
 *  (artifact.published / write / edit), so the lineage refetches after new
 *  manifests land. 404s resolve as not-found without retries; 5xx/network
 *  errors retry through the shared query client. */
export function useArtifactLineage(cwd: string, path: string, artifactId?: string, version?: number) {
  const fileRevision = useRuntimeStore((s) => s.fileRevision);
  return useQuery({
    queryKey: [...artifactLineageKey(cwd, path, artifactId, version), fileRevision],
    queryFn: () => getArtifactLineage(cwd, path, artifactId, version),
    staleTime: 30_000,
  }, queryClient);
}
