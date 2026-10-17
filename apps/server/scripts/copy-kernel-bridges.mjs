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
const sandboxTarget = join(here, "../dist/runtime/sandbox");
mkdirSync(sandboxTarget, { recursive: true });
cpSync(join(here, "../src/runtime/sandbox/macos-supervisor.c"), join(sandboxTarget, "macos-supervisor.c"));
cpSync(join(here, "../src/runtime/sandbox/file-write-helper.mjs"), join(sandboxTarget, "file-write-helper.mjs"));
