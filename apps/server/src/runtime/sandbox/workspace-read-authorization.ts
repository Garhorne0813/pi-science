import { dirname, relative } from "node:path";
import { configRoot } from "../../storage/persistence.js";
import { executionGrantsDirectory } from "./execution-grants.js";
import { networkGrantsPath } from "./network-grants.js";
import { isSensitiveWorkspaceName, isWithin } from "./policy.js";
import { pathsOverlap, runtimeReadPolicy } from "./read-grants.js";

/** Shared read boundary; discovery deliberately supplies only the workspace root. */
export async function workspaceReadBoundary(scope: "file" | "discovery" = "file") {
  const protectedRoots = (await runtimeReadPolicy()).protectedRoots;
  const privateRoots = [configRoot(), await executionGrantsDirectory(), dirname(networkGrantsPath())];
  return (path: string, root: string) => {
    if (privateRoots.some((entry) => isWithin(entry, path))) throw new Error("Application state is service-owned");
    if (protectedRoots.some((entry) => scope === "discovery" ? isWithin(entry, path) : pathsOverlap(entry, path))) throw new Error("Protected service data is unavailable to file tools");
    if (!isWithin(root, path) || relative(root, path).split(/[\\/]/).filter(Boolean).some(isSensitiveWorkspaceName)) throw new Error("File access is outside authorized workspace data");
    return path;
  };
}
