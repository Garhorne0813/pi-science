import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseSkill } from "../../../apps/server/src/catalog/skill-catalog.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
it("ships a validated declarative protocol with two bounded roles and no universal evaluator", async () => {
  const record = await parseSkill(join(root, "SKILL.md"), "builtin", dirname(root));
  expect(record.validation.errors).toEqual([]); expect(record.validation.warnings).toEqual([]);
  for (const path of ["agents/researcher.md", "agents/reviewer.md", "references/evaluation-design.md", "references/research-loop.md", "references/evidence-management.md", "references/reporting.md"]) expect(await stat(join(root, path))).toBeTruthy();
  await expect(stat(join(root, "scripts/evaluate.py"))).rejects.toThrow();
  const protocol = await readFile(join(root, "SKILL.md"), "utf8");
  expect(protocol).toContain("execution_budget"); expect(protocol).toContain("versioned");
  const review = await readFile(join(root, "agents/reviewer.md"), "utf8");
  expect(review).toContain("PASS/PARTIAL/FAIL"); expect(review).toContain("override objective failure");
});
