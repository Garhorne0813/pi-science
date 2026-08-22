import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../src/runtime/kernel/bridges");
const target = join(here, "../dist/runtime/kernel/bridges");
mkdirSync(target, { recursive: true });
for (const name of ["kernel_bridge.py", "kernel_bridge.R"]) {
  cpSync(join(source, name), join(target, name));
}
