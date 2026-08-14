/**
 * Content and metadata tests for the builtin stats-integrity skill.
 *
 * Validates the real SKILL.md against the server skill catalog (frontmatter
 * schema) and asserts the execute-don't-interpret boundary, fixed-seed
 * reproducibility rules, and the deterministic integrity gate output contract.
 * Run from the server package:
 *
 *   pnpm --filter @pi-science/server exec vitest run --dir ../../skills/stats-integrity/tests
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, validateDirectory } from "../../../apps/server/src/catalog/skill-catalog.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");

describe("stats-integrity skill content", () => {
  it("frontmatter validates against the catalog schema with no errors or warnings", async () => {
    const validations = await validateDirectory(SKILL_DIR);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.errors).toEqual([]);
    expect(validations[0]?.warnings).toEqual([]);
    expect(validations[0]?.valid).toBe(true);
  });

  it("declares the expected metadata and optional requirements", async () => {
    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    expect(record.metadata.name).toBe("stats-integrity");
    expect(record.metadata.risk).toBe("low");
    expect(record.metadata.category).toBe("statistics");
    expect(record.metadata.required_mcp_tools).toEqual([]);

    const requirements = new Map(record.metadata.requirements.map((r) => [r.name, r]));
    expect(requirements.has("python")).toBe(true);
    expect(requirements.has("scipy")).toBe(true);
    expect(requirements.get("scipy")?.optional).toBe(true);
  });

  it("enforces the execute-don't-interpret boundary", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("Execute — don't interpret");
    expect(body).toContain("associational");
    expect(body).toContain("X is associated with Y");
    expect(body).toContain("Do **not** volunteer causal claims");
    expect(body).toContain("Do not tell the user what they want to hear");
    expect(body).toContain("Report **effect sizes** alongside p-values");
    expect(body).toContain("A tiny effect with p < 0.001");
    expect(body).toContain("still tiny");
  });

  it("requires fixed seeds for any randomised step", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("must fix a seed");
    expect(body).toContain("np.random.seed(42)");
    expect(body).toContain("random_state=42");
    expect(body).toContain("set.seed");
    expect(body).toContain("State the seed");
    expect(body).toContain("in the output");
  });

  it("documents the deterministic integrity gate and its output contract", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("stats_integrity_check.py");
    expect(body).toContain("\`\`\`review");
    expect(body).toContain("stats · interpretation");
    expect(body).toContain("stats · prereg");
    expect(body).toContain("stats · seed");
    expect(body).toContain("HARKing");
    expect(body).toContain("preregistration.md");
    expect(body).toContain("Never tell the user the analysis is");
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
    for (const stage of ["plan", "run", "gate", "report"]) {
      expect(body).toContain(stage);
    }
    expect(body).toContain("needs_confirmation");
    for (const mode of ["seed_missing", "gate_harking", "format_unreadable"]) {
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
