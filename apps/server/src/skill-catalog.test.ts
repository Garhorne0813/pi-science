import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkill, catalog, validateDirectory } from "./skill-catalog.js";

describe("skill-catalog", () => {
  let tempDir: string;
  let oldSkillsDir: string | undefined;
  let cleanupDirs: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));
    oldSkillsDir = process.env.PI_SCIENCE_SKILLS_DIR;
    // Point builtin skills at the temp dir so we never scan real project skills.
    process.env.PI_SCIENCE_SKILLS_DIR = tempDir;
    cleanupDirs = [];
  });

  afterEach(async () => {
    if (oldSkillsDir === undefined) delete process.env.PI_SCIENCE_SKILLS_DIR;
    else process.env.PI_SCIENCE_SKILLS_DIR = oldSkillsDir;
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("parses multiline front matter and nested metadata", async () => {
    const skillDir = join(tempDir, "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: >\n  A multiline description\n  that is folded by YAML.\nversion: 1.2.3\ncategory: analysis\nrequirements:\n  - python\n  - name: numpy\n    kind: package\nthird_party:\n  - kind: library\n    name: NumPy\n    license: BSD-3-Clause\n---\n\n# Demo\n",
      "utf8",
    );
    const record = await parseSkill(join(skillDir, "SKILL.md"), "project", tempDir);
    expect(record.validation.valid).toBe(true);
    expect(record.metadata.description).toBe("A multiline description that is folded by YAML.\n");
    expect(record.metadata.requirements.map((r) => r.name)).toEqual(["python", "numpy"]);
    expect(record.metadata.requirements[1]?.kind).toBe("package");
    expect(record.metadata.third_party[0]?.name).toBe("NumPy");
    expect(record.digest).toBeTruthy();
    expect(record.skillId).toBeTruthy();
  });

  it("reports invalid front matter without crashing", async () => {
    const skillDir = join(tempDir, "bad");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: Bad Name\ndescription: [\n---\n", "utf8");
    const record = await parseSkill(join(skillDir, "SKILL.md"), "project", tempDir);
    expect(record.validation.valid).toBe(false);
    expect(record.validation.errors.length).toBeGreaterThan(0);
  });

  it("catalog prefers project skill over duplicate builtin", async () => {
    // project skill
    const projectSkillDir = join(tempDir, ".pi", "skills", "same");
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(
      join(projectSkillDir, "SKILL.md"),
      "---\nname: same\ndescription: Project copy\n---\n",
      "utf8",
    );

    // builtin skill (same name) in a separate temp dir
    const builtinDir = await mkdtemp(join(tmpdir(), "skill-builtin-"));
    cleanupDirs.push(builtinDir);
    process.env.PI_SCIENCE_SKILLS_DIR = builtinDir;
    const builtinSkillDir = join(builtinDir, "same");
    await mkdir(builtinSkillDir, { recursive: true });
    await writeFile(
      join(builtinSkillDir, "SKILL.md"),
      "---\nname: same\ndescription: Builtin copy\n---\n",
      "utf8",
    );

    const records = await catalog(tempDir);
    const same = records.find((r) => r.name === "same");
    expect(same).toBeDefined();
    expect(same?.source).toBe("project");
    expect(same?.description).toBe("Project copy");
  });

  it("validates a directory with a valid skill", async () => {
    const skillDir = join(tempDir, "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\n---\n",
      "utf8",
    );
    const validations = await validateDirectory(skillDir);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.valid).toBe(true);
  });

  it("validates a directory with no skills", async () => {
    const emptyDir = join(tempDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    const validations = await validateDirectory(emptyDir);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.valid).toBe(false);
  });

  it("emits a warning when third_party has no license", async () => {
    const skillDir = join(tempDir, "unlicensed");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: unlicensed\ndescription: test\nthird_party:\n  - kind: service\n    name: Some API\n---\n",
      "utf8",
    );
    const record = await parseSkill(join(skillDir, "SKILL.md"), "project", tempDir);
    expect(record.validation.warnings).toContain(
      "third_party entries do not declare a license",
    );
  });
});
