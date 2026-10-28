import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverAgentDefinitions, resolveAgentDefinition, childToolAllowance, childExecutionScope } from "./agent-definitions.js";
import { packagedSkillsRoot } from "./runtime-config.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function workspace() { const cwd = await mkdtemp(join(tmpdir(), "agent-definitions-")); roots.push(cwd); return cwd; }
async function put(cwd: string, path: string, content: string) { const file = join(cwd, path); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, content); }
it("resolves project aliases and skill namespaces without collisions, with project skill precedence", async () => {
  const cwd = await workspace();
  await put(cwd, ".pi/agents/reviewer.md", "---\nname: reviewer\ntools: [read, write]\n---\nProject review");
  await put(cwd, ".pi/agents/alias.md", "---\nname: auditor\npackage: science-tools\n---\nAliased review");
  await put(cwd, ".pi/skills/auto-research/SKILL.md", "---\nname: auto-research\ndescription: Research\nlicense: Apache-2.0\n---\nProtocol");
  await put(cwd, ".pi/skills/auto-research/agents/reviewer.md", "---\nname: reviewer\ntools: [read, mcp__search, ask_user_question]\n---\nLocal review");
  expect(await resolveAgentDefinition(cwd, "reviewer")).toMatchObject({ prompt: "Project review", source: "project" });
  expect(await resolveAgentDefinition(cwd, "science-tools.auditor")).toMatchObject({ prompt: "Aliased review" });
  expect(await resolveAgentDefinition(cwd, "auto-research/reviewer")).toMatchObject({ prompt: "Local review", source: "skill" });
  expect(childToolAllowance(["read", "write", "mcp__search", "ask_user_question"], ["read", "mcp__search", "ask_user_question"])).toEqual(["read"]);
  await expect(resolveAgentDefinition(cwd, "auto-research/reviewer", { mode: "none" })).rejects.toThrow("disabled");
  await expect(resolveAgentDefinition(cwd, "auto-research/reviewer", { mode: "denylist", skills: ["auto-research"] })).rejects.toThrow("disabled");
  await expect(resolveAgentDefinition(cwd, "missing/reviewer")).rejects.toThrow("disabled");
  for (const name of ["../reviewer", "auto-research/../../x", "/reviewer", "a/b/c"]) await expect(resolveAgentDefinition(cwd, name)).rejects.toThrow("Invalid");
});
it("does not follow project agent or skill-agent symlinks outside the workspace", async () => {
  const cwd = await workspace(); const outside = await workspace();
  await put(outside, "agents/foreign.md", "Foreign instructions");
  await mkdir(join(cwd, ".pi"), { recursive: true }); await symlink(join(outside, "agents"), join(cwd, ".pi/agents"));
  expect((await discoverAgentDefinitions(cwd)).some((agent) => agent.name === "foreign")).toBe(false);
  await put(cwd, ".pi/skills/safe/SKILL.md", "---\nname: safe\ndescription: Safe\nlicense: Apache-2.0\n---\nSafe");
  await symlink(join(outside, "agents"), join(cwd, ".pi/skills/safe/agents"));
  expect((await discoverAgentDefinitions(cwd)).some((agent) => agent.name === "safe/foreign")).toBe(false);
});

it("skips malformed project and skill definitions while resolving valid neighbors", async () => {
  const cwd = await workspace();
  await put(cwd, ".pi/agents/broken.md", "---\nname: [unfinished\n---\nBad");
  await put(cwd, ".pi/agents/bad-tools.md", "---\ntools: [read, 42]\n---\nBad");
  await put(cwd, ".pi/agents/valid.md", "---\nname: valid\n---\nGood");
  await put(cwd, ".pi/skills/lab/SKILL.md", "---\nname: lab\ndescription: Lab\nlicense: Apache-2.0\n---\nLab");
  await put(cwd, ".pi/skills/lab/agents/broken.md", "---\ntools: [read\n---\nBad");
  await put(cwd, ".pi/skills/lab/agents/valid.md", "---\ntools: [read]\n---\nSkill good");
  expect(await resolveAgentDefinition(cwd, "valid")).toMatchObject({ prompt: "Good" });
  expect(await resolveAgentDefinition(cwd, "lab/valid")).toMatchObject({ prompt: "Skill good", executionScope: "candidate" });
  const names = (await discoverAgentDefinitions(cwd)).map((agent) => agent.name);
  expect(names).not.toContain("broken"); expect(names).not.toContain("bad-tools"); expect(names).not.toContain("lab/broken");
});

