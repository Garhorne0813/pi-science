import { describe, expect, it } from "vitest";
import { buildLineage, chainLatestVersion, collapseManifests, logicalChain, normalizeManifest, validateVersionedRelations } from "./artifact-manifest.js";

function v1(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: "a1", version: 1, path: "out.txt", kind: "text", mime: "text/plain",
    size: 3, sha256: "1234567890abcdef", published_at: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

function v2(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2, artifact_id: "a2", version: 2, path: "out/plot.png", kind: "image",
    mime: "image/png", size: 10, sha256: "abcdef1234567890", published_at: "2026-01-01T00:00:00.000Z",
    inputs: [], supersedes: null, classification: "deliverable", ...overrides,
  };
}

describe("artifact manifest normalizer", () => {
  it("reads legacy v1 rows as unspecified without rewriting them", () => {
    const manifest = normalizeManifest(v1());
    expect(manifest).toMatchObject({ schema_version: 2, classification: "unspecified", supersedes: null, inputs: [] });
    // The normalized object is a fresh in-memory view; the source row is untouched.
    expect(v1()).not.toHaveProperty("schema_version");
  });

  it("rejects corrupt rows but tolerates torn JSONL lines", () => {
    expect(normalizeManifest(null)).toBeNull();
    expect(normalizeManifest("garbage")).toBeNull();
    expect(normalizeManifest({})).toBeNull();
    expect(normalizeManifest(v1({ version: 0 }))).toBeNull();
    expect(normalizeManifest(v1({ sha256: "short" }))).toBeNull();
  });

  it("collapses duplicate artifact+version rows with last-write-wins", () => {
    const rows = [
      v1({ artifact_id: "a1", version: 1, sha256: "1111111111111111" }),
      v1({ artifact_id: "a1", version: 1, sha256: "2222222222222222", verification: { status: "passed" } }),
      v2({ artifact_id: "a1", version: 2, sha256: "3333333333333333" }),
    ];
    const manifests = collapseManifests(rows);
    expect(manifests).toHaveLength(2);
    const v1Record = manifests.find((manifest) => manifest.artifact_id === "a1" && manifest.version === 1)!;
    expect(v1Record.sha256).toBe("2222222222222222");
    expect(v1Record.verification).toEqual({ status: "passed" });
  });

  it("preserves legacy string inputs and drops invalid entries", () => {
    const manifest = normalizeManifest(v1({ inputs: ["legacy/path.txt", "other.csv", 42, null] }));
    expect(manifest?.inputs).toEqual(["legacy/path.txt", "other.csv"]);
  });

  it("does not slice inputs on read — the write-time cap is authoritative", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ artifact_id: `a-${i}`, version: 1 }));
    const manifest = normalizeManifest(v2({ inputs: many }));
    expect(manifest?.inputs).toHaveLength(120);
  });

  it("caps the COMBINED count of string and versioned inputs at write time", () => {
    const manifests = collapseManifests([v2({ artifact_id: "a1", version: 1, path: "in.csv" })]);
    const strings = Array.from({ length: 100 }, (_, i) => `legacy/${i}.csv`);
    const overCombined = validateVersionedRelations(manifests, "a9", 9, [...strings, { artifact_id: "a1", version: 1 }], null, null);
    expect(overCombined.ok).toBe(false);
    if (overCombined.ok === false) expect(overCombined.error).toContain("combined");

    const atCap = validateVersionedRelations(manifests, "a9", 9, [...strings.slice(0, 99), { artifact_id: "a1", version: 1 }], null, null);
    expect(atCap).toEqual({ ok: true, derivedFrom: [], inputs: [{ artifact_id: "a1", version: 1 }], supersedes: null });

    const overByStringsOnly = validateVersionedRelations(manifests, "a9", 9, Array.from({ length: 101 }, (_, i) => `legacy/${i}.csv`), null, null);
    expect(overByStringsOnly.ok).toBe(false);
    if (overByStringsOnly.ok === false) expect(overByStringsOnly.error).toContain("combined");
  });

  it("validates exact input refs against existing manifests", () => {
    const manifests = collapseManifests([v2({ artifact_id: "a1", version: 1, path: "in.csv" }), v2({ artifact_id: "a2", version: 2 }), v1({ artifact_id: "a3", version: 3, path: "old.csv" })]);
    const ok = validateVersionedRelations(manifests, "a9", 9, [{ artifact_id: "a1", version: 1 }], null, { artifact_id: "a3", version: 3 });
    expect(ok).toEqual({ ok: true, derivedFrom: [], inputs: [{ artifact_id: "a1", version: 1 }], supersedes: { artifact_id: "a3", version: 3 } });

    // Missing target, self-version-being-created, duplicate ref, and over-limit inputs.
    const missing = validateVersionedRelations(manifests, "a9", 9, [{ artifact_id: "ghost", version: 1 }], null, null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("does not exist");
    const self = validateVersionedRelations(manifests, "a1", 2, [{ artifact_id: "a1", version: 2 }], null, null);
    expect(self.ok).toBe(false);
    if (self.ok === false) expect(self.error).toContain("version being created");
    const duplicate = validateVersionedRelations(manifests, "a9", 9, [{ artifact_id: "a1", version: 1 }, { artifact_id: "a1", version: 1 }], null, null);
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok === false) expect(duplicate.error).toBe("duplicate input reference");
    const tooMany = validateVersionedRelations(manifests, "a9", 9, Array.from({ length: 101 }, (_, i) => ({ artifact_id: `unique-${i}`, version: 1 })), null, null);
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok === false) expect(tooMany.error).toContain("at most 100");
    const badSupersedes = validateVersionedRelations(manifests, "a9", 9, [], null, { artifact_id: "ghost", version: 1 });
    expect(badSupersedes.ok).toBe(false);
    // Superseding an OLDER version of the same artifact is the normal flow.
    const supersedeSelfOlder = validateVersionedRelations(manifests, "a2", 3, [], null, { artifact_id: "a2", version: 2 });
    expect(supersedeSelfOlder).toEqual({ ok: true, derivedFrom: [], inputs: [], supersedes: { artifact_id: "a2", version: 2 } });
  });

  it("builds upstream/downstream lineage including supersession", () => {
    const manifests = collapseManifests([
      v2({ artifact_id: "a1", version: 1, path: "raw.csv" }),
      v2({ artifact_id: "a2", version: 1, path: "clean.csv", inputs: [{ artifact_id: "a1", version: 1 }] }),
      v2({ artifact_id: "a2", version: 2, path: "clean.csv", inputs: [{ artifact_id: "a1", version: 1 }], supersedes: { artifact_id: "a2", version: 1 } }),
      v2({ artifact_id: "a3", version: 1, path: "final.csv", inputs: [{ artifact_id: "a2", version: 2 }] }),
    ]);
    const lineage = buildLineage(manifests, "a2", 2)!;
    expect(lineage).not.toBeNull();
    expect(lineage.artifact.version).toBe(2);
    expect(lineage.upstream).toEqual([
      { kind: "consumes", artifact: expect.objectContaining({ artifact_id: "a1", version: 1 }) },
      { kind: "supersedes", artifact: expect.objectContaining({ artifact_id: "a2", version: 1 }) },
    ]);
    expect(lineage.downstream).toEqual([
      { kind: "consumed_by", artifact: expect.objectContaining({ artifact_id: "a3", version: 1 }) },
    ]);
    expect(lineage.unresolved_inputs).toEqual([]);
  });

  it("surfaces legacy string inputs as unresolved without forming edges", () => {
    const manifests = collapseManifests([
      v2({ artifact_id: "a1", version: 1, path: "raw.csv" }),
      v2({ artifact_id: "a2", version: 1, path: "clean.csv", inputs: ["raw.csv", { artifact_id: "a1", version: 1 }] }),
    ]);
    const lineage = buildLineage(manifests, "a2", 1)!;
    expect(lineage.upstream).toEqual([{ kind: "consumes", artifact: expect.objectContaining({ artifact_id: "a1" }) }]);
    expect(lineage.unresolved_inputs).toEqual(["raw.csv"]);
  });

  it("returns null for unknown targets and defaults to the latest version", () => {
    const manifests = collapseManifests([v2({ artifact_id: "a1", version: 1 }), v2({ artifact_id: "a1", version: 2 }), v2({ artifact_id: "a1", version: 3 })]);
    expect(buildLineage(manifests, "ghost")).toBeNull();
    expect(buildLineage(manifests, "a1")?.artifact.version).toBe(3);
    expect(buildLineage(manifests, "a1", 1)?.artifact.version).toBe(1);
  });

  it("never creates cross-workspace edges because lookups are workspace-local", () => {
    // A ref to an artifact that only exists in another workspace's JSONL is
    // indistinguishable from a missing ref here: validation rejects it.
    const manifests = collapseManifests([v2({ artifact_id: "a1", version: 1 })]);
    const result = validateVersionedRelations(manifests, "a9", 9, [{ artifact_id: "other-workspace-id", version: 1 }], null, null);
    expect(result.ok).toBe(false);
  });
});

