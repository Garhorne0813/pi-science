/**
 * Content and metadata tests for the builtin figure-composer skill.
 *
 * Validates the real SKILL.md against the server skill catalog (frontmatter
 * schema) and asserts the composition discipline is documented: define layout
 * before composing, never silently alter panel data interpretation, retain
 * panel input IDs, and verify the composite before calling it publication
 * ready. Run from the server package:
 *
 *   pnpm --filter @pi-science/server exec vitest run --dir ../../skills/figure-composer/tests
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, validateDirectory } from "../../../apps/server/src/catalog/skill-catalog.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");

describe("figure-composer skill content", () => {
  it("frontmatter validates against the catalog schema with no errors or warnings", async () => {
    const validations = await validateDirectory(SKILL_DIR);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.errors).toEqual([]);
    expect(validations[0]?.warnings).toEqual([]);
    expect(validations[0]?.valid).toBe(true);
  });

  it("declares the expected metadata and no hard tool requirements", async () => {
    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    expect(record.metadata.name).toBe("figure-composer");
    expect(record.metadata.risk).toBe("low");
    expect(record.metadata.category).toBe("visualization");
    // Composition is an agent workflow; no MCP or external service is required.
    expect(record.metadata.required_mcp_tools).toEqual([]);
    const requirementNames = record.metadata.requirements.map((r) => r.name);
    const python = record.metadata.requirements.find((r) => r.name === "python");
    expect(requirementNames).toContain("python");
    expect(python?.optional).toBe(true);
  });

  it("documents the layout-first composition discipline", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    // Define panel order, aspect ratio, labels, and output dimensions BEFORE composing.
    expect(body).toContain("Start from a claim and a list of panel artifacts");
    expect(body).toContain("panel order");
    expect(body).toContain("aspect ratio");
    expect(body).toContain("output dimensions");

    // Never silently alter data interpretation.
    expect(body).toContain("Do not redraw or");
    expect(body).toContain("silently rescale");
    expect(body).toContain("changes its data interpretation");

    // The composite is a new artifact that retains its input lineage.
    expect(body).toContain("Export\n");
    expect(body).toContain("as a new artifact");
    expect(body).toContain("retain the panel input IDs");

    // Verification gate before publication-ready.
    expect(body).toContain("verification");
    expect(body).toContain("publication-ready");
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
      // Mirrors backend/services/skill_eval.py trigger semantics.
      const tokens = new Set(
        (String(fixture.prompt).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).map((t) => t.toLowerCase()),
      );
      const triggered = (fixture.trigger_terms as string[]).some((term) => tokens.has(term.toLowerCase()));
      expect(triggered, `fixture "${fixture.prompt}"`).toBe(fixture.expected_trigger);
    }
  });
  it("documents the recoverable stage workflow and convergence rules", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    // Stage workflow with durable waypoints.
    expect(body).toContain("## Stages");
    expect(body).toContain("waypoints.jsonl");
    expect(body).toContain("references/waypoint-schemas.md");
    expect(body).toContain("Resume by reading the waypoint log");

    // Declared stages in order.
    for (const stage of ["claim", "layout", "compose", "verify", "review"]) {
      expect(body).toContain(stage);
    }

    // Human gates and convergence.
    expect(body).toContain("needs_confirmation");
    expect(body).toContain("Max rework rounds");
    expect(body).toContain("3");
    expect(body).toContain("do not ship an unverified composite");

    // Failure mode taxonomy.
    for (const mode of ["panel_missing", "verify_failed", "data_misrepresentation"]) {
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
