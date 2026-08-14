import { describe, expect, it } from "vitest";
import { groupArtifacts } from "./artifact-library";
import type { ArtifactManifestV2 } from "./artifact-lineage";

function manifest(overrides: Partial<ArtifactManifestV2> = {}): ArtifactManifestV2 {
  return {
    schema_version: 2,
    artifact_id: "a1",
    version: 1,
    path: "old/result.csv",
    kind: "table",
    mime: "text/csv",
    size: 10,
    sha256: "1234567890abcdef",
    published_at: "2026-08-14T00:00:00.000Z",
    inputs: [],
    supersedes: null,
    classification: "deliverable",
    ...overrides,
  };
}

describe("groupArtifacts", () => {
  it("keeps renamed versions in one logical entry", () => {
    const entries = groupArtifacts([
      manifest({ artifact_id: "path-id-old", logical_id: "logical-result", version: 1, path: "old/result.csv" }),
      manifest({ artifact_id: "path-id-new", logical_id: "logical-result", version: 2, path: "new/result.csv", published_at: "2026-08-15T00:00:00.000Z" }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ artifact_id: "logical-result", latest: { path: "new/result.csv", version: 2 } });
    expect(entries[0]?.versions.map((item) => item.path)).toEqual(["new/result.csv", "old/result.csv"]);
  });

  it("falls back to artifact_id for legacy manifests", () => {
    const entries = groupArtifacts([manifest({ artifact_id: "legacy", logical_id: undefined })]);
    expect(entries[0]?.artifact_id).toBe("legacy");
  });
});
