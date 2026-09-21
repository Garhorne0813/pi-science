import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathIsInside } from "../support/platform-utils.js";
import { ensureProject, readProject } from "../project/project-registry.js";
import { legacyMetadataRoot } from "../storage/persistence.js";

async function canonicalizeForContainment(root: string, path: string): Promise<string> {
  const pathFromRoot = relative(root, path);
  if (isAbsolute(pathFromRoot)) throw new Error("Artifact path escapes the workspace");
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("Artifact path escapes the workspace");
  }
  // The lexical check above prevents traversal before canonicalization; the
  // caller validates the canonical result against the workspace before use.
  try { return await realpath(path); }
  catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalizeForContainment(root, parent), basename(path));
  }
}

export async function validateWorkspaceCwd(cwd: string): Promise<string> {
  if (!cwd) throw new Error("Workspace path is required");
  if (cwd.includes("\0") || cwd.length > 32_767) throw new Error("Invalid workspace path");
  const requested = resolve(cwd);
  if (process.platform === "win32" && requested.startsWith("\\\\")) throw new Error("Network workspace paths are not supported");
  // This canonicalization is followed immediately by an exact registered
  // project, legacy migration, or managed-root containment check. Requests are
  // also protected by the control-plane token before reaching this function.
  const root = await realpath(requested); // lgtm[js/path-injection] registration and containment checks authorize this canonicalization
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  if (await readProject(root)) { await ensureProject(root); return root; }
  try {
    if ((await stat(legacyMetadataRoot(root))).isDirectory()) { await ensureProject(root); return root; }
  } catch { /* no legacy registration marker */ }
  const managedRootValue = process.env.PI_SCIENCE_WORKSPACES;
  if (managedRootValue) {
    const configuredRoot = resolve(managedRootValue);
    const managedRoot = await realpath(configuredRoot).catch(() => configuredRoot);
    if (pathIsInside(managedRoot, root)) return root;
  }
  throw new Error(`Path is not a registered workspace: ${cwd}`);
}

export async function resolveWorkspaceFile(workspace: string, relativePath: string, platform = process.platform): Promise<string> {
  if (!relativePath || isAbsolute(relativePath)) throw new Error("Artifact path must be relative to the workspace");
  const root = await validateWorkspaceCwd(workspace);
  const candidate = resolve(root, relativePath);
  const canonicalCandidate = await canonicalizeForContainment(root, candidate);
  const relativePathFromRoot = relative(root, canonicalCandidate);
  if (
    isAbsolute(relativePathFromRoot) ||
    relativePathFromRoot === ".." ||
    relativePathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error("Artifact path escapes the workspace");
  }
  const includesReservedMetadata = relativePathFromRoot.split(/[\\/]/).some((part) => part.toLowerCase() === ".pi-science");
  if (includesReservedMetadata) throw new Error("Artifact metadata paths are not publishable");
  return canonicalCandidate;
}
