/**
 * Content and metadata tests for the builtin traceability-review skill.
 *
 * Validates the real SKILL.md against the server skill catalog (frontmatter
 * schema) and asserts the three audit checks, the deterministic PDF
 * extraction boundary, and the machine-readable ```review output contract are
 * documented. Run from the server package:
 *
 *   pnpm --filter @pi-science/server exec vitest run --dir ../../skills/traceability-review/tests
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, validateDirectory } from "../../../apps/server/src/catalog/skill-catalog.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");

describe("traceability-review skill content", () => {
  it("frontmatter validates against the catalog schema with no errors or warnings", async () => {
    const validations = await validateDirectory(SKILL_DIR);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.errors).toEqual([]);
    expect(validations[0]?.warnings).toEqual([]);
    expect(validations[0]?.valid).toBe(true);
  });

  it("declares the expected metadata and optional requirements", async () => {
    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    expect(record.metadata.name).toBe("traceability-review");
    expect(record.metadata.risk).toBe("low");
    expect(record.metadata.category).toBe("review");
    expect(record.metadata.required_mcp_tools).toEqual([]);

    const requirements = new Map(record.metadata.requirements.map((r) => [r.name, r]));
    expect(requirements.has("python")).toBe(true);
    expect(requirements.get("python")?.optional).toBe(false);
    expect(requirements.has("pypdf")).toBe(true);
    expect(requirements.get("pypdf")?.optional).toBe(true);
    expect(requirements.has("network")).toBe(true);
    expect(requirements.get("network")?.optional).toBe(true);
  });

  it("verifies traceability, never correctness, and states it plainly", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("traceability");
    expect(body).toContain("not truth");
    expect(body).toContain("Never state or imply that the document is error-free");
    expect(body).toContain("Absence of findings is not a guarantee of correctness");
  });

  it("documents the deterministic PDF extraction boundary", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("pdf_extract.py");
    expect(body).toContain("do not read the raw bytes or infer its contents");
    expect(body).toContain("concrete citation");
    expect(body).toContain("quantitative claims");
    expect(body).toContain("do not fabricate identifiers");
  });

  it("documents all three checks and their evidence rules", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("Check 1");
    expect(body).toContain("Citation audit");
    expect(body).toContain("api.crossref.org/works");
    expect(body).toContain("export.arxiv.org/api/query");
    expect(body).toContain("eutils.ncbi.nlm.nih.gov");

    expect(body).toContain("Check 2");
    expect(body).toContain("Untraceable numbers");
    expect(body).toContain("warn");
    expect(body).toContain("no traceable source");

    expect(body).toContain("Check 3");
    expect(body).toContain("Figure ↔ code consistency");
    expect(body).toContain(".pi-science/provenance.jsonl");
    expect(body).toContain("figure may be stale");
  });

  it("specifies the machine-readable review output contract", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("\`\`\`review");
    expect(body).toContain("findings");
    expect(body).toContain("citation");
    expect(body).toContain("number");
    expect(body).toContain("figure");
    expect(body).toContain("error");
    expect(body).toContain("warn");
    expect(body).toContain("ok");
    expect(body).toContain("One finding per issue");
    expect(body).toContain("keep it as the LAST thing in the message");
  });

  it("trigger fixtures follow the evaluator convention", async () => {
    const raw = await readFile(join(SKILL_DIR, "tests", "fixtures.json"), "utf8");
    const fixtures = JSON.parse(raw) as Record<string, unknown>[];
    expect(Array.isArray(fixtures)).toBe(true);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      expect(typeof fixture.prompt).toBe("string");
      expect(typeof fixture.expected_trigger).toBe("boolean");
      expect(Array.isArray(fixture.trigger_terms)).toBe(true);
      const tokens = new Set(
        (String(fixture.prompt).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).map((t) => t.toLowerCase()),
      );
      const triggered = (fixture.trigger_terms as string[]).some((term) => tokens.has(term.toLowerCase()));
      expect(triggered, `fixture "${fixture.prompt}"`).toBe(fixture.expected_trigger);
    }
  });
  it("documents the recoverable stage workflow and failure taxonomy", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("## Stages");
    expect(body).toContain("waypoints.jsonl");
    expect(body).toContain("Resume by reading the waypoint log");
    for (const stage of ["extract", "citations", "numbers", "figures", "report"]) {
      expect(body).toContain(stage);
    }
    expect(body).toContain("single-pass audit");
    expect(body).toContain("needs_confirmation");
    for (const mode of ["extractor_unavailable", "network_offline", "provenance_absent"]) {
      expect(body).toContain(mode);
    }
  });

  it("workflow fixtures cover the stage outputs", async () => {
    const raw = await readFile(join(SKILL_DIR, "tests", "workflow-fixtures.json"), "utf8");
    const fixtures = JSON.parse(raw) as { required_outputs?: string[]; produced_outputs?: string[] }[];
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const required = fixture.required_outputs ?? [];
      const produced = new Set(fixture.produced_outputs ?? []);
      for (const output of required) {
        expect(produced.has(output), `missing output ${output}`).toBe(true);
      }
    }
  });
});
