import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CatalogModel = Record<string, unknown>;

/** Load the pi-ai generated provider catalog without making it a compile-time
 * dependency of the control plane. Older installs simply use the legacy
 * fallback in settings-routes.ts. */
export async function loadPiAiCatalog(): Promise<CatalogModel[]> {
  // Resolve from this module, not process.cwd(). The server is launched from
  // both the repository root and apps/server during development/tests.
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const generated = join(projectRoot, "runtime", "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");
  if (!existsSync(generated)) return [];
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
