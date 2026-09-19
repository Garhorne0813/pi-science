import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

export interface GitChange {
  index_status: string;
  worktree_status: string;
  path: string;
  original_path?: string;
}

export interface GitWorkspaceStatus {
  available: boolean;
  is_repository: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  clean: boolean | null;
  changes: GitChange[];
  reason?: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "--no-optional-locks", ...args], {
    timeout: 10_000,
    maxBuffer: 2_000_000,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

function parsePorcelain(output: string): GitChange[] {
  const tokens = output.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 4) continue;
    const indexStatus = token[0]!;
    const worktreeStatus = token[1]!;
    const change: GitChange = { index_status: indexStatus, worktree_status: worktreeStatus, path: token.slice(3) };
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      change.original_path = tokens[++index] ?? "";
    }
    changes.push(change);
  }
  return changes;
}

/** Read-only Git detection for a registered project. Mutating operations are
 * deliberately absent; research branches and commits need a separate policy. */
export async function inspectGitWorkspace(cwd: string): Promise<GitWorkspaceStatus> {
  let root: string;
  try { root = resolve((await git(cwd, "rev-parse", "--show-toplevel")).trim()); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { available: code !== "ENOENT", is_repository: false, root: null, branch: null, head: null, clean: null, changes: [], reason: code === "ENOENT" ? "git_unavailable" : "not_a_repository" };
  }
  // Git commands can otherwise inspect a parent repository outside the
  // registered workspace, exposing paths the project did not grant.
  if (await realpath(root) !== await realpath(cwd)) {
    return { available: true, is_repository: false, root: null, branch: null, head: null, clean: null, changes: [], reason: "repository_root_outside_workspace" };
  }
  const [branch, head, status] = await Promise.all([
    git(cwd, "branch", "--show-current").then((value) => value.trim() || null),
    git(cwd, "rev-parse", "HEAD").then((value) => value.trim()).catch(() => null),
    git(cwd, "-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".", ":(exclude).pi-science"),
  ]);
  const changes = parsePorcelain(status);
  return { available: true, is_repository: true, root: await realpath(root), branch, head, clean: changes.length === 0, changes };
}