describe("logical artifact identity helpers", () => {
  it("parses logical_id from rows and omits it when absent", () => {
    const withId = normalizeManifest(v2({ logical_id: "logical-x" }));
    expect(withId?.logical_id).toBe("logical-x");
    const withoutId = normalizeManifest(v2());
    expect(withoutId).not.toHaveProperty("logical_id");
    // Non-string logical ids are dropped.
    const bogus = normalizeManifest(v2({ logical_id: 42 }));
    expect(bogus).not.toHaveProperty("logical_id");
  });

  it("groups chains by logical_id and computes the chain latest version", () => {
    const manifests = collapseManifests([
      v2({ artifact_id: "p1", logical_id: "L1", version: 1, path: "old.csv" }),
      v2({ artifact_id: "p2", logical_id: "L1", version: 2, path: "new.csv" }),
      v2({ artifact_id: "other", logical_id: "L2", version: 5 }),
      v2({ artifact_id: "legacy", version: 3 }),
    ]);
    const chain = logicalChain(manifests, "L1");
    expect(chain.map((m) => m.path)).toEqual(["new.csv", "old.csv"]);
    expect(chainLatestVersion(chain)).toBe(2);
    expect(logicalChain(manifests, "ghost")).toEqual([]);
    expect(chainLatestVersion([])).toBe(0);
    // Legacy rows without a logical id do not join any logical chain.
    expect(logicalChain(manifests, "legacy")).toEqual([]);
  });
});
