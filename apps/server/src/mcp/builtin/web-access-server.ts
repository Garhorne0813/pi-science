import { prepareWebAccessConfig } from "../web-access-config.js";
import { isAbsolute, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// The upstream CLI loads configuration during module initialization. Set its
// directory before importing it, including when a connector binds another one.
let dataRoot = process.argv[2];
if (process.env.PI_SCIENCE_WEB_ACCESS_CONFIG_JSON !== undefined) {
  // The host supplies only this connector's config, never its state directory.
  dataRoot = join(process.env.HOME!, "web-access");
  const directory = join(dataRoot, "mcp", "web-access");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), process.env.PI_SCIENCE_WEB_ACCESS_CONFIG_JSON, { mode: 0o600 });
  delete process.env.PI_SCIENCE_WEB_ACCESS_CONFIG_JSON;
}
if (!dataRoot || !isAbsolute(dataRoot)) throw new Error("Web Access requires an absolute Pi-Science data root");
process.env.PI_CODING_AGENT_DIR = await prepareWebAccessConfig(dataRoot);
const entry = import.meta.resolve("pi-web-access/dist/mcp-cli.js");
await import(entry);
