import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot;
    env.ComSpec = process.env.ComSpec;
    env.PATHEXT = process.env.PATHEXT;
  }
  const { stdout } = await execFileAsync("git", ["-C", cwd, "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    timeout: 10_000,
    maxBuffer: 2_000_000,
    encoding: "utf8",
    env,
  });
  return stdout;
}

function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
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
  let metadataPaths: string[];
  try {
    const [rootOutput, gitDirOutput, commonDirOutput] = (await git(cwd, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"))
      .trim().split(/\r?\n/);
    if (!rootOutput || !gitDirOutput || !commonDirOutput) throw new Error("Git repository metadata is incomplete");
    root = resolve(rootOutput);
    metadataPaths = [gitDirOutput, commonDirOutput].map((path) => resolve(cwd, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { available: code !== "ENOENT", is_repository: false, root: null, branch: null, head: null, clean: null, changes: [], reason: code === "ENOENT" ? "git_unavailable" : "not_a_repository" };
  }
  // Git commands can otherwise inspect a parent repository outside the
  // registered workspace, exposing paths the project did not grant.
  if (await realpath(root) !== await realpath(cwd)) {
    return { available: true, is_repository: false, root: null, branch: null, head: null, clean: null, changes: [], reason: "repository_root_outside_workspace" };
  }
  const canonicalRoot = await realpath(root);
  const canonicalMetadataPaths = await Promise.all(metadataPaths.map((path) => realpath(path)));
  if (canonicalMetadataPaths.some((path) => !isContained(canonicalRoot, path))) {
    return { available: true, is_repository: false, root: null, branch: null, head: null, clean: null, changes: [], reason: "repository_metadata_outside_workspace" };
  }
  const [branch, head, status] = await Promise.all([
    git(cwd, "branch", "--show-current").then((value) => value.trim() || null),
    git(cwd, "rev-parse", "HEAD").then((value) => value.trim()).catch(() => null),
    git(cwd, "-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."),
  ]);
  const changes = parsePorcelain(status);
  return { available: true, is_repository: true, root: canonicalRoot, branch, head, clean: changes.length === 0, changes };
}
