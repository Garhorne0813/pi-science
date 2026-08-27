import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CatalogModel = Record<string, unknown>;

function generatedModelsCandidates(): string[] {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const candidates: string[] = [];
  try { candidates.push(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "models.generated.js")); }
  catch { /* packaged server dependency is unavailable; try the legacy runtime layout */ }
  candidates.push(join(projectRoot, "runtime", "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js"));
  return [...new Set(candidates)];
}

/** Load the pi-ai generated provider catalog. The server-owned pinned package
 * is preferred; the legacy runtime layout stays a fallback for older installs. */
export async function loadPiAiCatalog(): Promise<CatalogModel[]> {
  const generated = generatedModelsCandidates().find((candidate) => existsSync(candidate));
  if (!generated) return [];
  try {
    const module = await import(pathToFileURL(generated).href) as { MODELS?: Record<string, unknown> };
    const result: CatalogModel[] = [];
    for (const [provider, entries] of Object.entries(module.MODELS ?? {})) {
      const models = Array.isArray(entries) ? entries : entries && typeof entries === "object" ? Object.values(entries) : [];
      for (const entry of models) {
        if (!entry || typeof entry !== "object") continue;
        result.push({ provider, ...(entry as CatalogModel) });
      }
    }
    return result;
  } catch {
    return [];
  }
}
