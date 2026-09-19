import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectGitWorkspace } from "./git-workspace-service.js";

const exec = promisify(execFile);
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-git-status-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"));
  return cwd;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", cwd, ...args]);
}

describe("Git workspace inspection", () => {
  it("reports a non-Git project without changing it", async () => {
    const cwd = await workspace();
    expect(await inspectGitWorkspace(cwd)).toMatchObject({ is_repository: false, clean: null, reason: "not_a_repository" });
  });

  it("reports branch, commit, and paths with spaces", async () => {
    const cwd = await workspace();
    await git(cwd, "init", "-q");
    await writeFile(join(cwd, "study data.txt"), "one");
    await git(cwd, "add", "study data.txt");
    await git(cwd, "-c", "user.name=Pi Science Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    await writeFile(join(cwd, ".pi-science", "project.json"), "{}");
    const baseline = await inspectGitWorkspace(cwd);
    expect(baseline).toMatchObject({ available: true, is_repository: true, root: await realpath(cwd), clean: true });
    expect(baseline.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(baseline.changes).toEqual([]);

    await writeFile(join(cwd, "study data.txt"), "two");
    const changed = await inspectGitWorkspace(cwd);
    expect(changed.changes).toContainEqual({ index_status: " ", worktree_status: "M", path: "study data.txt" });
    expect(changed.head).toBe(baseline.head);
  });

  it("does not inspect a parent repository beyond the workspace", async () => {
    const root = await workspace();
    await git(root, "init", "-q");
    const nested = join(root, "nested");
    await mkdir(join(nested, ".pi-science"), { recursive: true });
    expect(await inspectGitWorkspace(nested)).toMatchObject({ is_repository: false, reason: "repository_root_outside_workspace" });
  });
});
