import type { ArtifactClassification, ArtifactManifestV2, ArtifactVersionRef } from "@pi-science/contracts";

/** Versioned artifact lineage model (workspace-local, no graph database).
 *
 *  Canonical store remains `.pi-science/artifacts.jsonl`. Rows without
 *  `schema_version` are legacy v1 manifests: they are normalized in-memory to
 *  v2 (classification `unspecified`, empty versioned inputs) for API
 *  responses, but never rewritten to the file. Duplicate rows for the same
 *  `artifact_id + version` (verification updates append a refreshed row)
 *  collapse to the LAST record — that is the authoritative state.
 *
 *  Versioned `inputs` refs and `supersedes` must resolve to an existing
 *  manifest in the SAME workspace (lookup happens against this workspace's
 *  JSONL, so cross-workspace refs can never resolve). Legacy string inputs
 *  are preserved but never form a DAG edge; they surface as
 *  `unresolved_inputs` in the lineage response. */

export const MAX_VERSIONED_INPUTS = 100;

export function isArtifactVersionRef(value: unknown): value is ArtifactVersionRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.artifact_id === "string"
    && typeof record.version === "number"
    && Number.isSafeInteger(record.version)
    && record.version > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Normalize a raw JSONL row to a v2 manifest. Returns null for rows that are
 *  not artifacts or are structurally corrupt (torn lines are skipped). */
export function normalizeManifest(row: unknown): ArtifactManifestV2 | null {
  if (!isRecord(row)) return null;
  if (typeof row.artifact_id !== "string" || !row.artifact_id) return null;
  const version = Number(row.version ?? 0);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  if (typeof row.path !== "string" || !row.path) return null;
  if (typeof row.sha256 !== "string" || row.sha256.length < 16) return null;
  const rawInputs = Array.isArray(row.inputs) ? row.inputs : [];
  const inputs = rawInputs
    .map((entry) => isArtifactVersionRef(entry) ? { artifact_id: entry.artifact_id, version: entry.version } as ArtifactVersionRef : typeof entry === "string" && entry ? entry : null)
    .filter((entry): entry is ArtifactVersionRef | string => entry !== null);
  const classification: ArtifactClassification = row.classification === "intermediate" || row.classification === "deliverable" || row.classification === "unspecified"
    ? row.classification
    : "unspecified";
  const supersedes = isArtifactVersionRef(row.supersedes) ? { artifact_id: row.supersedes.artifact_id, version: row.supersedes.version } : null;
  return {
    schema_version: 2,
    artifact_id: row.artifact_id,
    version,
    path: row.path,
    kind: typeof row.kind === "string" ? row.kind : "file",
    mime: typeof row.mime === "string" ? row.mime : "application/octet-stream",
    size: Number.isFinite(Number(row.size)) ? Math.max(0, Number(row.size)) : 0,
    sha256: row.sha256,
    published_at: typeof row.published_at === "string" ? row.published_at : new Date(0).toISOString(),
    inputs,
    supersedes,
    classification,
    ...(isRecord(row.producer) ? { producer: row.producer } : {}),
    ...(isRecord(row.environment) ? { environment: row.environment } : {}),
    ...(isRecord(row.verification) ? { verification: row.verification } : {}),
  };
}

export function manifestKey(manifest: Pick<ArtifactManifestV2, "artifact_id" | "version">): string {
  return `${manifest.artifact_id}\u0000${manifest.version}`;
}

/** Collapse raw rows into authoritative manifests: the LAST row for each
 *  artifact_id+version wins (verification appends refreshed rows). */
export function collapseManifests(rows: readonly unknown[]): ArtifactManifestV2[] {
  const byKey = new Map<string, ArtifactManifestV2>();
  for (const row of rows) {
    const manifest = normalizeManifest(row);
    if (manifest) byKey.set(manifestKey(manifest), manifest);
  }
  return [...byKey.values()];
}

export interface ArtifactLineage {
  artifact: ArtifactManifestV2;
  upstream: Array<{ kind: "consumes" | "supersedes"; artifact: ArtifactManifestV2 }>;
  downstream: Array<{ kind: "consumed_by" | "superseded_by"; artifact: ArtifactManifestV2 }>;
  unresolved_inputs: string[];
}

/** Build the lineage of one artifact version by folding the workspace's
 *  manifests. Returns null when the target does not exist. */
