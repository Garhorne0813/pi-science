/**
 * Content and metadata tests for the builtin scientific-problem-selection skill.
 *
 * Validates the real SKILL.md against the server skill catalog schema and
 * asserts the decision-tree framework and output conventions are documented.
 * Run from the server package:
 *
 *   pnpm --filter @pi-science/server exec vitest run --dir ../../skills/scientific-problem-selection/tests
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, validateDirectory } from "../../../apps/server/src/catalog/skill-catalog.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");

describe("scientific-problem-selection skill content", () => {
  it("frontmatter validates against the catalog schema with no errors or warnings", async () => {
    const validations = await validateDirectory(SKILL_DIR);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.errors).toEqual([]);
    expect(validations[0]?.warnings).toEqual([]);
    expect(validations[0]?.valid).toBe(true);
  });

  it("declares correct metadata and an explicit license", async () => {
    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    expect(record.metadata.name).toBe("scientific-problem-selection");
    expect(record.metadata.license).toBe("Apache-2.0");
    expect(record.metadata.risk).toBe("low");
    expect(record.metadata.required_mcp_tools).toEqual([]);
    // The method must be attributed: the underlying framework is not invented.
    const thirdPartyNames = record.metadata.third_party.map((t) => t.name);
    expect(thirdPartyNames.some((n) => n.includes("Fischbach"))).toBe(true);
    for (const entry of record.metadata.third_party) {
      expect(entry.license, `third_party entry ${entry.name} must declare a license`).toBeTruthy();
    }
  });

  it("documents the three entry points and four evaluation lenses", async () => {
    const body = await readFile(SKILL_MD, "utf8");
    expect(body).toContain("Pitch an idea");
    expect(body).toContain("Share a problem");
    expect(body).toContain("Ask a strategic question");
    expect(body).toContain("Intuition pumps");
    expect(body).toContain("Risk assessment");
    expect(body).toContain("Optimization function");
    expect(body).toContain("Parameter strategy");
  });

  it("documents the decision-tree walkthrough and the mandatory output block", async () => {
    const body = await readFile(SKILL_MD, "utf8");
    expect(body).toContain("Decision-tree walkthrough");
    expect(body).toContain("MINIMAL CLAIM");
    expect(body).toContain("CHANGE-MY-MIND EXPERIMENT");
    expect(body).toContain("OBJECTIVE");
    // Anti-fabrication guardrail: the skill must not invent field knowledge.
    expect(body).toContain("Never pretend to know");
  });
});
