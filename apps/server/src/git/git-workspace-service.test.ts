import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
    expect(baseline).toMatchObject({ available: true, is_repository: true, root: await realpath(cwd), clean: false });
    expect(baseline.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(baseline.changes).toContainEqual({ index_status: "?", worktree_status: "?", path: ".pi-science/" });

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

  it.skipIf(process.platform === "win32")("does not execute a repository-controlled fsmonitor hook", async () => {
    const cwd = await workspace();
    const marker = join(cwd, "fsmonitor-executed");
    const hook = join(cwd, "fsmonitor.sh");
    await git(cwd, "init", "-q");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await git(cwd, "config", "core.fsmonitor", hook);

    expect(await inspectGitWorkspace(cwd)).toMatchObject({ is_repository: true });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a linked worktree whose Git metadata is outside the workspace", async () => {
    const repository = await workspace();
    const linked = await workspace();
    await rm(linked, { recursive: true, force: true });
    await git(repository, "init", "-q");
    await writeFile(join(repository, "tracked.txt"), "one");
    await git(repository, "add", "tracked.txt");
    await git(repository, "-c", "user.name=Pi Science Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    await git(repository, "worktree", "add", "-q", linked);
    await mkdir(join(linked, ".pi-science"));

    expect(await inspectGitWorkspace(linked)).toMatchObject({
      is_repository: false,
      reason: "repository_metadata_outside_workspace",
    });
  });
});
