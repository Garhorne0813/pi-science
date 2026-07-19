import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("pi-ai package root is required");

const ai = await import(pathToFileURL(path.join(packageRoot, "dist", "index.js")).href);
const catalog = await import(pathToFileURL(path.join(packageRoot, "dist", "providers", "all.js")).href);

const models = [];
for (const provider of catalog.getBuiltinProviders()) {
  for (const model of catalog.getBuiltinModels(provider)) {
    models.push({
      provider: model.provider,
      id: model.id,
      api: model.api,
      reasoning: model.reasoning,
      thinking_levels: ai.getSupportedThinkingLevels(model),
      thinking_level_map: model.thinkingLevelMap || null,
    });
  }
}

process.stdout.write(JSON.stringify({ models }));
