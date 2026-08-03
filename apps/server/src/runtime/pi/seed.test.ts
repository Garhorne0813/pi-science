import { mkdirSync, readdirSync, readFileSync, existsSync, lstatSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedWorkspaceAssets } from "./pi-runtime-launch.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const sourceSkills = join(projectRoot, "skills");

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempCwd(): string {
  const cwd = join(tmpdir(), `pi-seed-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  cleanups.push(cwd);
  return cwd;
}

function tempExternal(): string {
  const dir = join(tmpdir(), `pi-seed-ext-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

function skillNames(): string[] {
  return readdirSync(sourceSkills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(sourceSkills, name, "SKILL.md")));
}

/** First builtin skill that carries at least one subdirectory upstream. */
function firstSkillWithSubdir(): { name: string; subdir: string } {
  for (const name of skillNames()) {
    for (const entry of readdirSync(join(sourceSkills, name), { withFileTypes: true })) {
      if (entry.isDirectory()) return { name, subdir: entry.name };
    }
  }
  throw new Error("no builtin skill with a subdirectory found");
}

describe("seedWorkspaceAssets", () => {
  it("refuses a symlink at the skill tree root and never deletes through it", () => {
    const cwd = tempCwd();
    const external = tempExternal();
    writeFileSync(join(external, "keep.txt"), "do not delete", "utf8");
    const name = skillNames()[0]!;
    mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(external, join(cwd, ".pi", "skills", name));

    const seeded = seedWorkspaceAssets(cwd);

    expect(seeded).toContain(join(cwd, ".pi", "skills", name));
    const info = lstatSync(join(cwd, ".pi", "skills", name));
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isDirectory()).toBe(true);
    expect(existsSync(join(cwd, ".pi", "skills", name, "SKILL.md"))).toBe(true);
    // The external directory the link pointed at is untouched.
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("do not delete");
  });

  it("removes a nested symlink before writing and never writes through it", () => {
    const cwd = tempCwd();
    const external = tempExternal();
    const { name, subdir } = firstSkillWithSubdir();
    mkdirSync(join(cwd, ".pi", "skills", name), { recursive: true });
    symlinkSync(external, join(cwd, ".pi", "skills", name, subdir));

    seedWorkspaceAssets(cwd);

    const target = join(cwd, ".pi", "skills", name, subdir);
    const info = lstatSync(target);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isDirectory()).toBe(true);
    // Nothing was written into the external directory through the link.
    expect(readdirSync(external)).toEqual([]);
  });

  it("removes stale entries that no longer exist upstream", () => {
    const cwd = tempCwd();
    const name = skillNames()[0]!;
    mkdirSync(join(cwd, ".pi", "skills", name), { recursive: true });
    writeFileSync(join(cwd, ".pi", "skills", name, "stale-helper.py"), "print('stale')\n", "utf8");

    seedWorkspaceAssets(cwd);

    expect(existsSync(join(cwd, ".pi", "skills", name, "stale-helper.py"))).toBe(false);
    expect(existsSync(join(cwd, ".pi", "skills", name, "SKILL.md"))).toBe(true);
  });

  it("mirrors the full skill directory including helpers and tests", () => {
    const cwd = tempCwd();
    const { name, subdir } = firstSkillWithSubdir();
    const upstreamFiles = readdirSync(join(sourceSkills, name, subdir));

    seedWorkspaceAssets(cwd);

    const mirrored = join(cwd, ".pi", "skills", name, subdir);
    expect(lstatSync(mirrored).isDirectory()).toBe(true);
    expect(readdirSync(mirrored).sort()).toEqual(upstreamFiles.sort());
    expect(readFileSync(join(cwd, ".pi", "skills", name, "SKILL.md"), "utf8")).toBe(
      readFileSync(join(sourceSkills, name, "SKILL.md"), "utf8"),
    );
  });

  it("self-heals a file blocking a directory entry (type mismatch)", () => {
    const cwd = tempCwd();
    const { name, subdir } = firstSkillWithSubdir();
    mkdirSync(join(cwd, ".pi", "skills", name), { recursive: true });
    writeFileSync(join(cwd, ".pi", "skills", name, subdir), "i am a file", "utf8");

    seedWorkspaceAssets(cwd);

    const target = join(cwd, ".pi", "skills", name, subdir);
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(readdirSync(target).sort()).toEqual(readdirSync(join(sourceSkills, name, subdir)).sort());
  });

  it("seeds every builtin skill with its SKILL.md", () => {
    const cwd = tempCwd();

    const seeded = seedWorkspaceAssets(cwd);

    expect(seeded.length).toBe(skillNames().length);
    for (const name of skillNames()) {
      expect(existsSync(join(cwd, ".pi", "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("is idempotent across repeated seeds", () => {
    const cwd = tempCwd();
    seedWorkspaceAssets(cwd);
    const name = skillNames()[0]!;
    const first = readFileSync(join(cwd, ".pi", "skills", name, "SKILL.md"), "utf8");

    seedWorkspaceAssets(cwd);

    expect(readFileSync(join(cwd, ".pi", "skills", name, "SKILL.md"), "utf8")).toBe(first);
    expect(seededCount(cwd)).toBe(skillNames().length);
  });

  it("replaces a symlink at cwd/.pi and never writes or deletes through it", () => {
    const cwd = tempCwd();
    const external = tempExternal();
    writeFileSync(join(external, "keep.txt"), "do not delete", "utf8");
    mkdirSync(join(external, "skills"), { recursive: true });
    symlinkSync(external, join(cwd, ".pi"));

    const seeded = seedWorkspaceAssets(cwd);

    const piInfo = lstatSync(join(cwd, ".pi"));
    expect(piInfo.isSymbolicLink()).toBe(false);
    expect(piInfo.isDirectory()).toBe(true);
    expect(seeded).toContain(join(cwd, ".pi", "skills", skillNames()[0]!));
    expect(existsSync(join(cwd, ".pi", "skills", skillNames()[0]!, "SKILL.md"))).toBe(true);
    // The external directory the link pointed at is untouched.
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("do not delete");
  });

  it("replaces a symlink at cwd/.pi-science and never writes through it", () => {
    const cwd = tempCwd();
    const external = tempExternal();
    writeFileSync(join(external, "keep.txt"), "do not delete", "utf8");
    symlinkSync(external, join(cwd, ".pi-science"));

    seedWorkspaceAssets(cwd);

    const info = lstatSync(join(cwd, ".pi-science"));
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isDirectory()).toBe(true);
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("do not delete");
  });

  it("replaces a dangling AGENTS.md symlink with the seeded file", () => {
    const cwd = tempCwd();
    symlinkSync(join(cwd, "does-not-exist.md"), join(cwd, "AGENTS.md"));

    seedWorkspaceAssets(cwd);

    const info = lstatSync(join(cwd, "AGENTS.md"));
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isFile()).toBe(true);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(
      readFileSync(join(projectRoot, "harness", "AGENTS.md"), "utf8"),
    );
  });

  it("replaces an external-pointing AGENTS.md symlink and never writes through it", () => {
    const cwd = tempCwd();
    const external = tempExternal();
    writeFileSync(join(external, "keep.txt"), "do not delete", "utf8");
    symlinkSync(external, join(cwd, "AGENTS.md"));

    seedWorkspaceAssets(cwd);

    const info = lstatSync(join(cwd, "AGENTS.md"));
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isFile()).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md", "keep.txt"))).toBe(false);
    // The external directory the link pointed at is untouched.
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("do not delete");
  });

  it("logs a warning when removing stale entries", () => {
    const cwd = tempCwd();
    const name = skillNames()[0]!;
    mkdirSync(join(cwd, ".pi", "skills", name), { recursive: true });
    writeFileSync(join(cwd, ".pi", "skills", name, "stale-helper.py"), "print('stale')\n", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      seedWorkspaceAssets(cwd);
      expect(warn).toHaveBeenCalled();
      const message = String(
        warn.mock.calls.flat().find((arg) => typeof arg === "string" && arg.includes("removing stale seeded entry")) ?? "",
      );
      expect(message).toContain("stale-helper.py");
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(join(cwd, ".pi", "skills", name, "stale-helper.py"))).toBe(false);
  });

  it("tolerates a packaged checkout without a skills directory", async () => {
    const cwd = tempCwd();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: (target: nodeFs.PathLike) => (String(target) === sourceSkills ? false : actual.existsSync(target)),
      };
    });
    // pi-runtime-launch.js is statically imported at the top of this file, so
    // its module instance (and its node:fs bindings) are already cached;
    // reset the registry so the dynamic import re-executes against the mock.
    vi.resetModules();
    try {
      const { seedWorkspaceAssets: seedMissingSkills } = await import("./pi-runtime-launch.js");
      // Assert the observation point that distinguishes guarded vs unguarded
      // code: with the source skills/ mocked away, the guarded implementation
      // mirrors nothing ([]), while a guard-less readdirSync would still read
      // the real directory and return a non-empty list.
      expect(seedMissingSkills(cwd)).toEqual([]);
      // The managed tree root is still created; only the mirror loop is skipped.
      expect(existsSync(join(cwd, ".pi", "skills"))).toBe(true);
    } finally {
      vi.doUnmock("node:fs");
    }
  });
});

function seededCount(cwd: string): number {
  return readdirSync(join(cwd, ".pi", "skills")).length;
}
