import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiConfig } from "@pi-science/contracts";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { seedWorkspaceAssets } from "./runtime-config.js";

/** Literal packaged catalogue. A new builtin skill updates this list on purpose. */
const BUILTIN_SKILLS = [
  "auto-research",
  "band-structure-analysis", "figure-composer", "figure-style", "latex-pdf", "literature-review", "materials-phase-analysis",
  "molecule-qc", "pdf-explore", "publication-figures", "scientific-problem-selection", "single-cell-rna-qc", "stats-integrity", "traceability-review",
];

const roots: string[] = [];
const previousHome = process.env.PI_SCIENCE_HOME;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function service(): AgentCoreSessionService {
  return new AgentCoreSessionService({} as never, { environment: async () => ({}) } as never);
}

/** Only `skills` reaches the catalogue; the rest of PiConfig belongs to runtime startup. */
const configWithSkills = (skills: string[] = []): PiConfig => ({ skills } as PiConfig);

function skillNames(commands: Array<{ name: string }>): string[] {
  return commands.filter((command) => command.name.startsWith("skill:")).map((command) => command.name);
}

function home(cwd: string): void { process.env.PI_SCIENCE_HOME = join(cwd, "control-home"); }

describe("composerCommands skill catalogue", () => {
  it("lists every packaged skill for a workspace that never opened a session", async () => {
    const cwd = await tempDir("pi-science-composer-cold-");
    home(cwd);

    const { commands } = await service().composerCommands(cwd, configWithSkills());

    expect(skillNames(commands)).toEqual(BUILTIN_SKILLS.map((name) => `skill:${name}`));
    expect(commands.find((command) => command.name === "skill:literature-review"))
      .toMatchObject({ source: "skill", group: "skill", description: expect.stringContaining("literature") });
    // A GET must not seed the workspace.
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it("keeps one entry per packaged name after seeding and prefers the workspace copy", async () => {
    const cwd = await tempDir("pi-science-composer-seeded-");
    home(cwd);
    seedWorkspaceAssets(cwd);
    const localSkill = join(cwd, ".pi", "skills", "literature-review", "SKILL.md");
    const upstream = await readFile(localSkill, "utf8");
    await writeFile(localSkill, upstream.replace(/^description: .*$/m, "description: Workspace-local literature override."), "utf8");

    const { commands } = await service().composerCommands(cwd, configWithSkills());

    expect(skillNames(commands)).toEqual(BUILTIN_SKILLS.map((name) => `skill:${name}`));
    expect(commands.filter((command) => command.name === "skill:literature-review"))
      .toEqual([{ name: "skill:literature-review", description: "Workspace-local literature override.", source: "skill", group: "skill" }]);
  });

  it("still lists a configured skill directory next to the packaged ones", async () => {
    const cwd = await tempDir("pi-science-composer-configured-");
    const extra = await tempDir("pi-science-composer-extra-");
    home(cwd);
    await mkdir(join(extra, "team-lint"), { recursive: true });
    await writeFile(join(extra, "team-lint", "SKILL.md"), "---\nname: team-lint\ndescription: Team lint rules.\n---\n\nRun the team lint.\n", "utf8");

    const { commands } = await service().composerCommands(cwd, configWithSkills([extra]));

    expect(skillNames(commands)).toEqual([...BUILTIN_SKILLS.map((name) => `skill:${name}`), "skill:team-lint"]);
  });
});
