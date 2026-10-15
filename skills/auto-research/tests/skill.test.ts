import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseSkill } from "../../../apps/server/src/catalog/skill-catalog.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
it("ships a validated declarative protocol with three bounded roles and no universal evaluator", async () => {
  const record = await parseSkill(join(root, "SKILL.md"), "builtin", dirname(root));
  expect(record.validation.errors).toEqual([]); expect(record.validation.warnings).toEqual([]);
  for (const path of ["agents/experimenter.md", "references/experimental-research.md", "references/deep-research.md", "references/experiment-safety.md", "agents/researcher.md", "agents/reviewer.md", "references/evaluation-design.md", "references/research-loop.md", "references/evidence-management.md", "references/reporting.md"]) expect(await stat(join(root, path))).toBeTruthy();
  await expect(stat(join(root, "scripts/evaluate.py"))).rejects.toThrow();
  const protocol = await readFile(join(root, "SKILL.md"), "utf8");
  expect(protocol).toContain("execution_budget"); expect(protocol).toContain("versioned");
  const review = await readFile(join(root, "agents/reviewer.md"), "utf8");
  expect(review).toContain("PASS/PARTIAL/FAIL"); expect(review).toContain("override objective failure");
});

it("keeps candidate generation read-only until sandbox enforcement exists and declares exact retrieval tools", async () => {
  const experimenter = await readFile(join(root, "agents/experimenter.md"), "utf8");
  expect(experimenter).toContain("tools: [read]"); expect(experimenter).toContain('execution_mode="code-generation"');
  const researcher = await readFile(join(root, "agents/researcher.md"), "utf8");
  for (const name of ["web_search", "fetch_content", "get_search_content", "source_check"]) expect(researcher).toContain(`mcp__web-access__${name}`);
  for (const name of ["search_crossref", "search_pubmed", "search_arxiv", "search_biorxiv_preprints", "get_europe_pmc_full_text"]) expect(researcher).toContain(`mcp__paper-search__${name}`);
  expect(researcher).toContain("temporary per-worker");
});
