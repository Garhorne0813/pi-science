import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isArtifactSurfaceablePath } from "../artifacts/artifact-surface-policy.js";

/** Internal server policy. Never deserialize this type from tool/HTTP parameters. */
export interface SandboxPolicy {
  id: string;
  mode: "required" | "trusted-host";
  scope: "workspace" | "candidate";
  cwd: string;
  readPaths: string[];
  writePaths: string[];
  denyPaths: string[];
  network: { mode: "none" };
  environmentRevision?: string;
  owner?: string;
}
export const isWithin = (root: string, path: string) => { const part = relative(root, path); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export async function canonicalDirectory(path: string): Promise<string> {
  const normalized = process.platform === "win32" ? resolve(path).toLowerCase() === path.replaceAll("/", "\\").toLowerCase() : resolve(path) === path;
  if (!isAbsolute(path) || !normalized || relative(path, await realpath(path)) !== "") throw new Error("Sandbox directory aliases and symlinks are forbidden");
  for (let current = path; dirname(current) !== current; current = dirname(current)) if (!(await lstat(current)).isDirectory()) throw new Error("Sandbox requires real directories");
  return path;
}
const sensitive = (name: string) => !isArtifactSurfaceablePath(name) || /^(?:research|credentials?|secrets?|evaluators?|evaluation|final[-_]?tests?|holdout)(?:$|[._-])/i.test(name);

/** Enumerate protected paths instead of assuming a broad workspace read grant hides secrets.
 * Reject aliases/hardlinks: a second name for a protected inode must not reopen it. */
async function protectedPaths(cwd: string): Promise<string[]> {
  // Include absent control paths too. srt creates deny-write placeholders at startup;
  // those placeholders must not change a persistent kernel's policy identity.
  const denied: string[] = [".pi-science", ".pi", ".git", ".env", ".ssh", ".aws", "research", "node_modules", ".bash_profile", ".bashrc", ".claude", ".gitconfig", ".gitmodules", ".idea", ".mcp.json", ".profile", ".ripgreprc", ".vscode", ".zprofile", ".zshrc"].map((name) => join(cwd, name)); let count = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 100_000) throw new Error("Workspace too large to establish sandbox policy");
      const path = join(directory, entry.name);
      if (sensitive(entry.name)) { denied.push(path); continue; }
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) { denied.push(path); continue; }
      if (info.isDirectory() && entry.name !== "node_modules") await visit(path);
      // Dependencies may contain links. They are not a trusted read grant.
      if (entry.name === "node_modules") denied.push(path);
    }
  };
  await visit(cwd);
  return [...new Set(denied)].sort();
}
export async function workspacePolicy(cwd: string, environmentRevision?: string): Promise<SandboxPolicy> {
  const mode = operatorExecutionMode();
  // Native compatibility accepts OS-normalized paths. Required execution still
  // rejects every linked component, including junctions and directory aliases.
  cwd = mode === "required" ? await canonicalDirectory(cwd) : await realpath(resolve(cwd));
  return identifyPolicy({ mode, scope: "workspace", cwd, readPaths: [cwd], writePaths: [cwd], denyPaths: mode === "required" ? await protectedPaths(cwd) : [], network: { mode: "none" }, ...(environmentRevision ? { environmentRevision } : {}) });
}
export function identifyPolicy(policy: Omit<SandboxPolicy, "id">): SandboxPolicy {
  const { id: _oldId, ...content } = policy as SandboxPolicy;
  return Object.freeze({ ...content, id: createHash("sha256").update(JSON.stringify(content)).digest("hex") });
}
/** Only the service operator's environment selects host execution. Absence means fail closed. */
export function operatorExecutionMode(): SandboxPolicy["mode"] {
  const mode = process.env.PI_SCIENCE_EXECUTION_MODE ?? "required";
  if (mode !== "required" && mode !== "trusted-host") throw new Error("Invalid operator execution mode");
  return mode;
}
