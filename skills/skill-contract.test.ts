/**
 * Contract tests for every builtin skill.
 *
 * Scans the repository skills/ tree and asserts each skill satisfies the
 * pi-science authoring contract: valid front matter against the catalog
 * schema, an explicit license, directory/name consistency, declared entry
 * points present on disk, and progressive-disclosure-friendly descriptions.
 * Run from the server package via `pnpm test:skills`.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseSkill } from "../apps/server/src/catalog/skill-catalog.js";

const SKILLS_ROOT = dirname(fileURLToPath(import.meta.url));
const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const MAX_DESCRIPTION_CHARS = 1024;

async function builtinSkillDirs(): Promise<string[]> {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_ROOT, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

describe("builtin skill contract", () => {
  it("every builtin skill validates against the catalog schema with no errors", async () => {
    const dirs = await builtinSkillDirs();
    expect(dirs.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const dir of dirs) {
      const record = await parseSkill(join(SKILLS_ROOT, dir, "SKILL.md"), "builtin", SKILLS_ROOT);
      if (!record.validation.valid) {
        failures.push(`${dir}: ${record.validation.errors.join("; ")}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("directory name matches skill name and every skill declares an explicit license", async () => {
    const dirs = await builtinSkillDirs();
    const failures: string[] = [];
    for (const dir of dirs) {
      const text = await readFile(join(SKILLS_ROOT, dir, "SKILL.md"), "utf8");
      const match = text.match(FRONT_MATTER);
      const payload = match ? ((parseYaml(match[1] ?? "") ?? {}) as Record<string, unknown>) : {};
      if (payload.name !== dir) failures.push(`${dir}: frontmatter name "${String(payload.name)}" != directory name`);
      if (typeof payload.license !== "string" || payload.license.trim() === "") failures.push(`${dir}: license is not declared`);
    }
    expect(failures).toEqual([]);
  });

  it("declared entry points exist in the skill directory", async () => {
    const dirs = await builtinSkillDirs();
    const failures: string[] = [];
    for (const dir of dirs) {
      const record = await parseSkill(join(SKILLS_ROOT, dir, "SKILL.md"), "builtin", SKILLS_ROOT);
      for (const entry of record.metadata.entrypoints) {
        if (!existsSync(join(SKILLS_ROOT, dir, entry))) {
          failures.push(`${dir}: entrypoint "${entry}" does not exist`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("descriptions stay within the progressive-disclosure budget", async () => {
    const dirs = await builtinSkillDirs();
    const failures: string[] = [];
    for (const dir of dirs) {
      const record = await parseSkill(join(SKILLS_ROOT, dir, "SKILL.md"), "builtin", SKILLS_ROOT);
      if (record.metadata.description.length > MAX_DESCRIPTION_CHARS) {
        failures.push(`${dir}: description is ${record.metadata.description.length} chars (>${MAX_DESCRIPTION_CHARS})`);
      }
    }
    expect(failures).toEqual([]);
  });
});
