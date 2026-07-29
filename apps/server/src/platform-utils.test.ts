import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBashExecutable, findExecutable, pathIsInside, userHome } from "./platform-utils.js";

describe("platform utilities", () => {
  it("uses USERPROFILE when HOME is unavailable", () => {
    expect(userHome({ USERPROFILE: "C:\\Users\\scientist" })).toBe("C:\\Users\\scientist");
  });

  it("does not mistake dot-dot-prefixed child names for traversal", () => {
    const root = join(tmpdir(), "workspace-root");
    expect(pathIsInside(root, join(root, "..results"))).toBe(true);
    expect(pathIsInside(root, join(root, "child"))).toBe(true);
    expect(pathIsInside(root, join(root, ".."))).toBe(false);
    expect(pathIsInside(root, root)).toBe(false);
    expect(pathIsInside(root, root, true)).toBe(true);
  });

  it("finds Git for Windows bash outside PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-git-bash-"));
    const bash = join(root, "Git", "bin", "bash.exe");
    try {
      await mkdir(join(root, "Git", "bin"), { recursive: true });
      await writeFile(bash, "", "utf8");
      await expect(findBashExecutable({ PATH: "", PROGRAMFILES: root }, "win32")).resolves.toBe(bash);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("honours Windows PATHEXT and quoted PATH entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-path-"));
    const bin = join(root, "Program Files", "Tools");
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "runner.CMD"), "@echo off\r\n", "utf8");
      await expect(findExecutable("runner", { PATH: `\"${bin}\"`, PATHEXT: ".CMD;.EXE" }, "win32")).resolves.toBe(join(bin, "runner.CMD"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
