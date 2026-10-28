import { sessionPolicy } from "./session-approval.js";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isArtifactSurfaceablePath } from "../artifacts/artifact-surface-policy.js";
import { applySandboxProfile, type SandboxProfile } from "./profiles.js";

/** Internal server policy. Never deserialize this type from tool/HTTP parameters. */
export interface SandboxPolicy {
  id: string;
  mode: "required" | "trusted-host";
  scope: "workspace" | "confined" | "candidate";
  cwd: string;
  readPaths: string[];
  writePaths: string[];
  denyPaths: string[];
  writeDenyPaths?: string[];
  network: { mode: "none" } | { mode: "allowlist"; allowedDomains: string[]; httpsOnlyDomains?: string[]; deniedDomains: string[] };
  profile?: SandboxProfile;
  profilePolicyId?: string;
  environmentRevision?: string;
  operatorReadPolicyId?: string;
  owner?: string;
  approval?: { sessionId: string; revision: number };
  executionGrant?: { id: string; sources: Array<{ path: string; sha256: string }>; deadline: number; budget: { path: string; nodeId: string; ownerHash: string } };
}
export const isWithin = (root: string, path: string) => { const part = relative(root, path); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
// macOS ships two system aliases: /var and /tmp resolve under /private. They are
// platform spelling, not attacker-controlled links, so `/var/folders/...` from
// os.tmpdir() must stay usable. Every other divergence remains rejected.
const systemAlias = (path: string, canonical: string): boolean => process.platform === "darwin"
  && (path === "/var" || path.startsWith("/var/") || path === "/tmp" || path.startsWith("/tmp/"))
  && canonical === `/private${path}`;
export async function canonicalDirectory(path: string): Promise<string> {
  const normalized = process.platform === "win32" ? resolve(path).toLowerCase() === path.replaceAll("/", "\\").toLowerCase() : resolve(path) === path;
  if (!isAbsolute(path) || !normalized) throw new Error("Sandbox directory aliases and symlinks are forbidden");
  const canonical = await realpath(path);
  // Keep the caller's spelling unless a platform alias was accepted; Windows
  // realpath may change drive case and the path normalizer must preserve it.
  const aliased = relative(path, canonical) !== "";
  if (aliased && !systemAlias(path, canonical)) throw new Error("Sandbox directory aliases and symlinks are forbidden");
  const resolved = aliased ? canonical : path;
  for (let current = resolved; dirname(current) !== current; current = dirname(current)) if (!(await lstat(current)).isDirectory()) throw new Error("Sandbox requires real directories");
  return resolved;
}
export const isSensitiveWorkspaceName = (name: string) => name === "node_modules" || !isArtifactSurfaceablePath(name) || /^(?:credentials?|secrets?|final[-_]?tests?|holdout)(?:$|[._-])/i.test(name);

// Bound outstanding metadata requests rather than serializing one filesystem
// round trip per file or queuing an entire large tree. Never cache metadata:
// even an unchanged directory can contain a file whose link count changed.
const PROTECTED_PATH_STAT_BATCH = 32;

/** Enumerate protected paths instead of assuming a broad workspace read grant hides secrets.
 * Reject aliases/hardlinks: a second name for a protected inode must not reopen it. */
export async function protectedPaths(cwd: string): Promise<string[]> {
  // Include absent control paths too. srt creates deny-write placeholders at startup;
  // those placeholders must not change a persistent kernel's policy identity.
  const denied: string[] = [".pi-science", ".pi", ".git", ".env", ".ssh", ".aws", "node_modules", ".bash_profile", ".bashrc", ".claude", ".gitconfig", ".gitmodules", ".idea", ".mcp.json", ".profile", ".ripgreprc", ".vscode", ".zprofile", ".zshrc"].map((name) => join(cwd, name)); let count = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    count += entries.length;
    if (count > 100_000) throw new Error("Workspace too large to establish sandbox policy");
    for (let offset = 0; offset < entries.length; offset += PROTECTED_PATH_STAT_BATCH) {
      const batch = await Promise.all(entries.slice(offset, offset + PROTECTED_PATH_STAT_BATCH).map(async (entry) => {
        const path = join(directory, entry.name);
        return { path, info: isSensitiveWorkspaceName(entry.name) ? undefined : await lstat(path) };
      }));
      for (const { path, info } of batch) {
        if (!info || info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) { denied.push(path); continue; }
        if (info.isDirectory()) await visit(path);
      }
    }
  };
  await visit(cwd);
  return [...new Set(denied)].sort();
}
export async function workspacePolicy(cwd: string, environmentRevision?: string, profile: SandboxProfile = "analysis", sessionId?: string): Promise<SandboxPolicy> {
  const mode = operatorExecutionMode();
  // Native compatibility accepts OS-normalized paths. Required execution still
  // rejects every linked component, including junctions and directory aliases.
  cwd = mode === "required" ? await canonicalDirectory(cwd) : await realpath(resolve(cwd));
  const policy = identifyPolicy({ mode, scope: "workspace", cwd, readPaths: [cwd], writePaths: [cwd], denyPaths: mode === "required" ? await protectedPaths(cwd) : [], network: { mode: "none" }, ...(environmentRevision ? { environmentRevision } : {}) });
  return identifyPolicy(await sessionPolicy(mode === "required" ? await applySandboxProfile(policy, profile) : policy, sessionId));
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
