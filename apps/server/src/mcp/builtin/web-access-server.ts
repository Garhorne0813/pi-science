import { prepareWebAccessConfig } from "../web-access-config.js";
import { isAbsolute } from "node:path";

// The upstream CLI loads configuration during module initialization. Set its
// directory before importing it, including when a connector binds another one.
const dataRoot = process.argv[2];
if (!dataRoot || !isAbsolute(dataRoot)) throw new Error("Web Access requires an absolute Pi-Science data root");
process.env.PI_CODING_AGENT_DIR = await prepareWebAccessConfig(dataRoot);
const entry = import.meta.resolve("pi-web-access/dist/mcp-cli.js");
await import(entry);
