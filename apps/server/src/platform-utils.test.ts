import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("finds a per-user Git for Windows installation under LocalAppData Programs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-local-git-bash-"));
    const bash = join(root, "Programs", "Git", "usr", "bin", "bash.exe");
    try {
      await mkdir(join(root, "Programs", "Git", "usr", "bin"), { recursive: true });
      await writeFile(bash, "", "utf8");
      await expect(findBashExecutable({ PATH: "", LOCALAPPDATA: root }, "win32")).resolves.toBe(bash);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("skips non-executable PATH entries and falls back to a later regular file on POSIX", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-science-executable-"));
    const first = join(root, "first");
    const second = join(root, "second");
    try {
      await mkdir(first);
      await mkdir(second);
      await writeFile(join(first, "runner"), "#!/bin/sh\n", "utf8");
      await writeFile(join(second, "runner"), "#!/bin/sh\n", "utf8");
      await chmod(join(first, "runner"), 0o644);
      await chmod(join(second, "runner"), 0o755);
      await expect(findExecutable("runner", { PATH: `${first}:${second}` }, "linux")).resolves.toBe(join(second, "runner"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("honours Windows PATHEXT and quoted PATH entries case-insensitively", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-path-"));
    const bin = join(root, "Program Files", "Tools");
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "runner.CMD"), "@echo off\r\n", "utf8");
      await expect(findExecutable("runner", { Path: `\"${bin}\"`, PathExt: ".CMD;.EXE" }, "win32")).resolves.toBe(join(bin, "runner.CMD"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not treat mixed-case Path as PATH on POSIX", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-posix-path-"));
    try {
      await writeFile(join(root, "runner"), "#!/bin/sh\n", "utf8");
      await chmod(join(root, "runner"), 0o755);
      await expect(findExecutable("runner", { Path: root }, "linux")).resolves.toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
