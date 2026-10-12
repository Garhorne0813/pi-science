#!/usr/bin/env node
// Bootstrap the repository-pinned pnpm through npm's cache without a global install.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) throw new Error("Expected an exact pnpm version in package.json");
const version = packageManager.slice(5);
const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}` };
// npm ships beside Node; invoke its JS entry to avoid Windows .cmd quoting.
let npmCli = process.platform === "win32"
  ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
  : join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
if (!existsSync(npmCli) && process.platform !== "win32") {
  const which = spawnSync("/bin/sh", ["-c", "command -v npm"], { encoding: "utf8", env });
  if (which.status === 0) {
    const { realpathSync } = await import("node:fs");
    npmCli = realpathSync(which.stdout.trim());
  }
}
if (!existsSync(npmCli)) {
  console.error("npm is missing from this Node.js installation. Install Node.js with npm to bootstrap " + packageManager);
  process.exit(1);
}
const run = spawnSync(process.execPath, [npmCli, "exec", "--yes", "--package", `pnpm@${version}`, "--", "pnpm", ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" });
if (run.error) console.error(`Cannot run pinned ${packageManager}: ${run.error.message}. Install Node.js with npm and check registry access.`);
process.exitCode = run.status ?? 1;
