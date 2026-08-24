import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PI_AI_PROVIDER_CATALOG_RELATIVE = join("node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js");
const PI_AI_PROVIDER_CATALOG_IN_NODE_MODULES = join("@earendil-works", "pi-ai", "dist", "providers", "all.js");

function candidateNodeModules(sourceCli: string, projectRuntimeRoot: string): string[] {
  const candidates: string[] = [];
  let current = resolve(dirname(sourceCli));
  for (;;) {
    candidates.push(join(current, "node_modules"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.push(join(resolve(projectRuntimeRoot), "node_modules"));
  return [...new Set(candidates)];
}

/**
 * Locate the dependency tree that belongs to the Pi Orbit executable marker.
 * The marker can point outside a checkout (for example, a worktree can use a
 * runtime installed by the main checkout), so the checkout's runtime path is
 * only a final fallback. A provider catalog file is the required identity
 * check; an unrelated ancestor node_modules directory is not sufficient.
 */
export function findCompanionNodeModules(sourceCli: string, projectRuntimeRoot: string): string {
  const candidates = candidateNodeModules(sourceCli, projectRuntimeRoot);
  const match = candidates.find((candidate) => existsSync(join(candidate, PI_AI_PROVIDER_CATALOG_IN_NODE_MODULES)));
  if (match) return match;
  throw new Error(
    `Desktop resource staging cannot continue: Pi Orbit companion node_modules is missing for ${sourceCli}. `
    + `Expected ${PI_AI_PROVIDER_CATALOG_RELATIVE}; searched: ${candidates.join(", ")}`,
  );
}

/** Copy the complete companion dependency tree into the packaged resource root. */
export async function copyCompanionNodeModules(sourceNodeModules: string, destinationRuntimeRoot: string): Promise<string> {
  const destination = join(destinationRuntimeRoot, "node_modules");
  await mkdir(destinationRuntimeRoot, { recursive: true });
  await cp(sourceNodeModules, destination, { recursive: true });
  return destination;
}
