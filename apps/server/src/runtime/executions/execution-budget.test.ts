import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBudget } from "./execution-budget.js";
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it("retains historical consumed calls and deadlines without reviving retired scoring quotas", async () => {
  await mkdir(resolve("../../.runtime"), { recursive: true }); root = await mkdtemp(join(resolve("../../.runtime"), "budget-compat-"));
  const path = join(root, "budget.json"); const budget = { deadline: 1000, maxExecutions: 8, used: 5 };
  await writeFile(path, JSON.stringify({ ...budget, maxEvaluations: 2, evaluations: { old: { revisionId: "historical", fingerprint: "recorded" } } }));
  expect(await readBudget(path)).toEqual(budget);
  await writeFile(path, JSON.stringify({ ...budget, unexpected: true })); await expect(readBudget(path)).rejects.toThrow("Invalid saved execution budget");
});
