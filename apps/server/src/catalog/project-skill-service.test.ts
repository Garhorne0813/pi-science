import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { discover } from "./skill-catalog.js";
import {
  createProjectSkill,
  deleteProjectSkill,
  importSkillBundle,
  normalizeZipPath,
  parseGithubRepo,
  previewSkillUpload,
  projectSkillDir,
  updateProjectSkill,
} from "./project-skill-service.js";

const cleanups: string[] = [];

beforeEach(async () => {
  cleanups.push(await mkdtemp(join(tmpdir(), "pi-project-skill-")));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}, 30_000);

function cwd(): string {
  return cleanups[0]!;
}

describe("project skill service", () => {
  it("creates a project-scoped skill and makes it discoverable", async () => {
    const skill = await createProjectSkill(cwd(), "my-skill", {
      name: "my-skill",
      description: "Run a reproducible workflow",
      body: "# Workflow\n\n1. Load data\n2. Plot it",
    });
    expect(skill.source).toBe("project");
    expect(skill.name).toBe("my-skill");
    const content = await readFile(join(projectSkillDir(cwd(), "my-skill"), "SKILL.md"), "utf8");
    expect(content).toContain("name: my-skill");
    expect(content).toContain("description: Run a reproducible workflow");
    const records = await discover(cwd());
    expect(records.some((record) => record.metadata.name === "my-skill" && record.source === "project")).toBe(true);
  });

  it("rejects duplicate project skills", async () => {
    await createProjectSkill(cwd(), "dup-skill", { name: "dup-skill", description: "first", body: "one" });
    await expect(createProjectSkill(cwd(), "dup-skill", { name: "dup-skill", description: "second", body: "two" })).rejects.toThrow(/already exists/i);
  });

  it("rejects invalid skill names", async () => {
    await expect(createProjectSkill(cwd(), "../escape", { name: "../escape", description: "bad", body: "x" })).rejects.toThrow(/Skill name must start/i);
    await expect(createProjectSkill(cwd(), "UPPER", { name: "UPPER", description: "bad", body: "x" })).rejects.toThrow(/Skill name must start/i);
  });

  it("updates an existing project skill body and metadata", async () => {
    await createProjectSkill(cwd(), "updatable", { name: "updatable", description: "old description", body: "old body", version: "0.1.0" });
    const updated = await updateProjectSkill(cwd(), "updatable", { name: "updatable", description: "new description", body: "new body", version: "0.2.0" });
    expect(updated.description).toBe("new description");
    const content = await readFile(join(projectSkillDir(cwd(), "updatable"), "SKILL.md"), "utf8");
    expect(content).toContain("new body");
    expect(content).toContain("version: 0.2.0");
  });

  it("deletes only project skills", async () => {
    await createProjectSkill(cwd(), "delete-me", { name: "delete-me", description: "temp", body: "x" });
    const result = await deleteProjectSkill(cwd(), "delete-me");
    expect(result.name).toBe("delete-me");
    await expect(stat(projectSkillDir(cwd(), "delete-me"))).rejects.toThrow();
    await expect(deleteProjectSkill(cwd(), "delete-me")).rejects.toThrow(/not found/i);
  });

  it("previews and imports a single SKILL.md upload", async () => {
    const markdown = `---\nname: md-upload\ndescription: Uploaded markdown skill\n---\n\n# Hi\n`;
    const candidates = await previewSkillUpload("skill.md", Buffer.from(markdown, "utf8"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("md-upload");
    const skill = await importSkillBundle(cwd(), "skill.md", Buffer.from(markdown, "utf8"), ".");
    expect(skill.name).toBe("md-upload");
    expect(skill.source).toBe("project");
  });

  it("previews multiple skills in a zip and imports the selected root", async () => {
    const zip = new JSZip();
    zip.file("alpha/SKILL.md", "---\nname: alpha-skill\ndescription: Alpha skill\n---\n\n# Alpha\n");
    zip.file("alpha/scripts/run.py", "print('alpha')");
    zip.file("beta/SKILL.md", "---\nname: beta-skill\ndescription: Beta skill\n---\n\n# Beta\n");
    const content = await zip.generateAsync({ type: "nodebuffer" });
    const candidates = await previewSkillUpload("skills.zip", content);
    expect(candidates.map((candidate) => candidate.name).sort()).toEqual(["alpha-skill", "beta-skill"]);
    const alpha = candidates.find((candidate) => candidate.name === "alpha-skill")!;
    expect(alpha.files.some((file) => file.path === "scripts/run.py")).toBe(true);
    const skill = await importSkillBundle(cwd(), "skills.zip", content, alpha.root_path);
    expect(skill.name).toBe("alpha-skill");
    const helper = await readFile(join(projectSkillDir(cwd(), "alpha-skill"), "scripts", "run.py"), "utf8");
    expect(helper).toBe("print('alpha')");
  });

  it("rejects zip-slip paths", () => {
    expect(() => normalizeZipPath("../evil/SKILL.md")).toThrow(/Unsafe path/i);
    expect(() => normalizeZipPath("a/../../evil")).toThrow(/Unsafe path/i);
    expect(() => normalizeZipPath("C:/evil/SKILL.md")).toThrow(/Unsafe path/i);
    expect(normalizeZipPath("alpha/")).toBe("alpha");
    expect(normalizeZipPath("alpha/SKILL.md")).toBe("alpha/SKILL.md");
  });

  it("parses GitHub repository shorthand and URLs", async () => {
    await expect(parseGithubRepo("owner/repo")).resolves.toEqual({ owner: "owner", repo: "repo", ref: null });
    await expect(parseGithubRepo("owner/repo@main")).resolves.toEqual({ owner: "owner", repo: "repo", ref: "main" });
    await expect(parseGithubRepo("https://github.com/owner/repo/tree/dev/path")).resolves.toEqual({ owner: "owner", repo: "repo", ref: "dev" });
    await expect(parseGithubRepo("not-a-repo")).rejects.toThrow(/Expected owner\/repo/i);
  });
});