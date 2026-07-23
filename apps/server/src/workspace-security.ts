import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

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
  const managedRoot = process.env.PI_SCIENCE_WORKSPACES ? resolve(process.env.PI_SCIENCE_WORKSPACES) : null;
  if (managedRoot) {
    const relativePath = relative(managedRoot, root);
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return root;
  }
  throw new Error(`Path is not a registered workspace: ${cwd}`);
}

export async function resolveWorkspaceFile(workspace: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath)) throw new Error("Artifact path must be relative to the workspace");
  const root = await validateWorkspaceCwd(workspace);
  const candidate = resolve(root, relativePath);
  let canonicalCandidate = candidate;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    // A missing file may still be a valid target for a future write. The
    // lexical containment check below remains mandatory in that case.
  }
  const relativePathFromRoot = relative(root, canonicalCandidate);
  if (relativePathFromRoot.startsWith("..") || isAbsolute(relativePathFromRoot)) {
    throw new Error("Artifact path escapes the workspace");
  }
  if (relativePathFromRoot.split(/[\\/]/).includes(".pi-science")) {
    throw new Error("Artifact metadata paths are not publishable");
  }
  return canonicalCandidate;
}