it("delegates only exact MCP capabilities in the effective parent set", () => {
  const tools = ["read", "mcp__web-access__web_search", "mcp__web-access__fetch_content", "mcp__science__lookup", "mcp__web-access__*", "mcp__foo__bar__baz", "ask_user_question"];
  expect(childToolAllowance(tools, ["read", "mcp__web-access__web_search", "mcp__web-access__*", "mcp__foo__bar__baz", "ask_user_question"]))
    .toEqual(["read", "mcp__web-access__web_search"]);
  expect(childToolAllowance(tools, [])).toEqual([]);
  expect(childToolAllowance(tools)).toEqual([]);
});

it("caps any candidate worker at candidate-bound tools even if a project role declares writes or MCP", () => {
  const tools = ["read", "sandbox_run", "write", "edit", "bash", "notebook_run", "mcp__science__execute", "subagent"];
  expect(childToolAllowance(["sandbox_run"], ["sandbox_run"], "workspace")).toEqual([]);
  expect(childToolAllowance(tools, tools, "candidate")).toEqual(["read", "bash", "notebook_run"]);
  expect(childToolAllowance(tools, ["read", "bash"], "candidate")).toEqual(["read", "bash"]);
});

it("discovers only Bash/Notebook for the default Experimenter and preserves explicit legacy declarations", async () => {
  const cwd = await workspace();
  await put(cwd, ".pi/skills/auto-research/SKILL.md", "---\nname: auto-research\ndescription: Research\nlicense: Apache-2.0\n---\nProtocol");
  const path = ".pi/skills/auto-research/agents/experimenter.md";
  await put(cwd, path, await readFile(join(packagedSkillsRoot(), "auto-research/agents/experimenter.md"), "utf8"));
  const parent = ["read", "bash", "notebook_read", "notebook_run", "sandbox_run", "write"];
  expect(childToolAllowance((await resolveAgentDefinition(cwd, "auto-research/experimenter")).tools, parent, "candidate"))
    .toEqual(["read", "bash", "notebook_read", "notebook_run"]);
  await put(cwd, path, "---\nname: experimenter\ntools: [read, sandbox_run, write]\n---\nPreserved legacy declaration");
  const legacy = await resolveAgentDefinition(cwd, "auto-research/experimenter");
  expect(legacy).toMatchObject({ executionScope: "candidate", scopeMigrationRequired: true });
  expect(() => childExecutionScope(legacy)).toThrow("missing execution_scope");
  await put(cwd, path, "---\nname: experimenter\nexecution_scope: candidate\ntools: [read, sandbox_run, write]\n---\nExplicitly migrated legacy declaration");
  const migrated = await resolveAgentDefinition(cwd, "auto-research/experimenter");
  expect(childToolAllowance(migrated.tools, parent, childExecutionScope(migrated))).toEqual(["read"]);
});

it("derives restrictions from arbitrary role metadata, binding and inheritance", async () => {
  const cwd = await workspace();
  await put(cwd, ".pi/agents/optimizer.md", "---\nexecution_scope: candidate\ntools: [read, bash, write, subagent, mcp__science__execute]\n---\nRenamed role");
  await put(cwd, ".pi/agents/ordinary.md", "---\ntools: [read, write]\n---\nWorkspace role");
  await put(cwd, ".pi/agents/invalid.md", "---\nexecution_scope: unrestricted\n---\nInvalid");
  const restricted = await resolveAgentDefinition(cwd, "optimizer");
  const ordinary = await resolveAgentDefinition(cwd, "ordinary");
  expect(childExecutionScope(restricted)).toBe("candidate");
  expect(childToolAllowance(restricted.tools, restricted.tools, childExecutionScope(restricted))).toEqual(["read", "bash"]);
  expect(childExecutionScope(ordinary)).toBe("workspace");
  expect(childExecutionScope(ordinary, "candidate")).toBe("candidate");
  expect(childExecutionScope(ordinary, "workspace", "one")).toBe("candidate");
  await expect(resolveAgentDefinition(cwd, "invalid")).rejects.toThrow("disabled");
});

