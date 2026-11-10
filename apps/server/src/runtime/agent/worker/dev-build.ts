import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Development-only precompiled worker.
 *
 * `pnpm dev` runs the control plane through tsx, which transpiles the whole
 * worker dependency graph on every fork (5-7s per session on a cold cache).
 * The production build already emits `worker/main.js`, so those installs never
 * pay it. This module mirrors `apps/server/src` to JavaScript next to the
 * sources so a dev worker can be forked with plain Node.
 *
 * The mirror keeps the exact directory depth of `src/`, because several worker
 * modules resolve trusted paths relative to `import.meta.url`.
 */

const OUT_DIR_NAME = ".dev-dist";
const SOURCE_SUFFIXES = new Set([".ts", ".mts", ".cts"]);
const ASSET_SUFFIXES = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".sql",
  ".py",
  ".R",
  ".c",
  ".wasm",
  ".jsonl",
  ".txt",
  ".md",
]);

export type DevWorkerBuildOptions = {
  /** Directory that contains `src/` for the server package. */
  serverRoot: string;
  /** Directory that contains `src/` for `@pi-science/contracts`. */
  contractsRoot: string;
};

/** Entry point of the mirrored dev worker, or null when precompilation is unavailable. */
export function devWorkerEntry(options: DevWorkerBuildOptions): string | null {
  if (process.env.NODE_ENV === "test") return null;
  if (process.env.PI_SCIENCE_DEV_WORKER === "0") return null;
  const sourceRoot = join(options.serverRoot, "src");
  const sourceEntry = join(sourceRoot, "runtime", "agent", "worker", "main.ts");
  if (!existsSync(sourceEntry)) return null;
  const outputRoot = join(options.serverRoot, OUT_DIR_NAME);
  const outputEntry = join(outputRoot, "runtime", "agent", "worker", "main.js");
  if (
    existsSync(outputEntry) &&
    statSync(outputEntry).mtimeMs >= newestSourceMtime(sourceRoot, options.contractsRoot)
  )
    return outputEntry;
  try {
    buildWorkerMirror(sourceRoot, outputRoot);
    return existsSync(outputEntry) ? outputEntry : null;
  } catch {
    return null;
  }
}

/** Newest mtime across the mirrored JavaScript sources; 0 when nothing is readable. */
export function newestSourceMtime(serverSourceRoot: string, contractsRoot: string): number {
  let newest = 0;
  for (const root of [serverSourceRoot, join(contractsRoot, "src")]) {
    if (!existsSync(root)) continue;
    newest = Math.max(newest, walkNewest(root));
  }
  return newest;
}

function walkNewest(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, walkNewest(path));
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    const suffix = path.slice(path.lastIndexOf("."));
    if (!SOURCE_SUFFIXES.has(suffix) && !ASSET_SUFFIXES.has(suffix)) continue;
    newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/** Transpile `src/**` into `.dev-dist/**`, preserving every file's relative depth. */
export function buildWorkerMirror(serverSourceRoot: string, outputRoot: string): void {
  const require = createRequire(import.meta.url);
  const { buildSync } = require("esbuild") as typeof import("esbuild");
  const sources: string[] = [];
  const assets: string[] = [];
  collect(serverSourceRoot, serverSourceRoot, sources, assets);
  if (sources.length === 0) throw new Error("no TypeScript sources to precompile");
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  buildSync({
    entryPoints: sources,
    outdir: outputRoot,
    outbase: serverSourceRoot,
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node24",
    logLevel: "silent",
  });
  for (const asset of assets) {
    const destination = join(outputRoot, asset);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(serverSourceRoot, asset), destination);
  }
}

function collect(root: string, dir: string, sources: string[], assets: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(root, path, sources, assets);
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    const suffix = path.slice(path.lastIndexOf("."));
    const relative = path.slice(root.length + 1);
    if (SOURCE_SUFFIXES.has(suffix)) sources.push(path);
    else if (ASSET_SUFFIXES.has(suffix)) assets.push(relative);
  }
}

/** `pnpm --filter @pi-science/server build:dev-worker` — precompile before `pnpm dev`. */
export function buildDevWorker(options: DevWorkerBuildOptions): string {
  const sourceRoot = join(options.serverRoot, "src");
  const outputRoot = join(options.serverRoot, OUT_DIR_NAME);
  buildWorkerMirror(sourceRoot, outputRoot);
  return join(outputRoot, "runtime", "agent", "worker", "main.js");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  const serverRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const contractsRoot = fileURLToPath(
    new URL("../../../../../../packages/contracts/", import.meta.url),
  );
  const entry = buildDevWorker({ serverRoot, contractsRoot });
  process.stdout.write(`Precompiled dev worker: ${entry}\n`);
}
