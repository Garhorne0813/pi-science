import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resourceRoot } from "./resource-root.js";

type CatalogModel = Record<string, unknown>;

/** Load the pi-ai generated provider catalog without making it a compile-time
 * dependency of the control plane. Older installs simply use the legacy
 * fallback in settings-routes.ts. */
export async function loadPiAiCatalog(): Promise<CatalogModel[]> {
  const generated = join(resourceRoot(), "runtime", "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");
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
