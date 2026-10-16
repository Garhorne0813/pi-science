import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseSkill } from "../../../apps/server/src/catalog/skill-catalog.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
it("ships a validated declarative protocol with three bounded roles and no universal evaluator", async () => {
  const record = await parseSkill(join(root, "SKILL.md"), "builtin", dirname(root));
  expect(record.validation.errors).toEqual([]); expect(record.validation.warnings).toEqual([]);
  for (const path of ["agents/experimenter.md", "references/research-protocol.md", "references/experimental-research.md", "references/experiment-safety.md", "agents/researcher.md", "agents/reviewer.md", "templates/research-manifest.json", "scripts/validate-manifest.mjs"]) expect(await stat(join(root, path))).toBeTruthy();
  await expect(stat(join(root, "scripts/evaluate.py"))).rejects.toThrow();
  const protocol = await readFile(join(root, "SKILL.md"), "utf8");
  expect(protocol).toContain("execution_budget"); expect(protocol).toContain("versioned");
  const review = await readFile(join(root, "agents/reviewer.md"), "utf8");
  expect(review).toContain("PASS/PARTIAL/FAIL"); expect(review).toContain("override objective failure");
});

it("declares only bounded sandbox execution with code-generation fallback and exact retrieval tools", async () => {
  const experimenter = await readFile(join(root, "agents/experimenter.md"), "utf8");
  expect(experimenter).toContain("tools: [read, bash, notebook_read, notebook_run]"); expect(experimenter).toContain('execution_mode="code-generation"');
  const researcher = await readFile(join(root, "agents/researcher.md"), "utf8");
  for (const name of ["web_search", "fetch_content", "get_search_content", "source_check"]) expect(researcher).toContain(`mcp__web-access__${name}`);
  for (const name of ["search_crossref", "search_pubmed", "search_arxiv", "search_biorxiv_preprints", "get_europe_pmc_full_text"]) expect(researcher).toContain(`mcp__paper-search__${name}`);
  expect(researcher).toContain("temporary per-worker");
});

it("routes runtime instructions to three canonical modules and keeps old links as redirects", async () => {
  const protocol = await readFile(join(root, "SKILL.md"), "utf8");
  expect([...protocol.matchAll(/\]\(references\/([^)]+)\)/g)].map((match) => match[1])).toEqual(["research-protocol.md", "experimental-research.md", "experiment-safety.md"]);
  for (const name of ["deep-research", "evaluation-design", "research-loop", "evidence-management", "reporting"]) {
    const stub = await readFile(join(root, `references/${name}.md`), "utf8");
    expect(stub).toContain("Compatibility reference"); expect(stub).not.toContain("sandbox_run permits");
  }
  const runtime = (await Promise.all(["SKILL.md", "agents/experimenter.md", "references/research-protocol.md", "references/experimental-research.md", "references/experiment-safety.md"].map((path) => readFile(join(root, path), "utf8")))).join("\n");
  for (const historical of ["pnpm ", "kill EPERM", "macOS 26", "1,778", "Unassigned children keep"]) expect(runtime).not.toContain(historical);
  expect(runtime).toContain("manifest.json"); expect(runtime).toContain("workspace reads are denied");
});
