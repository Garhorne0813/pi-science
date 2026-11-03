import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { configRoot } from "../../storage/persistence.js";
import { executionGrantsDirectory } from "./execution-grants.js";
import { networkGrantsPath } from "./network-grants.js";
import { isSensitiveWorkspaceName, isWithin } from "./policy.js";
import { pathsOverlap, runtimeReadPolicy } from "./read-grants.js";

/** Only a trusted Harness resource list can authorize local skills. A SKILL.md
 * grants its directory; a standalone skill grants only that exact file. */
export function workspaceSkillResources(cwd: string, skillFiles: string[]) {
  const container = join(cwd, ".pi", "skills");
  const files = [...new Set(skillFiles)].filter(file => isAbsolute(file) && resolve(file) === file
    && file !== container && isWithin(container, file)
    && !relative(container, file).split(/[\\/]/).some(isSensitiveWorkspaceName));
  const directories = files.filter(file => basename(file) === "SKILL.md" && dirname(file) !== container).map(dirname);
  return { files, directories };
}

/** Discovery may navigate only the ancestors of explicitly granted local skills. */
export async function workspaceReadBoundary(scope: "file" | "discovery" = "file", skillFiles: string[] = []) {
  const protectedRoots = (await runtimeReadPolicy()).protectedRoots;
  const privateRoots = [configRoot(), await executionGrantsDirectory(), dirname(networkGrantsPath())];
  return (path: string, root: string) => {
    if (privateRoots.some((entry) => isWithin(entry, path))) throw new Error("Application state is service-owned");
    if (protectedRoots.some((entry) => scope === "discovery" ? isWithin(entry, path) : pathsOverlap(entry, path))) throw new Error("Protected service data is unavailable to file tools");
    if (!isWithin(root, path)) throw new Error("File access is outside authorized workspace data");
    const skills = scope === "discovery" ? workspaceSkillResources(root, skillFiles) : { files: [], directories: [] };
    const skillRoot = skills.directories.find(directory => isWithin(directory, path)) ?? (skills.files.includes(path) ? dirname(path) : undefined);
    const navigation = scope === "discovery" && isWithin(join(root, ".pi"), path) && skills.files.some(file => path !== file && isWithin(path, file));
    if (!navigation && relative(skillRoot ?? root, path).split(/[\\/]/).filter(Boolean).some(isSensitiveWorkspaceName)) throw new Error("File access is outside authorized workspace data");
    return path;
  };
}