it("requires an explicit migration for unrelated Skill roles before admitting workspace tools", async () => {
  const cwd = await workspace();
  await put(cwd, ".pi/skills/document-audit/SKILL.md", "---\nname: document-audit\ndescription: Audit documents\nlicense: MIT\n---\nAudit");
  const path = ".pi/skills/document-audit/agents/auditor.md";
  await put(cwd, path, "---\ntools: [read, write, mcp__library__lookup]\n---\nAudit workspace documents");
  const legacy = await resolveAgentDefinition(cwd, "document-audit/auditor");
  expect(legacy).toMatchObject({ executionScope: "candidate", scopeMigrationRequired: true });
  for (const candidateId of [undefined, "one"]) {
    try { childExecutionScope(legacy, "workspace", candidateId); throw new Error("Unexpected admission"); }
    catch (error) {
      expect(error).toMatchObject({ code: "scope_migration_required" });
      expect(String(error)).toContain(path);
      expect(String(error)).toContain("missing execution_scope");
    }
  }
  await put(cwd, path, "---\nexecution_scope: workspace\ntools: [read, write, mcp__library__lookup]\n---\nReviewed workspace access");
  const migrated = await resolveAgentDefinition(cwd, "document-audit/auditor");
  expect(childToolAllowance(migrated.tools, ["read", "write"], childExecutionScope(migrated))).toEqual(["read", "write"]);
  expect(childToolAllowance(migrated.tools, ["read", "write"], childExecutionScope(migrated, "candidate"))).toEqual(["read"]);
});

it("preserves omitted, empty and explicit tool declarations across all role sources", async () => {
  const cwd = await workspace();
  await put(cwd, ".pi/agents/inherits.md", "---\nexecution_scope: workspace\n---\nInherit");
  await put(cwd, ".pi/agents/empty.md", "---\ntools: []\n---\nNone");
  await put(cwd, ".pi/agents/limited.md", "---\ntools: [read, write]\n---\nLimited");
  await put(cwd, ".pi/agents/invalid-tools.md", "---\ntools: false\n---\nInvalid");
  await put(cwd, ".pi/skills/notes/SKILL.md", "---\nname: notes\ndescription: Notes\nlicense: MIT\n---\nNotes");
  await put(cwd, ".pi/skills/notes/agents/auditor.md", "---\nexecution_scope: workspace\n---\nAudit");
  const definitions = await discoverAgentDefinitions(cwd);
  for (const name of ["inherits", "notes/auditor", "reviewer"]) expect(definitions.find((role) => role.name === name)?.tools).toBeUndefined();
  expect((await resolveAgentDefinition(cwd, "empty")).tools).toEqual([]);
  expect((await resolveAgentDefinition(cwd, "limited")).tools).toEqual(["read", "write"]);
  await expect(resolveAgentDefinition(cwd, "invalid-tools")).rejects.toThrow("disabled");
  const parent = ["read", "write", "bash", "mcp__new-vendor__retrieve", "mcp__new-vendor__*", "ask_user_question", "sandbox_run"];
  expect(childToolAllowance(undefined, parent)).toEqual(["read", "write", "bash", "mcp__new-vendor__retrieve"]);
  expect(childToolAllowance([], parent)).toEqual([]);
  expect(childToolAllowance(["read", "edit"], parent)).toEqual(["read"]);
  expect(childToolAllowance(undefined, parent, "confined")).toEqual(["read", "bash"]);
  await put(cwd, ".pi/skills/notes/agents/auditor.md", "---\ndescription: Old role\n---\nAudit");
  expect(() => childExecutionScope(definitions.find((role) => role.name === "notes/auditor")!)).not.toThrow();
  const legacy = await resolveAgentDefinition(cwd, "notes/auditor");
  expect(legacy.tools).toBeUndefined(); expect(() => childExecutionScope(legacy)).toThrow("scope_migration_required");
});


it("keeps discovery inside the workspace parent tool ceiling", () => {
  const parent = ["read", "ls", "glob", "grep"];
  expect(childToolAllowance(undefined, parent, "workspace")).toEqual(parent);
  expect(childToolAllowance(["grep", "bash"], parent, "workspace")).toEqual(["grep"]);
  expect(childToolAllowance(["grep"], ["read"], "workspace")).toEqual([]);
  for (const scope of ["candidate", "confined"] as const) expect(childToolAllowance(parent, parent, scope)).toEqual(["read"]);
});
