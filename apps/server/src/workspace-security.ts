import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathIsInside } from "./platform-utils.js";

async function canonicalizeForContainment(path: string): Promise<string> {
  try { return await realpath(path); }
  catch {
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    return join(await canonicalizeForContainment(parent), basename(path));
  }
}

export async function validateWorkspaceCwd(cwd: string): Promise<string> {
  if (!cwd) throw new Error("Workspace path is required");
  const root = await realpath(resolve(cwd));
  const marker = resolve(root, ".pi-science");
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  try {
    const markerStat = await stat(marker);
    if (markerStat.isDirectory()) return root;
  } catch {
    // A workspace outside the managed root must have the marker.
  }
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
  const canonicalCandidate = await canonicalizeForContainment(candidate);
  const relativePathFromRoot = relative(root, canonicalCandidate);
  if (!pathIsInside(root, canonicalCandidate, true)) {
    throw new Error("Artifact path escapes the workspace");
  }
  const includesMetadata = relativePathFromRoot.split(/[\\/]/).some((part) => part.toLowerCase() === ".pi-science");
  if (includesMetadata) throw new Error("Artifact metadata paths are not publishable");
  return canonicalCandidate;
}
