import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSkillContent } from "./skill-catalog.js";

const originalHome = process.env.HOME;
const originalSkillsDir = process.env.PI_SCIENCE_SKILLS_DIR;
const cleanups: string[] = [];

function tmp(): string {
  const dir = resolve(join(tmpdir(), `pi-skill-content-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  cleanups.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  process.env.HOME = join(tmp(), "home");
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalSkillsDir === undefined) delete process.env.PI_SCIENCE_SKILLS_DIR;
  else process.env.PI_SCIENCE_SKILLS_DIR = originalSkillsDir;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function projectSkill(cwd: string, name: string, content: string): Promise<void> {
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  await mkdir(join(cwd, ".pi", "skills", name), { recursive: true });
  await writeFile(join(cwd, ".pi", "skills", name, "SKILL.md"), content, "utf8");
}

const SKILL_TEMPLATE = (name: string, body = "## Steps\n\n1. Do the thing.") =>
  `---\nname: ${name}\ndescription: A fixture skill for content tests\nlicense: MIT\n---\n${body}\n`;

describe("getSkillContent", () => {
  it("reads the effective project skill with a relative location", async () => {
    const cwd = tmp();
    await projectSkill(cwd, "alpha", SKILL_TEMPLATE("alpha", "## Steps\n\nRun the analysis."));
    const result = await getSkillContent("alpha", cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toMatchObject({
      name: "alpha",
      source: "project",
      location: ".pi/skills/alpha/SKILL.md",
      content: SKILL_TEMPLATE("alpha", "## Steps\n\nRun the analysis."),
    });
    expect(result.content.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("matches by skill id hash as well as by name", async () => {
    const cwd = tmp();
    await projectSkill(cwd, "alpha", SKILL_TEMPLATE("alpha"));
    const list = await (await import("./skill-catalog.js")).discover(cwd);
    const record = list.find((item) => item.metadata.name === "alpha");
    expect(record).toBeDefined();
    const result = await getSkillContent(record!.skillId, cwd);
    expect(result.ok).toBe(true);
  });

  it("prefers a project skill over a builtin with the same name", async () => {
    const cwd = tmp();
    const builtin = join(tmp(), "builtin");
    process.env.PI_SCIENCE_SKILLS_DIR = builtin;
    await mkdir(join(builtin, "alpha"), { recursive: true });
    await writeFile(join(builtin, "alpha", "SKILL.md"), SKILL_TEMPLATE("alpha", "BUILTIN BODY"), "utf8");
    await projectSkill(cwd, "alpha", SKILL_TEMPLATE("alpha", "PROJECT BODY"));
    const result = await getSkillContent("alpha", cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.source).toBe("project");
    expect(result.content.content).toContain("PROJECT BODY");
    expect(result.content.content).not.toContain("BUILTIN BODY");
  });

  it("returns not-found for an unknown skill", async () => {
    const cwd = tmp();
    await projectSkill(cwd, "alpha", SKILL_TEMPLATE("alpha"));
    const result = await getSkillContent("nope", cwd);
    expect(result).toEqual({ ok: false, error: "not-found" });
  });

  it("rejects a SKILL.md that is a symlink escaping the source root", async () => {
    const cwd = tmp();
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills", "alpha"), { recursive: true });
    const outside = join(tmp(), "outside.txt");
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, join(cwd, ".pi", "skills", "alpha", "SKILL.md"));
    const result = await getSkillContent("alpha", cwd);
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  it("rejects a SKILL.md symlink that resolves outside the user skills root", async () => {
    const home = process.env.HOME!;
    const userDir = join(home, ".pi", "agent", "skills");
    await mkdir(join(userDir, "alpha"), { recursive: true });
    const outside = join(tmp(), "outside.txt");
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, join(userDir, "alpha", "SKILL.md"));
    const cwd = tmp();
    await projectSkill(cwd, "other", SKILL_TEMPLATE("other"));
    const result = await getSkillContent("alpha", cwd);
    expect(result).toEqual({ ok: false, error: "unavailable" });
  });

  it("returns too-large for a SKILL.md above the 2 MiB cap", async () => {
    const cwd = tmp();
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills", "huge"), { recursive: true });
    await writeFile(join(cwd, ".pi", "skills", "huge", "SKILL.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const result = await getSkillContent("huge", cwd);
    expect(result).toEqual({ ok: false, error: "too-large" });
  });

  it("reads a builtin skill when no project or user copy shadows it", async () => {
    const builtin = join(tmp(), "builtin");
    process.env.PI_SCIENCE_SKILLS_DIR = builtin;
    await mkdir(join(builtin, "alpha"), { recursive: true });
    await writeFile(join(builtin, "alpha", "SKILL.md"), SKILL_TEMPLATE("alpha", "BUILTIN BODY"), "utf8");
    const cwd = tmp();
    await projectSkill(cwd, "other", SKILL_TEMPLATE("other"));
    const result = await getSkillContent("alpha", cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.source).toBe("builtin");
    expect(result.content.content).toContain("BUILTIN BODY");
  });

  it("parses a CRLF-formatted SKILL.md without leaking \\r into YAML values (Windows checkout)", async () => {
    const cwd = tmp();
    const crlf = SKILL_TEMPLATE("alpha", "CRLF BODY")
      .replace("license: MIT", "license: MIT\nrisk: low")
      .replaceAll("\n", "\r\n");
    await projectSkill(cwd, "alpha", crlf);
    const result = await getSkillContent("alpha", cwd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Without CRLF normalization the yaml package keeps a trailing \r
    // (e.g. name: "alpha\r", risk: "low\r"), failing schema enums.
    expect(result.content.name).toBe("alpha");
    expect(result.content.content).toContain("CRLF BODY");
  });
});
