/**
 * Content and metadata tests for the builtin literature-review skill.
 *
 * Validates the real SKILL.md against the server skill catalog (frontmatter
 * schema, paper-search MCP requirements, third-party disclosures) and asserts
 * the retrieval workflow and mandatory citation output convention are
 * documented. Run from the server package:
 *
 *   pnpm --filter @pi-science/server exec vitest run --dir ../../skills/literature-review/tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, parseSkill, validateDirectory } from "../../../apps/server/src/catalog/skill-catalog.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");

// Same pattern the frontend uses to auto-detect DOI citations in messages
// (frontend/src/app/routes/LiveSessionPage.tsx).
const FRONTEND_DOI_REGEX = /10\.\d{4,9}\/[^\s)\]}>]+/gi;

describe("literature-review skill content", () => {
  it("frontmatter validates against the catalog schema with no errors or warnings", async () => {
    const validations = await validateDirectory(SKILL_DIR);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.errors).toEqual([]);
    expect(validations[0]?.warnings).toEqual([]);
    expect(validations[0]?.valid).toBe(true);
  });

  it("requires paper-search MCP tools and declares their literature sources", async () => {
    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    expect(record.metadata.name).toBe("literature-review");
    expect(record.metadata.risk).toBe("low");
    expect(record.metadata.required_mcp_tools).toEqual([
      "paper_search_search_pubmed",
      "paper_search_search_arxiv",
      "paper_search_search_crossref",
    ]);
    expect(record.metadata.requirements).toEqual([]);

    const services = record.metadata.third_party.map((t) => t.name);
    expect(services).toContain("Crossref REST API");
    expect(services).toContain("arXiv API");
    expect(services).toContain("PubMed E-utilities");
    for (const entry of record.metadata.third_party) {
      expect(entry.license, `third_party entry ${entry.name} must declare a license`).toBeTruthy();
    }
  });

  it("documents the paper-search-only retrieval strategy", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("paper-search");
    expect(body).toContain("paper_search_search_pubmed");
    expect(body).toContain("paper_search_search_arxiv");
    expect(body).toContain("paper_search_search_crossref");
    expect(body).toContain("Never answer from memory");
    expect(body).toContain("never invent a DOI");
    expect(body).toContain("Never silently substitute memory");
    expect(body).toContain("do not call a Pi-Science literature HTTP gateway");
    expect(body).not.toContain("/api/literature/");
    expect(body).not.toContain("curl -s");

    // Result handling rules.
    expect(body).toContain("Deduplicate across providers");
    expect(body).toContain("retrieval timestamp");
    expect(body).toContain("ISO 8601");
  });

  it("states the mandatory citation output convention the frontend renders", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("## Output format (mandatory)");
    expect(body).toContain("## References");
    expect(body).toContain("doi:10.xxxx/yyyy");
    expect(body).toContain("arXiv:NNNN.NNNNN");
    expect(body).toContain("https://doi.org/");
    expect(body).toContain("https://arxiv.org/abs/");
    expect(body).toContain("synthesis, unverified");

    // The worked example must be detectable by the frontend's DOI regex.
    const detected = body.match(FRONTEND_DOI_REGEX) ?? [];
    expect(detected).toContain("10.1021/ja809598r");
  });

  it("is listed by the catalog as a valid builtin skill", async () => {
    const oldSkillsDir = process.env.PI_SCIENCE_SKILLS_DIR;
    const oldHome = process.env.HOME;
    const oldUserProfile = process.env.USERPROFILE;
    const scratch = await mkdtemp(join(tmpdir(), "lit-review-skill-"));
    try {
      // Point builtin discovery at the real skills root, and isolate user or
      // project skill dirs so nothing can shadow the builtin copy.
      process.env.PI_SCIENCE_SKILLS_DIR = SKILLS_ROOT;
      process.env.HOME = scratch;
      process.env.USERPROFILE = scratch;
      const records = await catalog(scratch);
      const skill = records.find((r) => r.name === "literature-review");
      expect(skill).toBeDefined();
      expect(skill?.source).toBe("builtin");
      expect(skill?.validation.valid).toBe(true);
      expect(skill?.required_mcp_tools).toEqual([
        "paper_search_search_pubmed",
        "paper_search_search_arxiv",
        "paper_search_search_crossref",
      ]);
    } finally {
      if (oldSkillsDir === undefined) delete process.env.PI_SCIENCE_SKILLS_DIR;
      else process.env.PI_SCIENCE_SKILLS_DIR = oldSkillsDir;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("trigger and workflow fixtures follow the evaluator convention", async () => {
    for (const file of ["fixtures.json", "workflow-fixtures.json"]) {
      const raw = await readFile(join(SKILL_DIR, "tests", file), "utf8");
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
        expect(triggered, `fixture "${fixture.prompt}" in ${file}`).toBe(fixture.expected_trigger);
        // Workflow fixtures must not require outputs the skill does not produce.
        const required = (fixture.required_outputs as string[] | undefined) ?? [];
        const produced = new Set((fixture.produced_outputs as string[] | undefined) ?? []);
        for (const output of required) {
          expect(produced.has(output), `missing output ${output} in ${file}`).toBe(true);
        }
      }
    }
  });

  it("workflow fixtures cover the new mandatory outputs", async () => {
    const raw = await readFile(join(SKILL_DIR, "tests", "workflow-fixtures.json"), "utf8");
    const fixtures = JSON.parse(raw) as { required_outputs?: string[] }[];
    const allRequired = new Set(fixtures.flatMap((f) => f.required_outputs ?? []));
    expect(allRequired.has("references_section")).toBe(true);
    expect(allRequired.has("inline_identifier_citations")).toBe(true);
    expect(allRequired.has("mcp_search_record")).toBe(true);
  });
});
