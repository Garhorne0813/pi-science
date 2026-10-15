import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/persistence.js";

/** The operator file is separate from the upstream file generated for workers.
 * Never discover configuration in another Pi agent's HOME/XDG directories. */
export async function prepareWebAccessConfig(dataRoot: string): Promise<string> {
  const root = join(dataRoot, "mcp", "web-access");
  const operatorPath = join(root, "config.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(operatorPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid Web Access configuration at ${operatorPath}`);
  }
  const directory = join(root, "runtime");
  await writeJsonAtomic(join(directory, "web-search.json"), {
    provider: "auto",
    ...settings,
    // These are managed invariants; tool policy belongs to Pi-Science.
    githubClone: { enabled: false },
    githubPrIssue: { enabled: false },
    ssrf: { allowRanges: [], trustEnvProxy: false },
    tools: Object.fromEntries(["webSearch", "fetchContent", "getSearchContent", "sourceCheck"].map((name) => [name, { enabled: true }])),
  }, { mode: 0o600 });
  return directory;
}
