import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../src/storage/sqlite/migrations");
const target = join(here, "../dist/storage/sqlite/migrations");
await mkdir(target, { recursive: true });
const files = (await readdir(source)).filter((name) => name.endsWith(".sql")).sort();
for (const file of files) await cp(join(source, file), join(target, file));
if (files.length === 0) throw new Error("No SQLite migration assets were found");