export function buildLineage(manifests: readonly ArtifactManifestV2[], artifactId: string, version?: number): ArtifactLineage | null {
  const byKey = new Map(manifests.map((manifest) => [manifestKey(manifest), manifest]));
  const sameId = manifests.filter((manifest) => manifest.artifact_id === artifactId);
  const target = version !== undefined
    ? byKey.get(manifestKey({ artifact_id: artifactId, version })) ?? null
    : sameId.sort((left, right) => right.version - left.version)[0] ?? null;
  if (!target) return null;

  const upstream: ArtifactLineage["upstream"] = [];
  for (const input of target.inputs) {
    if (!isArtifactVersionRef(input)) continue;
    const ref = byKey.get(manifestKey(input));
    if (ref) upstream.push({ kind: "consumes", artifact: ref });
  }
  if (target.supersedes) {
    const replaced = byKey.get(manifestKey(target.supersedes));
    if (replaced) upstream.push({ kind: "supersedes", artifact: replaced });
  }
  const unresolved_inputs = target.inputs.filter((input): input is string => typeof input === "string");

  const downstream: ArtifactLineage["downstream"] = [];
  for (const manifest of manifests) {
    if (manifest.artifact_id === artifactId && manifest.version === target.version) continue;
    if (manifest.inputs.some((input) => isArtifactVersionRef(input) && input.artifact_id === target.artifact_id && input.version === target.version)) {
      downstream.push({ kind: "consumed_by", artifact: manifest });
      continue;
    }
    if (manifest.supersedes && manifest.supersedes.artifact_id === target.artifact_id && manifest.supersedes.version === target.version) {
      downstream.push({ kind: "superseded_by", artifact: manifest });
    }
  }

  return { artifact: target, upstream, downstream, unresolved_inputs };
}

export interface VersionedRelationValidation {
  ok: true;
  inputs: ArtifactVersionRef[];
  supersedes: ArtifactVersionRef | null;
}

export interface VersionedRelationError {
  ok: false;
  error: string;
}

/** Validate publish-time versioned relations against the workspace's current
 *  manifests. String inputs pass through unchanged (legacy unresolved refs);
 *  versioned refs must exist, be unique, never target the version being
 *  created, and the COMBINED count of string + versioned inputs must stay
 *  within the per-version cap (the same cap the row is written under, so
 *  reads never have to slice). Superseding an OLDER version of the same
 *  artifact is the normal supersession flow and is allowed. */
export function validateVersionedRelations(
  manifests: readonly ArtifactManifestV2[],
  selfId: string,
  newVersion: number,
  rawInputs: unknown,
  rawSupersedes: unknown,
): VersionedRelationValidation | VersionedRelationError {
  const byKey = new Map(manifests.map((manifest) => [manifestKey(manifest), manifest]));
  const inputs: ArtifactVersionRef[] = [];
  const seen = new Set<string>();
  let stringCount = 0;
  const overCap = () => stringCount + inputs.length > MAX_VERSIONED_INPUTS;
  for (const entry of Array.isArray(rawInputs) ? rawInputs : []) {
    if (typeof entry === "string") {
      stringCount += 1;
      if (overCap()) return { ok: false, error: `at most ${MAX_VERSIONED_INPUTS} inputs are allowed (paths and versioned references combined)` };
      continue;
    }
    if (!isArtifactVersionRef(entry)) return { ok: false, error: "inputs must contain exact { artifact_id, version } references or path strings" };
    if (entry.artifact_id === selfId && entry.version === newVersion) return { ok: false, error: "an artifact cannot reference the version being created" };
    const key = manifestKey(entry);
    if (seen.has(key)) return { ok: false, error: "duplicate input reference" };
    seen.add(key);
    if (stringCount + inputs.length >= MAX_VERSIONED_INPUTS) return { ok: false, error: `at most ${MAX_VERSIONED_INPUTS} inputs are allowed (paths and versioned references combined)` };
    inputs.push(entry);
  }
  for (const input of inputs) {
    if (!byKey.has(manifestKey(input))) return { ok: false, error: `input artifact ${input.artifact_id} v${input.version} does not exist in this workspace` };
  }

  let supersedes: ArtifactVersionRef | null = null;
  if (rawSupersedes !== undefined && rawSupersedes !== null) {
    if (!isArtifactVersionRef(rawSupersedes)) return { ok: false, error: "supersedes must be an exact { artifact_id, version } reference or null" };
    if (rawSupersedes.artifact_id === selfId && rawSupersedes.version === newVersion) return { ok: false, error: "an artifact cannot supersede the version being created" };
    if (!byKey.has(manifestKey(rawSupersedes))) return { ok: false, error: `superseded artifact ${rawSupersedes.artifact_id} v${rawSupersedes.version} does not exist in this workspace` };
    supersedes = rawSupersedes;
  }
  return { ok: true, inputs, supersedes };
}

export type { ArtifactManifestV2, ArtifactVersionRef, ArtifactClassification };
