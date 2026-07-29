import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceFile, validateWorkspaceCwd } from "./workspace-security.js";

// Shared parity fixture: backend/tests/test_workspace_security.py mirrors this
// scenario list case-for-case. The Node control plane is the authority; any
// change here must be replicated on the Python side in the same commit.

let root = "";
const previousManagedRoot = process.env.PI_SCIENCE_WORKSPACES;

beforeEach(async () => {
  // realpath the sandbox: macOS $TMPDIR is a symlink into /private.
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-science-ws-security-")));
  delete process.env.PI_SCIENCE_WORKSPACES;
});

afterEach(() => {
  if (previousManagedRoot === undefined) delete process.env.PI_SCIENCE_WORKSPACES;
  else process.env.PI_SCIENCE_WORKSPACES = previousManagedRoot;
});

describe("validateWorkspaceCwd", () => {
  it("rejects an empty path", async () => {
    await expect(validateWorkspaceCwd("")).rejects.toThrow(/Workspace path is required/);
  });

  it("rejects a path that does not exist", async () => {
    await expect(validateWorkspaceCwd(join(root, "missing"))).rejects.toThrow();
  });

  it("rejects a file", async () => {
    const file = join(root, "notes.md");
    await writeFile(file, "x", "utf8");
    await expect(validateWorkspaceCwd(file)).rejects.toThrow(/Not a directory/);
  });

  it("accepts a directory carrying the .pi-science marker directory", async () => {
    const workspace = join(root, "marked");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await expect(validateWorkspaceCwd(workspace)).resolves.toBe(workspace);
  });

  it("rejects a directory whose .pi-science marker is a file", async () => {
    const workspace = join(root, "fake-marker");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, ".pi-science"), "", "utf8");
    await expect(validateWorkspaceCwd(workspace)).rejects.toThrow(/not a registered workspace/);
  });

  it("rejects an unmarked directory when no managed root is configured", async () => {
    const workspace = join(root, "outside");
    await mkdir(workspace, { recursive: true });
    await expect(validateWorkspaceCwd(workspace)).rejects.toThrow(/not a registered workspace/);
  });

  it("accepts an unmarked directory below the managed workspaces root", async () => {
    const managed = join(root, "managed");
    const workspace = join(managed, "child");
    await mkdir(workspace, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    await expect(validateWorkspaceCwd(workspace)).resolves.toBe(workspace);
  });

  it("accepts a nested unmarked directory below the managed workspaces root", async () => {
    const managed = join(root, "managed");
    const workspace = join(managed, "child", "deeper");
    await mkdir(workspace, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    await expect(validateWorkspaceCwd(workspace)).resolves.toBe(workspace);
  });

  it("accepts a dot-dot-prefixed child name below the managed root", async () => {
    const managed = join(root, "managed");
    const workspace = join(managed, "..results");
    await mkdir(workspace, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    await expect(validateWorkspaceCwd(workspace)).resolves.toBe(workspace);
  });

  it("rejects the managed workspaces root itself", async () => {
    const managed = join(root, "managed");
    await mkdir(managed, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    await expect(validateWorkspaceCwd(managed)).rejects.toThrow(/not a registered workspace/);
  });

  it("rejects a sibling directory sharing the managed root's name prefix", async () => {
    const managed = join(root, "managed");
    const workspace = join(root, "managed-evil");
    await mkdir(managed, { recursive: true });
    await mkdir(workspace, { recursive: true });
    process.env.PI_SCIENCE_WORKSPACES = managed;
    await expect(validateWorkspaceCwd(workspace)).rejects.toThrow(/not a registered workspace/);
  });

  it("resolves a symlink to a marked workspace and returns the link target", async () => {
    const workspace = join(root, "target");
    const link = join(root, "link");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await symlink(workspace, link, "dir");
    await expect(validateWorkspaceCwd(link)).resolves.toBe(workspace);
  });

  it("rejects a symlink inside the managed root that escapes it", async () => {
    const managed = join(root, "managed");
    const outside = join(root, "outside");
    const link = join(managed, "escape");
    await mkdir(managed, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, link, "dir");
    process.env.PI_SCIENCE_WORKSPACES = managed;
    await expect(validateWorkspaceCwd(link)).rejects.toThrow(/not a registered workspace/);
  });

  it("accepts an unmarked workspace reached through a symlinked managed root", async () => {
    const managed = join(root, "managed");
    const workspace = join(managed, "child");
    const link = join(root, "managed-link");
    await mkdir(workspace, { recursive: true });
    await symlink(managed, link, "dir");
    process.env.PI_SCIENCE_WORKSPACES = link;
    await expect(validateWorkspaceCwd(workspace)).resolves.toBe(workspace);
  });
});

describe("resolveWorkspaceFile", () => {
  it("allows a missing dot-dot-prefixed file inside a workspace", async () => {
    const workspace = join(root, "marked");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await expect(resolveWorkspaceFile(workspace, "..results.json")).resolves.toBe(join(workspace, "..results.json"));
  });

  it("rejects case variants of the metadata directory on Windows", async () => {
    const workspace = join(root, "marked");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await expect(resolveWorkspaceFile(workspace, join(".PI-SCIENCE", "secret.txt"), "win32")).rejects.toThrow(/metadata paths/);
  });

  it("rejects a missing target below a symlink that escapes the workspace", async () => {
    const workspace = join(root, "marked");
    const outside = join(root, "outside");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(workspace, "escape"), "dir");
    await expect(resolveWorkspaceFile(workspace, join("escape", "future.txt"))).rejects.toThrow(/escapes the workspace/);
  });
});
