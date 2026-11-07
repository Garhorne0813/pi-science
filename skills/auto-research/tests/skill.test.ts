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
  expect(protocol).toContain("Execution limits and cancellation are managed by the host"); expect(protocol).toContain("versioned");
  const review = await readFile(join(root, "agents/reviewer.md"), "utf8");
  expect(review).toContain("PASS/PARTIAL/FAIL"); expect(review).toContain("override objective failure");
});

it("inherits Parent tools without vendor lists while keeping explicit execution scopes", async () => {
  for (const name of ["researcher", "reviewer", "experimenter"]) {
    const role = await readFile(join(root, `agents/${name}.md`), "utf8");
    expect(role).not.toMatch(/^tools:/m);
    expect(role).toContain(`execution_scope: ${name === "experimenter" ? "confined" : "workspace"}`);
    expect(role).toContain("currently authorized eligible tools");
    expect(role).not.toContain("mcp__");
    if (name !== "experimenter") expect(role).toContain("not a security boundary");
  }
  expect(await readFile(join(root, "agents/experimenter.md"), "utf8")).toContain('execution_mode="code-generation"');
  expect(await readFile(join(root, "agents/researcher.md"), "utf8")).toContain("temporary per-worker");
});

it("routes runtime instructions to progressively loaded modules and keeps old links as redirects", async () => {
  const protocol = await readFile(join(root, "SKILL.md"), "utf8");
  expect([...protocol.matchAll(/\]\(references\/([^)]+)\)/g)].map((match) => match[1])).toEqual(["literature-research.md", "research-protocol.md", "experimental-research.md", "experiment-safety.md"]);
  for (const name of ["deep-research", "evaluation-design", "research-loop", "evidence-management", "reporting"]) {
    const stub = await readFile(join(root, `references/${name}.md`), "utf8");
    expect(stub).toContain("Compatibility reference"); expect(stub).not.toContain("sandbox_run permits");
  }
  const runtime = (await Promise.all(["SKILL.md", "agents/experimenter.md", "references/research-protocol.md", "references/experimental-research.md", "references/experiment-safety.md"].map((path) => readFile(join(root, path), "utf8")))).join("\n");
  for (const historical of ["pnpm ", "kill EPERM", "macOS 26", "1,778", "Unassigned children keep"]) expect(runtime).not.toContain(historical);
  expect(runtime).toContain("manifest.json"); expect(runtime).toContain("workspace reads are denied");
});

it("keeps literature prerequisites independent of experimental runtime capabilities", async () => {
  const record = await parseSkill(join(root, "SKILL.md"), "builtin", dirname(root));
  expect(record.metadata.required_tools).toEqual(["read", "write"]);
  expect(record.metadata.risk).toBe("medium");
  const lite = await readFile(join(root, "references/literature-research.md"), "utf8");
  expect(lite).toContain("No budget tool call");
  expect(lite).toContain("conversation itself can hold the entire record");
  expect(lite).toContain("contradictions and gaps");
  expect(lite).toContain("synthetic excerpts as synthetic");
});
