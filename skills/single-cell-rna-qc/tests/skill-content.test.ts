/**
 * Content and metadata tests for the builtin single-cell-rna-qc skill.
 *
 * Validates the real SKILL.md against the server skill catalog schema and
 * asserts the QC workflow (metrics, MAD filtering, mito cap, report
 * conventions) is documented. Run from the server package:
 *
 *   pnpm --filter @pi-science/server exec vitest run --dir ../../skills/single-cell-rna-qc/tests
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, validateDirectory } from "../../../apps/server/src/catalog/skill-catalog.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");

describe("single-cell-rna-qc skill content", () => {
  it("frontmatter validates against the catalog schema with no errors or warnings", async () => {
    const validations = await validateDirectory(SKILL_DIR);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.errors).toEqual([]);
    expect(validations[0]?.warnings).toEqual([]);
    expect(validations[0]?.valid).toBe(true);
  });

  it("declares correct metadata, numpy requirement and the helper script entrypoint", async () => {
    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    expect(record.metadata.name).toBe("single-cell-rna-qc");
    expect(record.metadata.license).toBe("Apache-2.0");
    expect(record.metadata.risk).toBe("low");
    const requirements = record.metadata.requirements.map((r) => r.name);
    expect(requirements).toContain("python");
    expect(requirements).toContain("numpy");
    expect(requirements).toContain("scanpy");
    const scanpy = record.metadata.requirements.find((r) => r.name === "scanpy");
    // The core pipeline must not hard-require scanpy.
    expect(scanpy?.optional).toBe(true);
    // Helper script must exist on disk (entrypoint contract).
    expect(existsSync(join(SKILL_DIR, "single_cell_rna_qc.py"))).toBe(true);
    expect(record.metadata.required_mcp_tools).toEqual([]);
  });

  it("documents the QC metrics, MAD filter rule and mito cap", async () => {
    const body = readFileSync(SKILL_MD, "utf8");
    expect(body).toContain("total_counts");
    expect(body).toContain("n_genes");
    expect(body).toContain("pct_mito");
    expect(body).toContain("1.4826");
    expect(body).toContain("max-pct-mito");
  });

  it("documents interpretation guardrails and the mandatory summary block", async () => {
    const body = readFileSync(SKILL_MD, "utf8");
    expect(body).toContain("Interpretation guardrails");
    expect(body).toContain("never silently");
    expect(body).toContain("QC SUMMARY");
    expect(body).toContain("filtered matrix");
    // Scanpy is an optional extension, never a hard dependency of the skill.
    expect(body).toContain("Scanpy extension path");
  });
});
